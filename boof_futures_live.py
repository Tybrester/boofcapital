"""
Boof ORB + VWAP/Pullback Futures Live Bot
NQ + YM | TopstepX via REST API + SignalR WebSocket

Strategies:
  NQ ΓÇö ORB (9-bar OR) + TWAP Reclaim + PDH/PDL fallback + Bounce x2
    ORB:  SL=3pts TP=50pts | PF=1.83 backtested 2yr
    TWAP: cross signal, fires after ORB exits | PF=1.80 backtested 2yr
    Exit: Hard SL (intrabar poll) | Trail (bar close) | EOD 15:55 ET

  YM ΓÇö ORB (4-bar OR) + Pullback + Bounce x1 (MYM micro)
    ORB:  SL=10pts TP=60pts | PF=1.68 backtested 2yr
    PB:   First retest of OR level after ORB | PF=1.61
    Exit: Hard SL | TP | EOD 15:55 ET

Combined NQ+YM: $238,868 / 2yr on 5 micros | MaxDD -$9,012 | 22/25 months profitable

Setup:
  pip install httpx signalrcore
  Set env vars:
    PROJECT_X_USERNAME=your_topstepx_username
    PROJECT_X_API_KEY=your_api_key
"""

import asyncio
import os
import sys
import logging
import threading
import time
from datetime import datetime, time as dtime, timedelta
from zoneinfo import ZoneInfo
from dataclasses import dataclass
from typing import Optional

import json

import httpx
from signalrcore.hub_connection_builder import HubConnectionBuilder

# ΓöÇΓöÇ RUNTIME CONFIG (from dashboard) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
_SYMBOL_MAP = {"MNQ": "MNQU26", "NQ": "NQU26"}
_MV_MAP     = {"MNQ": 2, "NQ": 20}
_runtime_cfg = {}
_cfg_path = os.environ.get("BOT_RUNTIME_CONFIG_PATH", "")
if _cfg_path and os.path.isfile(_cfg_path):
    try:
        with open(_cfg_path) as _f:
            _runtime_cfg = json.load(_f)
            print(f"[ORB] Loaded runtime config: {_runtime_cfg}")
    except Exception as _e:
        print(f"[ORB] Could not read runtime config: {_e}")

# ΓöÇΓöÇ CONFIG ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

TZ = ZoneInfo("America/New_York")

API_URL      = "https://api.topstepx.com"
MARKET_HUB   = "wss://rtc.topstepx.com/hubs/market"

# If price is restored more than this far from the saved OR, consider the OR stale
# and rebuild it from live bars instead of waiting for a massive gap to close.
OR_SANITY_DISTANCE = 500.0

INSTRUMENTS = {
    "NQ": {
        "contract_id": None,        # filled at startup via /Contract/search
        "contract_name": _SYMBOL_MAP.get(_runtime_cfg.get("baseSymbol", ""), "MNQU26"),
        "mv": _MV_MAP.get(_runtime_cfg.get("baseSymbol", ""), 2),
        "or_bars": 3,
        "orb_max_bars_after": 1,   # allow 1 extra bar after OR for directional breakout
        "sl": 30.0,
        "tp": 30.0,
        "trail": 5.0,
        "trail_activate": 8.0,
        "trail_profit_floor": 0.0,
        "max_reclaims": 0,
        "max_bounces_per_side": 0,
        "max_daily_trades": 999,
        "immediate_orb": True,
        "cooldown_minutes": 8,
        "chop_high_thresh": 2,    # more aggressive chop filter
        "chop_low_thresh": 1,
        "chop_hours": 1,
        "size_ladder": False,
        "recovery_wins": 1,
        "daily_profit_trigger": 600.0,
        "daily_profit_floor": 500.0,
        "failed_orb_filter_dows": ["Friday"],
        "qty": _runtime_cfg.get("baseQty", 5),
        # Reduced size contract (used after loss streak)
        "reduced_contract_name": _SYMBOL_MAP.get(_runtime_cfg.get("lossSymbol", ""), "MNQU26"),
        "reduced_contract_id": None,
        "reduced_mv": _MV_MAP.get(_runtime_cfg.get("lossSymbol", ""), 2),
        "reduced_qty": _runtime_cfg.get("lossQty", 5),
    },
    "ES": {
        "contract_id": None,      # filled at startup via /Contract/search for "MES"
        "contract_name": "MES",   # Micro ES futures
        "mv": 5,                   # $5 per point for MES
        "or_bars": 3,
        "sl": 5.0,               # wider SL avoids wick stop-outs before VWAP reversion
        "trail": 2.0,            # user requested 2pt trail
        "trail_activate": 2.0,
        "qty": 1,
        "vwap_sigma": 1.0,         # entry band = VWAP +/- 1*std
        "vwap_max_trades": 2,
        "vwap_time_cutoff": "15:00",
    },
    # YM disabled ΓÇö no edge confirmed after correcting mv to $0.50/pt
    # "YM": {
    #     "contract_id": None,
    #     "contract_name": "MYM",
    #     "mv": 0.5,
    #     "or_bars": 4,
    #     "sl": 10.0,
    #     "trail": 5.0,
    #     "tp": 60.0,
    #     "qty": 5,
    # },
}

ORB_ENABLED = True   # Run first ORB only alongside bounces
MAX_ORB = 3
ENABLED_SYMBOLS = {"NQ"}
ORB_ONLY_MODE = os.environ.get("ORB_ONLY_MODE", "false").lower() in ("1", "true", "yes")

ATR_MULT = 0.7   # ATR(14) multiplier
ATR_PERIOD = 14
NQ_ATR_MAX_STOP = 30.0
NQ_FIXED_QTY = True
NQ_SIZE_DOWN_LOSSES = 2  # consecutive losses before reducing to reduced_qty
DAILY_LOSS_LIMIT = -1_000_000_000.0
FAILED_ORB_MAX_MOVE = 5.0   # max adverse excursion (pts) for failed-ORB detection
FAILED_ORB_FILTER_BAR_MINUTES = 15   # evaluate failed-ORB filter at this bar close

ENTRY_START  = dtime(9, 30)
ENTRY_CUTOFF = dtime(15, 30)
EOD_EXIT     = dtime(15, 55)
BAR_MINUTES  = 5
SL_POLL_SEC  = 2   # check SL every N seconds

_log_dir = os.environ.get("BOT_LOG_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs"))
os.makedirs(_log_dir, exist_ok=True)
_log_file = os.path.join(_log_dir, f"bot_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(_log_file, encoding="utf-8"),
    ]
)
log = logging.getLogger("BoofFutures")
log.info(f"Log file: {_log_file}")

# ΓöÇΓöÇ INSTRUMENT STATE ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

@dataclass
class InstrumentState:
    sym: str
    cfg: dict
    or_bars_collected: int = 0
    or_high: float = 0.0
    or_low: float = float("inf")
    or_complete: bool = False
    or_seeded: bool = False  # True if OR was seeded from session range (bot started late)
    or15_volume: float = 0.0  # cumulative traded volume during the OR window (first N min)
    or15_volume_ticks: int = 0  # count of trade ticks that carried a usable size/volume field
    bar_open: Optional[float] = None
    bar_high: float = 0.0
    bar_low: float = float("inf")
    bar_close: Optional[float] = None
    bar_num: int = -1
    bo_fired: int = 0   # counts OR breakouts fired today (limited by MAX_ORB)
    fade_fired: bool = False
    bounce_low_count: int = 0   # bounces off OR low taken today
    bounce_high_count: int = 0  # bounces off OR high taken today
    reclaim_count: int = 0
    # VWAP reclaim signal (NQ only)
    vwap_fired: bool = False
    vwap_sum: float = 0.0
    vol_sum: float = 0.0
    vol_history: list = None
    prev_bar_close: float = 0.0
    ema20: float = 0.0  # EMA-20 for NQ VWAP signal
    # First pullback signal (YM only)
    pb_or_broke: str = ""
    pb_fired: bool = False
    # TWAP signal (YM only)
    ym_twap_fired: bool = False
    ym_twap_sum: float = 0.0
    ym_twap_bars: int = 0
    ym_prev_bar_close: float = 0.0
    in_position: bool = False
    direction: str = ""
    entry_px: float = 0.0
    best_excursion: float = 0.0
    last_price: float = 0.0
    day: Optional[str] = None
    daily_trades: int = 0  # Track daily trade count
    max_daily_trades: int = 10  # High limit ΓÇö bounce counters control per-side limits
    daily_pnl: float = 0.0  # Estimated realized PnL today (for dynamic sizing)
    daily_profit_floor_armed: bool = False
    daily_profit_halted: bool = False
    # OR-based SL ΓÇö set at entry to OR low (long) or OR high (short)
    or_sl_price: float = 0.0
    atr_sl: float = 0.0          # ATR-based stop distance set at entry (0 = use fixed cfg[sl])
    last_trail_check: float = 0.0
    # Retest tracking ΓÇö price must return to OR level before re-entry allowed
    or_retested_low: bool = True   # True = price has touched OR_L since last short entry (or no entry yet)
    or_retested_high: bool = True  # True = price has touched OR_H since last long entry (or no entry yet)
    # Consecutive loss/win streak + size tier management
    consecutive_losses: int = 0
    consecutive_wins: int = 0
    size_tier: int = 0              # 0=1 NQ, 1=5 MNQ, 2=2 MNQ
    consec_wins_since_reduce: int = 0  # wins since last step-down
    consecutive_losing_days: int = 0
    weekly_pause_until: str = ""
    trade_type: str = ""               # BO_OR / BO_PREV / BOUNCE / VWAP / TWAP
    # OR boundary rejection chop detection
    or_high_rejections: int = 0        # times price touched OR_H then closed back inside
    or_low_rejections: int = 0         # times price touched OR_L then closed back inside
    or_chop_mode: bool = False          # True = too many rejections on both sides, skip ORB
    or_chop_mode_since: Optional[datetime] = None  # when chop mode activated
    orb_entry_taken: bool = False        # True once first ORB entry is taken (or window expires)
    orb_bars_since_complete: int = 0     # bars elapsed since OR completed
    pending_orb_direction: str = ""
    pending_orb_strategy: str = ""
    pending_orb_boundary: float = 0.0
    # Active contract info ΓÇö set at entry, used at exit (so exit matches entry contract)
    active_contract_id: Optional[int] = None
    active_qty: int = 1
    active_mv: float = 20.0
    active_account_qty: Optional[dict] = None
    entry_in_progress: bool = False
    exit_in_progress: bool = False
    next_exit_retry_at: float = 0.0  # time.time() gate ΓÇö prevents retry storms on every tick after a failed exit
    ladder_qty: int = 1
    cooldown_until: Optional[datetime] = None
    last_trade_pnl: float = 0.0
    # Failed-ORB filter: disable further ORB entries after a breakout reverses
    orb_disabled: bool = False          # True = no more ORB entries today
    failed_orb_pending: bool = False
    failed_orb_direction: str = ""
    failed_orb_entry: float = 0.0
    failed_orb_best: float = 0.0
    failed_orb_returned: bool = False
    # 15m bar tracking for failed-ORB filter evaluation
    orb_filter_bar_num: int = -1
    orb_filter_bar_open: float = 0.0
    orb_filter_bar_high: float = 0.0
    orb_filter_bar_low: float = 0.0
    orb_filter_bar_close: float = 0.0
    # Previous day levels for multi-level entries
    prev_high: float = 0.0
    prev_low: float = 0.0
    prev2_high: float = 0.0
    prev2_low: float = 0.0
    prev3_high: float = 0.0
    prev3_low: float = 0.0
    # Full prior-day range (for ES VWAP reversion regime detection)
    prev_day_high: float = 0.0
    prev_day_low: float = 0.0
    day_high: float = 0.0
    day_low: float = float("inf")
    # VWAP state (ES reversion signal)
    vwap_sum: float = 0.0
    vwap_vol_sum: float = 0.0
    vwap_sq_dev_sum: float = 0.0
    vwap_bars: int = 0
    vwap: float = 0.0
    vwap_std: float = 0.0
    vwap_prev_close: float = 0.0
    vwap_entry_target: float = 0.0
    vwap_last_entry_bar: int = -99
    rth_open: float = 0.0

    def __post_init__(self):
        if self.vol_history is None:
            self.vol_history = []
        if self.active_account_qty is None:
            self.active_account_qty = {}
        self.max_daily_trades = self.cfg.get("max_daily_trades", self.max_daily_trades)
        self.ladder_qty = self.cfg.get("qty", self.ladder_qty)

    def reset_day(self):
        self.or_bars_collected = 0
        self.or_high = 0.0
        self.or_low = float("inf")
        self.or_complete = False
        self.day_high = 0.0
        self.day_low = float("inf")
        self.or_seeded = False
        self.or15_volume = 0.0
        self.or15_volume_ticks = 0
        self.next_exit_retry_at = 0.0
        self.bar_open = None
        self.bar_high = 0.0
        self.bar_low = float("inf")
        self.bar_close = None
        self.bar_num = -1
        self.bo_fired = 0
        self.fade_fired = False
        self.or_retested_low = True
        self.or_retested_high = True
        self.or_high_rejections = 0
        self.or_low_rejections = 0
        self.or_chop_mode = False
        self.or_chop_mode_since = None
        self.orb_entry_taken = False
        self.orb_bars_since_complete = 0
        self.pending_orb_direction = ""
        self.pending_orb_strategy = ""
        self.pending_orb_boundary = 0.0
        self.bounce_low_count = 0
        self.bounce_high_count = 0
        self.reclaim_count = 0
        self.vwap_fired = False
        self.vwap_sum = 0.0
        self.vwap_vol_sum = 0.0
        self.vwap_sq_dev_sum = 0.0
        self.vwap_bars = 0
        self.vwap = 0.0
        self.vwap_std = 0.0
        self.vwap_prev_close = 0.0
        self.vwap_entry_target = 0.0
        self.vwap_last_entry_bar = -99
        self.rth_open = 0.0
        self.vol_sum = 0.0
        self.vol_history = []
        self.prev_bar_close = 0.0
        self.ema20 = 0.0
        self.pb_or_broke = ""
        self.pb_fired = False
        self.ym_twap_fired = False
        self.ym_twap_sum = 0.0
        self.ym_twap_bars = 0
        self.ym_prev_bar_close = 0.0
        self.in_position = False
        self.direction = ""
        self.entry_px = 0.0
        self.best_excursion = 0.0
        self.daily_trades = 0  # Reset daily trade count
        self.daily_pnl = 0.0
        self._trail_logged = False
        self.daily_profit_floor_armed = False
        self.daily_profit_halted = False
        self.consecutive_losses = 0
        self.consecutive_wins = 0
        self.size_tier = 0
        self.consec_wins_since_reduce = 0
        self.or_sl_price = 0.0
        self.last_trail_check = 0.0
        self._flip_pending_dir = None
        self._flip_confirm_count = 0
        self.active_account_qty = {}
        self.entry_in_progress = False
        self.exit_in_progress = False
        self.last_trade_pnl = 0.0
        self.orb_disabled = False
        self.failed_orb_pending = False
        self.failed_orb_direction = ""
        self.failed_orb_entry = 0.0
        self.failed_orb_best = 0.0
        self.failed_orb_returned = False
        self.orb_filter_bar_num = -1
        self.orb_filter_bar_open = 0.0
        self.orb_filter_bar_high = 0.0
        self.orb_filter_bar_low = 0.0
        self.orb_filter_bar_close = 0.0
        # Don't reset previous day levels - they persist for next day

# ΓöÇΓöÇ API CLIENT ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

class TopstepClient:
    def __init__(self, username: str, api_key: str):
        self.username = username
        self.api_key  = api_key
        self.jwt_token: Optional[str] = None
        self.account_id: Optional[int] = None
        self.http = httpx.Client(timeout=10)

    def authenticate(self):
        resp = self.http.post(f"{API_URL}/api/Auth/loginKey", json={
            "userName": self.username,
            "apiKey":   self.api_key,
        })
        resp.raise_for_status()
        data = resp.json()
        if not data.get("success", False):
            error_code = data.get("errorCode", "unknown")
            error_msg = data.get("errorMessage", "No error message")
            raise ValueError(f"Authentication failed: {error_msg} (code: {error_code})")
        
        token = data.get("token")
        if not token:
            raise ValueError("Authentication succeeded but no token received")
            
        self.jwt_token = token
        log.info("Authenticated with TopstepX")

    def _headers(self):
        return {
            "Authorization": f"Bearer {self.jwt_token}",
            "Content-Type": "application/json"
        }

    def get_accounts(self):
        resp = self.http.post(f"{API_URL}/api/Account/search", headers=self._headers(),
                             json={"onlyActiveAccounts": True})
        resp.raise_for_status()
        return resp.json()["accounts"]

    def search_contract(self, name: str):
        resp = self.http.post(f"{API_URL}/api/Contract/search", headers=self._headers(),
                             json={"searchText": name, "live": False})
        resp.raise_for_status()
        contracts = resp.json()["contracts"]
        if not contracts:
            raise ValueError(f"No contract found for: {name}")
        return contracts[0]  # first match

    def place_market_order(self, account_id: int, contract_id: int, side: int, qty: int):
        # side: 0=Buy, 1=Sell
        resp = self.http.post(f"{API_URL}/api/Order/place", headers=self._headers(), json={
            "accountId":  account_id,
            "contractId": contract_id,
            "type":       2,   # 2 = Market
            "side":       side,
            "size":       qty,
        })
        resp.raise_for_status()
        return resp.json()

    def place_limit_order(self, account_id: int, contract_id: int, side: int, qty: int, limit_px: float):
        # side: 0=Buy, 1=Sell
        resp = self.http.post(f"{API_URL}/api/Order/place", headers=self._headers(), json={
            "accountId":  account_id,
            "contractId": contract_id,
            "type":       1,   # 1 = Limit
            "side":       side,
            "size":       qty,
            "limitPrice": limit_px,
        })
        resp.raise_for_status()
        return resp.json()

    def get_positions(self, account_id: int):
        resp = self.http.post(f"{API_URL}/api/Position/search", headers=self._headers(),
                             json={"accountId": account_id})
        if resp.status_code == 404:
            return []  # 404 = no positions (normal TopstepX behavior)
        resp.raise_for_status()
        return resp.json().get("positions", [])

    def get_history(self, contract_id: str, units_back: int = 20) -> list:
        """Fetch recent 5-min bars using TopstepX History API"""
        try:
            now_utc = datetime.now(ZoneInfo("UTC"))
            # Go back far enough to cover pre-market + full OR window
            start_utc = now_utc - timedelta(hours=4)
            resp = self.http.post(f"{API_URL}/api/History/retrieveBars", headers=self._headers(), json={
                "contractId": contract_id,
                "live": False,
                "startTime": start_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "endTime":   now_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "unit": 3,
                "unitNumber": 5,
                "limit": units_back,
                "includePartialBar": True,
            }, timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                bars = data.get("bars") or []
                if not bars:
                    log.warning(f"get_history raw response keys: {list(data.keys())} | sample: {str(data)[:300]}")
                return bars
        except Exception as e:
            log.warning(f"get_history failed: {e}")
        return []

    def get_history_1m(self, contract_id: str, units_back: int = 30) -> list:
        """Fetch recent 1-min bars for ATR calculation"""
        try:
            now_utc = datetime.now(ZoneInfo("UTC"))
            start_utc = now_utc - timedelta(hours=2)
            resp = self.http.post(f"{API_URL}/api/History/retrieveBars", headers=self._headers(), json={
                "contractId": contract_id,
                "live": False,
                "startTime": start_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "endTime":   now_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "unit": 3,
                "unitNumber": 1,
                "limit": units_back,
                "includePartialBar": False,
            }, timeout=10)
            if resp.status_code == 200:
                return resp.json().get("bars") or []
        except Exception as e:
            log.warning(f"get_history_1m failed: {e}")
        return []

    def get_quote(self, contract_id: str) -> Optional[float]:
        """Poll last price via REST ΓÇö no WebSocket needed"""
        try:
            resp = self.http.post(f"{API_URL}/api/Quote/search", headers=self._headers(),
                                 json={"contractId": contract_id}, timeout=3)
            if resp.status_code == 200:
                data = resp.json()
                quotes = data.get("quotes") or data.get("items") or []
                if quotes:
                    q = quotes[0]
                    return float(q.get("lastPrice") or q.get("last") or q.get("price") or 0) or None
        except Exception:
            pass
        return None

# ΓöÇΓöÇ MAIN BOT ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

class BoofBot:
    def __init__(self, client: Optional[TopstepClient] = None, hub=None, combined_mode: bool = False):
        # Get credentials from command-line args (key, username) or environment variables
        if client is not None:
            self.client = client
            self.username = getattr(client, "username", "")
            self.api_key = getattr(client, "api_key", "")
        else:
            if len(sys.argv) >= 3:
                self.api_key  = sys.argv[1]
                self.username = sys.argv[2]
            else:
                self.username = os.environ.get("PROJECT_X_USERNAME", "")
                self.api_key  = os.environ.get("PROJECT_X_API_KEY", "")
            
            if not self.username or not self.api_key:
                raise ValueError("Missing credentials: pass as arguments (api_key username) or set PROJECT_X_USERNAME and PROJECT_X_API_KEY environment variables")
            
            print(f"Γ£à Using credentials - Username: {self.username}")
            self.client = TopstepClient(self.username, self.api_key)
        self.states   = {sym: InstrumentState(sym=sym, cfg=dict(cfg))
                         for sym, cfg in INSTRUMENTS.items() if sym in ENABLED_SYMBOLS}
        self.account_id: Optional[int] = None
        self.account_ids: list = []  # all accounts to trade
        self._poll_active = False
        self._hub = hub  # may be shared with fade bot
        self._combined_mode = combined_mode
        self._ws_closed = False
        self._last_quote_time: float = 0.0  # epoch seconds of last received quote
        self._last_reconnect_at: float = 0.0  # throttle reconnect attempts
        self._external_can_enter = lambda direction: True  # overridden by combined runner
        # Dynamic position sizing
        self.dynamic_qty: int = 1   # base qty ΓÇö per-instrument cfg["qty"] is used directly
        self.win_streak:  int = 0
        self.loss_streak: int = 0
        self._sizing_trigger: int = 3  # consecutive days to trigger size change
        self._min_qty: int = 3
        self._max_qty: int = 8
        self.daily_halt_day: Optional[str] = None

    def setup(self):
        """Authenticate, resolve account and contract IDs"""
        if not getattr(self.client, "jwt_token", None):
            self.client.authenticate()

        accounts = self.client.get_accounts()
        if not accounts:
            raise RuntimeError("No active accounts found")

        # Optional explicit allowlist ΓÇö set TRADE_ACCOUNT_IDS="123,456,789" to restrict
        # trading to specific accounts even if TopstepX's API still reports others as active
        # (e.g. a blown/closed account that hasn't been marked inactive yet). Takes priority
        # over ACCOUNT_NAME_FILTER below if both are set.
        allowlist_raw = os.environ.get("TRADE_ACCOUNT_IDS", "").strip()
        if allowlist_raw:
            allowlist = {int(x.strip()) for x in allowlist_raw.split(",") if x.strip()}
            api_ids = {a["id"] for a in accounts}
            missing = allowlist - api_ids
            if missing:
                log.warning(f"TRADE_ACCOUNT_IDS includes account(s) not returned by the API (skipping): {sorted(missing)}")
            excluded = api_ids - allowlist
            if excluded:
                log.warning(f"Excluding account(s) not in TRADE_ACCOUNT_IDS allowlist: {sorted(excluded)}")
            accounts = [a for a in accounts if a["id"] in allowlist]
            if not accounts:
                raise RuntimeError("TRADE_ACCOUNT_IDS allowlist matched zero accounts from the API")
        else:
            # Filter by account name prefix ΓÇö default "EXPRESS" so evaluation/funded (TC) accounts
            # are never traded even though the API reports them as active. This is more robust than
            # a hardcoded ID list since eval accounts get recycled with new IDs on reset.
            # Set ACCOUNT_NAME_FILTER="" to disable and trade every active account.
            name_filter = os.environ.get("ACCOUNT_NAME_FILTER", "EXPRESS").strip().upper()
            if name_filter:
                matched = [a for a in accounts if name_filter in a.get("name", "").upper()]
                excluded = [a for a in accounts if a not in matched]
                if excluded:
                    log.warning(f"Excluding non-{name_filter} account(s): {sorted(a['id'] for a in excluded)}")
                if not matched:
                    raise RuntimeError(f"No accounts matched ACCOUNT_NAME_FILTER={name_filter!r}")
                accounts = matched

        include_raw = os.environ.get("INCLUDE_ACCOUNT_IDS", "").strip()
        if include_raw:
            include_ids = {int(x.strip()) for x in include_raw.split(",") if x.strip()}
            accounts = [a for a in accounts if a["id"] in include_ids or (name_filter and name_filter in a.get("name", "").upper())]

        exclude_raw = os.environ.get("EXCLUDE_ACCOUNT_IDS", "").strip()
        if exclude_raw:
            exclude_ids = {int(x.strip()) for x in exclude_raw.split(",") if x.strip()}
            accounts = [a for a in accounts if a["id"] not in exclude_ids]
        if not accounts:
            raise RuntimeError("All accounts were excluded")

        self.account_ids = [a["id"] for a in accounts]
        self.account_id  = self.account_ids[0]  # primary for position checks
        for account in accounts:
            log.info(f"Trading account: {account['name']} (id={account['id']})")
            balance = account.get('balance')
            log.info(f"  Balance: ${balance:,.2f}" if balance else "  Balance: N/A")

        for sym, state in self.states.items():
            name = state.cfg["contract_name"]
            contract = self.client.search_contract(name)
            state.cfg["contract_id"] = contract["id"]
            log.info(f"{sym}: contract={name} id={contract['id']}")
            if state.cfg.get("reduced_contract_name"):
                reduced = self.client.search_contract(state.cfg["reduced_contract_name"])
                state.cfg["reduced_contract_id"] = reduced["id"]
                log.info(f"{sym}: reduced contract={state.cfg['reduced_contract_name']} id={reduced['id']}")
        
        # Restore OR levels from last session if restarted today
        self._restore_or_levels()
        # Seed OR from historical bars if bot started after OR window
        self._seed_or_from_history()
        # Check for existing positions and recover state
        self._recover_positions()

        # Startup state summary
        for sym, state in self.states.items():
            or_status = f"H={state.or_high:.2f} L={state.or_low:.2f}" if state.or_complete else "not built"
            pos = f"IN {state.direction.upper()} {state.active_qty} @ {state.entry_px:.2f}" if state.in_position else "flat"
            log.info(f"[STARTUP] {sym}: OR[{or_status}] | pos={pos} | dayPnL=${state.daily_pnl:+.0f} | size_tier={state.size_tier} | OR15_vol={state.or15_volume:.0f}")

    def _save_or_levels(self, state: InstrumentState):
        """Save OR levels and signal flags to disk so they survive bot restarts"""
        if not state.or_complete:
            return  # never save stale/unbuilt OR ΓÇö prevents yesterday's levels getting today's date
        import json
        user_tag = self.username.split("@")[0]
        path = os.path.join(os.path.dirname(__file__), f"or_levels_{state.sym}_{user_tag}.json")
        data = {
            "date": str(datetime.now(TZ).date()),
            "or_high": state.or_high, "or_low": state.or_low,
            "or15_volume": state.or15_volume,
            "bo_fired": state.bo_fired, "fade_fired": state.fade_fired,
            "orb_entry_taken": getattr(state, "orb_entry_taken", False),
            "pending_orb_direction": state.pending_orb_direction,
            "pending_orb_strategy": state.pending_orb_strategy,
            "pending_orb_boundary": state.pending_orb_boundary,
            "vwap_fired": getattr(state, "vwap_fired", False),
            "ym_twap_fired": getattr(state, "ym_twap_fired", False),
            "vwap_last_entry_bar": getattr(state, "vwap_last_entry_bar", -99),
            "daily_trades": state.daily_trades,
            "daily_pnl": state.daily_pnl,
            "daily_profit_floor_armed": state.daily_profit_floor_armed,
            "daily_profit_halted": state.daily_profit_halted,
            "prev_high": state.prev_high,
            "prev_low": state.prev_low,
            "prev_day_high": getattr(state, "prev_day_high", 0.0),
            "prev_day_low": getattr(state, "prev_day_low", 0.0),
            "bounce_low_count": state.bounce_low_count,
            "bounce_high_count": state.bounce_high_count,
            "reclaim_count": state.reclaim_count,
            "consecutive_losses": state.consecutive_losses,
            "consecutive_wins": state.consecutive_wins,
            "size_tier": state.size_tier,
            "consec_wins_since_reduce": state.consec_wins_since_reduce,
            "consecutive_losing_days": state.consecutive_losing_days,
            "weekly_pause_until": state.weekly_pause_until,
            "daily_halt_day": self.daily_halt_day,
            "cooldown_until": state.cooldown_until.isoformat() if state.cooldown_until else None,
            "orb_disabled": state.orb_disabled,
            "failed_orb_pending": state.failed_orb_pending,
            "failed_orb_direction": state.failed_orb_direction,
            "failed_orb_entry": state.failed_orb_entry,
            "failed_orb_best": state.failed_orb_best,
            "failed_orb_returned": state.failed_orb_returned,
            "orb_filter_bar_num": state.orb_filter_bar_num,
            "orb_filter_bar_open": state.orb_filter_bar_open,
            "orb_filter_bar_high": state.orb_filter_bar_high,
            "orb_filter_bar_low": state.orb_filter_bar_low,
            "orb_filter_bar_close": state.orb_filter_bar_close,
        }
        with open(path, "w") as f: json.dump(data, f)

    def _restore_or_levels(self):
        """Reload OR levels from today's log files ΓÇö parse 'OR complete' lines"""
        import re, glob, json
        today = str(datetime.now(TZ).date())
        log_dir = os.environ.get("BOT_LOG_DIR", os.path.join(os.path.dirname(__file__), "logs"))
        # also try JSON file first (fastest)
        user_tag = self.username.split("@")[0]
        for sym, state in self.states.items():
            json_path = os.path.join(os.path.dirname(__file__), f"or_levels_{sym}_{user_tag}.json")
            try:
                if os.path.exists(json_path):
                    with open(json_path) as f: data = json.load(f)
                    # Only carry multi-day counters from a stale file; today's session
                    # state (PnL, cooldown, profit floor, size tier, etc.) must come from
                    # a file whose date matches today.
                    state.consecutive_losing_days = int(data.get("consecutive_losing_days", 0))
                    state.weekly_pause_until = str(data.get("weekly_pause_until", ""))
                    restored_halt = data.get("daily_halt_day")
                    if restored_halt == today:
                        self.daily_halt_day = restored_halt
                    if data.get("date") == today:
                        # Same-day restart: restore the full session state
                        state.consecutive_losses = int(data.get("consecutive_losses", 0))
                        state.consecutive_wins = int(data.get("consecutive_wins", 0))
                        state.size_tier = int(data.get("size_tier", 0))
                        # Ensure size tier is consistent if a loss streak was saved before threshold was applied
                        if state.sym == "NQ" and not NQ_FIXED_QTY and state.consecutive_losses >= NQ_SIZE_DOWN_LOSSES:
                            state.size_tier = 1
                            state.consecutive_losses = 0
                        state.consec_wins_since_reduce = int(data.get("consec_wins_since_reduce", 0))
                        state.day = today
                        state.daily_pnl = float(data.get("daily_pnl", 0.0))
                        state.daily_profit_floor_armed = bool(data.get("daily_profit_floor_armed", False))
                        state.daily_profit_halted = bool(data.get("daily_profit_halted", False))
                        cd_iso = data.get("cooldown_until")
                        if cd_iso:
                            try:
                                from datetime import datetime as _dt
                                state.cooldown_until = _dt.fromisoformat(cd_iso)
                                if state.cooldown_until.tzinfo is None:
                                    state.cooldown_until = state.cooldown_until.replace(tzinfo=TZ)
                            except Exception:
                                state.cooldown_until = None
                        restored_h = float(data["or_high"])
                        restored_l = float(data["or_low"])
                        state.or_high = restored_h
                        state.or_low  = restored_l
                        state.or15_volume = float(data.get("or15_volume", 0.0))
                        state.or_complete = True
                        state.or_seeded = False
                        state.or_bars_collected = state.cfg["or_bars"]
                        state.bo_fired   = int(data.get("bo_fired", 0))
                        state.fade_fired = bool(data.get("fade_fired", False))
                        state.orb_entry_taken = bool(data.get("orb_entry_taken", state.bo_fired > 0))
                        state.pending_orb_direction = str(data.get("pending_orb_direction", ""))
                        state.pending_orb_strategy = str(data.get("pending_orb_strategy", ""))
                        state.pending_orb_boundary = float(data.get("pending_orb_boundary", 0.0))
                        if hasattr(state, "vwap_fired"):    state.vwap_fired    = bool(data.get("vwap_fired", False))
                        if hasattr(state, "ym_twap_fired"): state.ym_twap_fired = bool(data.get("ym_twap_fired", False))
                        if hasattr(state, "vwap_last_entry_bar"): state.vwap_last_entry_bar = int(data.get("vwap_last_entry_bar", -99))
                        state.daily_trades = int(data.get("daily_trades", 0))
                        state.prev_high = float(data.get("prev_high", 0.0))
                        state.prev_low = float(data.get("prev_low", 0.0))
                        if hasattr(state, "prev_day_high"): state.prev_day_high = float(data.get("prev_day_high", 0.0))
                        if hasattr(state, "prev_day_low"):  state.prev_day_low  = float(data.get("prev_day_low", 0.0))
                        state.bounce_low_count  = int(data.get("bounce_low_count", 0))
                        state.bounce_high_count = int(data.get("bounce_high_count", 0))
                        state.reclaim_count = int(data.get("reclaim_count", 0))
                        if hasattr(state, "orb_disabled"):
                            state.orb_disabled = bool(data.get("orb_disabled", False))
                            state.failed_orb_pending = bool(data.get("failed_orb_pending", False))
                            state.failed_orb_direction = str(data.get("failed_orb_direction", ""))
                            state.failed_orb_entry = float(data.get("failed_orb_entry", 0.0))
                            state.failed_orb_best = float(data.get("failed_orb_best", 0.0))
                            state.failed_orb_returned = bool(data.get("failed_orb_returned", False))
                            state.orb_filter_bar_num = int(data.get("orb_filter_bar_num", -1))
                            state.orb_filter_bar_open = float(data.get("orb_filter_bar_open", 0.0))
                            state.orb_filter_bar_high = float(data.get("orb_filter_bar_high", 0.0))
                            state.orb_filter_bar_low = float(data.get("orb_filter_bar_low", 0.0))
                            state.orb_filter_bar_close = float(data.get("orb_filter_bar_close", 0.0))
                            if state.orb_disabled:
                                log.warning(f"{sym} FAILED ORB state restored ΓÇö ORB remains disabled for rest of day")
                        log.info(f"{sym} OR restored from JSON: H={state.or_high:.2f} L={state.or_low:.2f} bo_fired={state.bo_fired}")
                        continue
            except Exception:
                pass
            # Do NOT scan log files for OR levels: log files may contain old
            # backtest/simulation OR complete lines and will load a wildly stale
            # range. Rely on the JSON state file (if it is from today) or rebuild
            # the OR from live bars / history seeding.

    def _seed_vwap_from_history(self, state: InstrumentState, session_bars: list):
        """Seed ES VWAP and rth_open from historical bars after startup."""
        if state.sym != "ES" or not session_bars:
            return
        # Sort by timestamp ascending
        session_bars.sort(key=lambda x: x[0])
        for idx, (bt, b) in enumerate(session_bars):
            h = float(b.get("h") or b.get("high") or 0)
            l = float(b.get("l") or b.get("low") or 0)
            c = float(b.get("c") or b.get("close") or 0)
            if h == 0 or l == 0 or c == 0:
                continue
            if idx == 0:
                state.rth_open = c
            state.day_high = max(state.day_high, h)
            state.day_low = min(state.day_low, l)
            tp = (h + l + c) / 3.0
            vol = 1.0
            old_vwap = state.vwap
            state.vwap_sum += tp * vol
            state.vwap_vol_sum += vol
            state.vwap_bars += 1
            if state.vwap_vol_sum > 0:
                new_vwap = state.vwap_sum / state.vwap_vol_sum
                state.vwap = new_vwap
                # Welford's online variance for numerically stable population variance
                state.vwap_sq_dev_sum += (tp - old_vwap) * (tp - new_vwap)
                var = state.vwap_sq_dev_sum / state.vwap_vol_sum
                state.vwap_std = var ** 0.5
        log.info(f"ES VWAP seeded from history: bars={state.vwap_bars} vwap={state.vwap:.2f} std={state.vwap_std:.2f} open={state.rth_open:.2f}")

    def _seed_or_from_history(self):
        """Fetch today's bars on startup and seed OR levels if we started after the OR window"""
        now = datetime.now(TZ)
        for sym, state in self.states.items():
            or_bars = state.cfg["or_bars"]
            or_end_mins = 9 * 60 + 30 + or_bars * 5
            or_end_time = dtime(or_end_mins // 60, or_end_mins % 60)
            if now.time() < dtime(9, 30):
                continue  # before open, nothing to seed
            if sym != "ES" and state.or_complete and not state.or_seeded:
                continue  # already restored from file ΓÇö skip history fetch
            try:
                # Prefer MNQ for history (full NQ may not return bars via TopstepX history API)
                history_cid = state.cfg.get("reduced_contract_id") or state.cfg["contract_id"]
                bars = self.client.get_history(history_cid, units_back=or_bars+30)
                if not bars:
                    log.warning(f"{sym} no history bars returned ΓÇö OR will build from live feed")
                    continue
                # filter to today's session 9:30 onward
                session_bars = []
                if bars:
                    log.info(f"{sym} history: {len(bars)} bars, first={bars[0]}, last={bars[-1]}")
                for b in bars:
                    ts = b.get("t") or b.get("timestamp") or b.get("time") or b.get("ts") or ""
                    try:
                        bt = datetime.fromisoformat(str(ts).replace("Z", "+00:00")).astimezone(TZ)
                        if bt.date() == now.date():
                            session_bars.append((bt, b))
                    except Exception:
                        continue
                session_bars.sort(key=lambda x: x[0])
                if not session_bars:
                    log.warning(f"{sym} no today session bars in history")
                    continue
                # Seed ES VWAP from all available history bars
                if sym == "ES":
                    self._seed_vwap_from_history(state, session_bars)
                # seed OR from first or_bars bars
                or_hi = 0.0; or_lo = float("inf")
                for idx, (bt, b) in enumerate(session_bars[:or_bars]):
                    h = float(b.get("h") or b.get("high") or 0)
                    l = float(b.get("l") or b.get("low") or 0)
                    if h > or_hi: or_hi = h
                    if l < or_lo: or_lo = l
                if or_hi > 0 and or_lo < float("inf"):
                    state.or_high = or_hi
                    state.or_low  = or_lo
                    state.or_bars_collected = min(len(session_bars), or_bars)
                    state.or_complete = True
                    # Mark as seeded (inaccurate large bars) ΓÇö blocks trading today
                    state.or_seeded = True
                    log.warning(f"{sym} OR seeded from history (large bars ΓÇö trades blocked today): H={or_hi:.2f} L={or_lo:.2f} ({state.or_bars_collected} bars)")
            except Exception as e:
                log.warning(f"{sym} OR seed failed: {e} ΓÇö will build from live feed")

    def _recover_positions(self):
        """Check for existing positions and recover state if bot restarted"""
        for account_id in self.account_ids:
            try:
                positions = self.client.get_positions(account_id)
                for pos in positions:
                    contract_id = pos.get("contractId")
                    for sym, state in self.states.items():
                        valid_ids = {state.cfg.get("contract_id"), state.cfg.get("reduced_contract_id")}
                        if contract_id not in valid_ids:
                            continue
                        direction = "long" if pos.get("side") == 0 else "short"
                        entry_px = float(pos.get("avgPrice", 0))
                        qty = abs(int(pos.get("size") or pos.get("quantity") or pos.get("netPosition") or state.cfg["qty"]))
                        if state.in_position and state.direction != direction:
                            log.critical(f"{sym} position mismatch across accounts ΓÇö account {account_id} is {direction}, expected {state.direction}")
                            continue
                        state.in_position = True
                        state.direction = direction
                        if state.entry_px == 0.0:
                            state.entry_px = entry_px
                        state.best_excursion = state.entry_px
                        state.active_contract_id = contract_id
                        state.active_qty = qty
                        state.active_mv = state.cfg["reduced_mv"] if qty == state.cfg.get("reduced_qty") else state.cfg["mv"]
                        state.active_account_qty[account_id] = qty
                        log.info(f"Recovered {sym} {direction.upper()} {qty} contract(s) @ {entry_px:.2f} on account {account_id}")
                        break
            except Exception as e:
                log.warning(f"Failed to recover positions for account {account_id}: {e}")

    def _account_position_for_contract(self, account_id: int, contract_id) -> int:
        """Return signed net position for a given account/contract (positive=long, negative=short)."""
        if not contract_id:
            return 0
        try:
            positions = self.client.get_positions(account_id)
        except Exception as e:
            log.warning(f"Position check failed for account {account_id}: {e}")
            return 0
        net = 0
        for p in positions:
            pid = p.get("contractId") or p.get("contract_id")
            if pid != contract_id:
                continue
            qty = int(p.get("size") or p.get("quantity") or p.get("netPosition") or p.get("qty") or 0)
            side = str(p.get("side", "")).lower()
            if side in ("buy", "long", "0"):
                net += qty
            elif side in ("sell", "short", "1"):
                net -= qty
            else:
                net += qty  # assume netPosition already signed
        return net

    def _all_accounts_flat(self, contract_id) -> bool:
        for account_id in self.account_ids:
            if self._account_position_for_contract(account_id, contract_id) != 0:
                return False
        return True

    def _aggregate_position_for_contract(self, contract_id) -> int:
        return sum(self._account_position_for_contract(a, contract_id) for a in self.account_ids)

    def start_market_feed(self):
        """Connect SignalR WebSocket for real-time quotes"""
        if self._combined_mode:
            return  # shared hub managed by combined runner

        if self._hub:
            try: self._hub.stop()
            except: pass
            self._hub = None

        hub_url = f"{MARKET_HUB}?access_token={self.client.jwt_token}"
        self._hub = HubConnectionBuilder().with_url(hub_url).build()

        self._setup_hub_callbacks(self._hub)
        self._hub.start()
        time.sleep(2)
        self._subscribe_contracts(self._hub)

    def _setup_hub_callbacks(self, hub):
        """Attach callbacks to a hub (used for shared hub in combined mode)"""
        hub.on("GatewayQuote", self._on_quote)
        hub.on("GatewayTrade", self._on_quote)
        hub.on("GatewayLogout", self._on_logout)
        hub.on_close(self._on_ws_close)

    def _subscribe_contracts(self, hub):
        """Subscribe to contract quotes and trades on the given hub"""
        for sym, state in self.states.items():
            cid = state.cfg["contract_id"]
            parts = cid.split('.')
            state.cfg["symbol_id"] = '.'.join(parts[1:-1]) if len(parts) >= 4 else cid
            try:
                hub.send("SubscribeContractQuotes", [cid])
                hub.send("SubscribeContractTrades", [cid])
                log.info(f"Subscribed (send): {sym} {cid}")
            except Exception as e:
                log.warning(f"send failed ({e}), trying invoke")
                try:
                    hub.send("SubscribeContractQuotes", [cid])
                    hub.send("SubscribeContractTrades", [cid])
                except: pass

    def _on_ws_close(self):
        log.warning("WS disconnected ΓÇö scheduling reconnect")
        self._ws_closed = True

    def _on_logout(self, data):
        log.warning(f"GatewayLogout: {data}")
        self._ws_closed = True

    def _on_quote(self, data):
        try:
            # TopstepX sends: ['CON.F.US.MNQ.U26', {quote dict}]
            if isinstance(data, list) and len(data) >= 2 and isinstance(data[1], dict):
                contract_id = data[0]
                quote = data[1]
            elif isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict):
                quote = data[0]
                contract_id = quote.get("contractId")
            elif isinstance(data, dict):
                quote = data
                contract_id = quote.get("contractId")
            else:
                return

            last = quote.get("lastPrice") or quote.get("last") or quote.get("price")
            if not last:
                return
            last = float(last)
            self._last_quote_time = time.time()

            # GatewayTrade payloads carry a `type` (Buy/Sell) field and a per-trade `volume`.
            # GatewayQuote payloads have no `type` field and their `volume` is the CUMULATIVE
            # session total (not incremental) ΓÇö only accumulate from actual trade ticks.
            is_trade_tick = "type" in quote
            trade_size = quote.get("volume") if is_trade_tick else None

            state = self._get_state_by_id(contract_id)
            if state is None:
                sym_id = quote.get("symbol")
                for s in self.states.values():
                    if s.cfg.get("symbol_id") == sym_id:
                        state = s
                        break
            if state is None:
                return

            if not state.cfg.get("ticks_received"):
                state.cfg["ticks_received"] = True
                log.info(f"[LIVE] {state.sym} first tick: px={last:.2f} or_complete={state.or_complete}")
                if state.or_complete:
                    # Sanity-check restored OR vs current price. Stale log/backtest
                    # state can produce a range thousands of points away from price.
                    if state.or_high > 0 and (last < state.or_low - OR_SANITY_DISTANCE or
                                              last > state.or_high + OR_SANITY_DISTANCE):
                        log.warning(f"[LIVE] {state.sym} OR sanity fail: px={last:.2f} vs restored OR[{state.or_high:.2f}/{state.or_low:.2f}] "
                                    f"({abs(last - (state.or_high if last > state.or_high else state.or_low)):.0f}pt away) ΓÇö clearing OR to rebuild from live bars")
                        state.or_high = 0.0
                        state.or_low = float("inf")
                        state.or_complete = False
                        state.or_seeded = False
                        state.or_bars_collected = 0
                        state.or15_volume = 0.0
                        state.or15_volume_ticks = 0
                    elif last < state.or_low:
                        state.or_retested_low = False
                        log.info(f"[LIVE] {state.sym} started {state.or_low - last:.0f}pt below OR_L ΓÇö waiting for price to close back above OR_L before next short")
                    elif last > state.or_high:
                        state.or_retested_high = False
                        log.info(f"[LIVE] {state.sym} started {last - state.or_high:.0f}pt above OR_H ΓÇö waiting for price to close back below OR_H before next long")
            previous_price = state.last_price
            state.last_price = last
            if not state.or_complete and trade_size:
                try:
                    state.or15_volume += float(trade_size)
                    state.or15_volume_ticks += 1
                except (TypeError, ValueError):
                    pass
            if self._check_daily_profit_floor(state):
                return
            if state.in_position:
                if state.direction == "long" and last > state.best_excursion:
                    state.best_excursion = last
                elif state.direction == "short" and state.best_excursion > 0 and last < state.best_excursion:
                    state.best_excursion = last
                if state.failed_orb_pending:
                    if state.failed_orb_direction == "long":
                        state.failed_orb_best = max(state.failed_orb_best, last)
                        if last < state.or_high and state.failed_orb_best - state.failed_orb_entry <= FAILED_ORB_MAX_MOVE:
                            state.failed_orb_returned = True
                    elif state.failed_orb_direction == "short":
                        state.failed_orb_best = min(state.failed_orb_best, last)
                        if last > state.or_low and state.failed_orb_entry - state.failed_orb_best <= FAILED_ORB_MAX_MOVE:
                            state.failed_orb_returned = True
                self._check_sl(state)
                if state.in_position:
                    self._check_trail_intrabar(state)
            if self._check_daily_profit_floor(state):
                return
            now = datetime.now(TZ)
            t = now.time()
            if now.weekday() >= 5 or t < ENTRY_START or t >= EOD_EXIT:
                return
            prev_in_or = state.or_low <= previous_price <= state.or_high
            if (t < ENTRY_CUTOFF and state.cfg.get("immediate_orb") and not ORB_ONLY_MODE
                    and state.or_complete and not state.or_chop_mode and not state.orb_disabled
                    and not state.in_position and previous_price > 0 and prev_in_or
                    and (state.cooldown_until is None or now >= state.cooldown_until)):
                if previous_price <= state.or_high < last:
                    self.enter(state, "long", "ORB_TICK")
                    if state.in_position and self._is_failed_orb_filter_day(state):
                        state.failed_orb_pending = True
                        state.failed_orb_direction = "long"
                        state.failed_orb_entry = state.entry_px
                        state.failed_orb_best = state.entry_px
                        state.failed_orb_returned = False
                elif previous_price >= state.or_low > last:
                    self.enter(state, "short", "ORB_TICK")
                    if state.in_position and self._is_failed_orb_filter_day(state):
                        state.failed_orb_pending = True
                        state.failed_orb_direction = "short"
                        state.failed_orb_entry = state.entry_px
                        state.failed_orb_best = state.entry_px
                        state.failed_orb_returned = False
            self._update_bar(state, last, now)
        except Exception as e:
            log.error(f"Quote error: {e}")

    def _get_state_by_id(self, contract_id) -> Optional[InstrumentState]:
        for state in self.states.values():
            if state.cfg.get("contract_id") == contract_id:
                return state
        return None

    def _is_failed_orb_filter_day(self, state: InstrumentState) -> bool:
        """Return True if the failed-ORB filter is active for today."""
        dows = state.cfg.get("failed_orb_filter_dows", [])
        if not dows:
            return False
        return datetime.now(TZ).strftime("%A") in dows

    def _check_or15_volume_filter(self, state: InstrumentState):
        """Informational only ΓÇö reports OR-window volume if the feed provides it.
        Does NOT affect trading in any way (no orb_disabled, no entry blocking)."""
        if state.or15_volume_ticks < 10:
            log.info(f"{state.sym} OR15 volume: unavailable (only {state.or15_volume_ticks} sized ticks seen)")
            return
        log.info(f"{state.sym} OR15 volume: {state.or15_volume:.0f} ({state.or15_volume_ticks} ticks) ΓÇö info only, not affecting trading")

    def _update_bar(self, state: InstrumentState, price: float, now: datetime):
        """Accumulate ticks into 5m bars and 15m bars for the failed-ORB filter"""
        minutes_since_open = (now.hour * 60 + now.minute) - (9 * 60 + 30)
        if minutes_since_open < 0:
            return
        bar_num = minutes_since_open // BAR_MINUTES

        if bar_num != state.bar_num:
            if state.bar_num >= 0 and state.bar_close is not None:
                self._on_bar_close(state, now)
            state.bar_num  = bar_num
            state.bar_open = price
            state.bar_high = price
            state.bar_low  = price
            state.bar_close = price
            if bar_num == 0 and state.rth_open == 0.0:
                state.rth_open = price
        else:
            if price > state.bar_high: state.bar_high = price
            if price < state.bar_low:  state.bar_low  = price
            state.bar_close = price

        # Track 15m bars for the failed-ORB filter evaluation
        filter_bars_per = FAILED_ORB_FILTER_BAR_MINUTES // BAR_MINUTES
        filter_bar_num = bar_num // filter_bars_per
        if filter_bar_num != state.orb_filter_bar_num:
            if state.orb_filter_bar_num >= 0 and state.orb_filter_bar_close is not None:
                self._check_failed_orb_filter(state)
            state.orb_filter_bar_num = filter_bar_num
            state.orb_filter_bar_open = price
            state.orb_filter_bar_high = price
            state.orb_filter_bar_low = price
            state.orb_filter_bar_close = price
        else:
            if price > state.orb_filter_bar_high: state.orb_filter_bar_high = price
            if price < state.orb_filter_bar_low:  state.orb_filter_bar_low  = price
            state.orb_filter_bar_close = price

    def _check_failed_orb_filter(self, state: InstrumentState):
        """Evaluate failed-ORB filter at the 15m bar close."""
        if not state.failed_orb_pending or not state.failed_orb_returned:
            state.failed_orb_pending = False
            return
        bcl = state.orb_filter_bar_close
        closed_inside = (state.failed_orb_direction == "long" and bcl < state.or_high) or (state.failed_orb_direction == "short" and bcl > state.or_low)
        if closed_inside:
            state.orb_disabled = True
            log.warning(
                f"{state.sym} FAILED ORB FILTER: {state.failed_orb_direction.upper()} entry reversed inside OR on 15m close ΓÇö "
                f"ORB disabled for rest of day | 15m bar OHLC={state.orb_filter_bar_open:.2f}/{state.orb_filter_bar_high:.2f}/{state.orb_filter_bar_low:.2f}/{bcl:.2f} "
                f"OR={state.or_high:.2f}/{state.or_low:.2f}"
            )
            self._save_or_levels(state)
        state.failed_orb_pending = False

    def _update_vwap(self, state: InstrumentState):
        """Update cumulative VWAP and volume-weighted std-dev from the just-closed bar."""
        if state.sym != "ES" or state.bar_close is None:
            return
        # typical price = (H+L+C)/3
        tp = (state.bar_high + state.bar_low + state.bar_close) / 3.0
        vol = 1.0  # no live volume feed; use unit weight per 5m bar
        old_vwap = state.vwap
        state.vwap_sum += tp * vol
        state.vwap_vol_sum += vol
        state.vwap_bars += 1
        if state.vwap_vol_sum > 0:
            new_vwap = state.vwap_sum / state.vwap_vol_sum
            state.vwap = new_vwap
            # Welford's online variance for numerically stable population variance
            state.vwap_sq_dev_sum += (tp - old_vwap) * (tp - new_vwap)
            var = state.vwap_sq_dev_sum / state.vwap_vol_sum
            state.vwap_std = var ** 0.5

    def _on_bar_close(self, state: InstrumentState, bar_time: datetime):
        """Process completed 5m bar"""
        t   = bar_time.time()
        weekday = bar_time.weekday()  # 0=Monday, 6=Sunday
        
        # Only trade Monday-Friday (0-4)
        if weekday >= 5:  # Saturday=5, Sunday=6
            return

        # Update VWAP for ES
        self._update_vwap(state)
            
        bcl = state.bar_close
        bhi = state.bar_high
        blo = state.bar_low
        cfg = state.cfg

        # Track full day range for ES VWAP prior-day range
        if bhi > state.day_high: state.day_high = bhi
        if blo < state.day_low:  state.day_low  = blo

        # Daily reset
        day_str = bar_time.strftime("%Y-%m-%d")
        if state.day != day_str:
            if state.in_position:
                log.critical(f"{state.sym} still has an open position at day reset ΓÇö retrying flatten before reset")
                self.exit_position(state, "EOD_RECOVERY")
                if state.in_position:
                    return
            log.info(f"New day ΓÇö resetting {state.sym}")
            if state.day:
                previous_week = datetime.strptime(state.day, "%Y-%m-%d").isocalendar()[:2]
                current_week = bar_time.isocalendar()[:2]
                if previous_week != current_week:
                    state.consecutive_losing_days = 0
                    state.weekly_pause_until = ""
                elif state.daily_pnl < 0:
                    state.consecutive_losing_days += 1
                    if state.consecutive_losing_days >= 3:
                        state.weekly_pause_until = (bar_time + timedelta(days=4 - bar_time.weekday())).strftime("%Y-%m-%d")
                        log.warning(f"{state.sym} weekly pause active after 3 consecutive losing days ΓÇö no entries through {state.weekly_pause_until}")
                else:
                    state.consecutive_losing_days = 0

            # Store current day's levels before reset (for previous day tracking)
            if state.or_complete and state.day:
                # Shift previous levels
                state.prev3_high = state.prev2_high
                state.prev3_low = state.prev2_low
                state.prev2_high = state.prev_high
                state.prev2_low = state.prev_low
                state.prev_high = state.or_high
                state.prev_low = state.or_low
                # Store full prior-day RTH range for ES VWAP regime detection
                if state.day_high > 0 and state.day_low < float("inf"):
                    state.prev_day_high = state.day_high
                    state.prev_day_low = state.day_low
                log.info(f"{state.sym} Previous levels: H={state.prev_high:.2f} L={state.prev_low:.2f}")
            
            state.reset_day()
            state.day = day_str

        # Build OR
        if not state.or_complete:
            if bhi > state.or_high: state.or_high = bhi
            if blo < state.or_low:  state.or_low  = blo
            state.or_bars_collected += 1
            state.prev_bar_close = bcl
            or_end_mins = 9 * 60 + 30 + cfg["or_bars"] * 5
            or_end_time = dtime(or_end_mins // 60, or_end_mins % 60)
            if state.or_bars_collected >= cfg["or_bars"]:
                state.or_complete = True
                log.info(f"{state.sym} OR complete: H={state.or_high:.2f} L={state.or_low:.2f} | OR15_vol={state.or15_volume:.0f}")
                self._check_or15_volume_filter(state)
                self._save_or_levels(state)
            elif t >= or_end_time and state.or_bars_collected >= 1:
                # Bot started late ΓÇö past OR window but collected some bars; use what we have
                state.or_complete = True
                log.warning(f"{state.sym} OR late-complete ({state.or_bars_collected}/{cfg['or_bars']} bars): H={state.or_high:.2f} L={state.or_low:.2f} | OR15_vol={state.or15_volume:.0f}")
                self._check_or15_volume_filter(state)
            return

        if t >= ENTRY_CUTOFF:
            return

        # Trail check at bar close while in position
        if state.in_position:
            self._check_trail(state, bcl)
            # Don't return ΓÇö still check for flip signals below



        if state.bo_fired > 0 and state.fade_fired:
            pass  # still allow flip via bounce

        or_h = state.or_high
        or_l = state.or_low

        # Breakout signal ΓÇö NQ only (YM has its own ORB block below)
        # NQ: ORB is fallback only ΓÇö skip if VWAP already fired today
        if state.sym == "NQ" and state.or_complete and not state.vwap_fired:
            # Count OR boundary rejections: touched OR level but closed back inside = chop
            if bhi >= or_h and bcl < or_h:
                state.or_high_rejections += 1
                log.info(f"{state.sym} OR High rejection #{state.or_high_rejections} | touched {or_h:.2f}, closed {bcl:.2f}")
            if blo <= or_l and bcl > or_l:
                state.or_low_rejections += 1
                log.info(f"{state.sym} OR Low rejection #{state.or_low_rejections} | touched {or_l:.2f}, closed {bcl:.2f}")
            # Chop mode: both sides repeatedly rejecting the OR boundary
            # Auto-expires after 1 hour to avoid missing later trend breakouts
            chop_hours = cfg.get("chop_hours", 1)
            chop_high_thresh = cfg.get("chop_high_thresh", 3)
            chop_low_thresh = cfg.get("chop_low_thresh", 2)
            if state.or_chop_mode and state.or_chop_mode_since:
                if bar_time - state.or_chop_mode_since >= timedelta(hours=chop_hours):
                    state.or_chop_mode = False
                    state.or_chop_mode_since = None
                    state.or_high_rejections = 0
                    state.or_low_rejections = 0
                    log.warning(f"{state.sym} CHOP MODE EXPIRED after {chop_hours} hour(s) ΓÇö ORB entries re-enabled")
            if not state.or_chop_mode:
                if (state.or_high_rejections >= chop_high_thresh and state.or_low_rejections >= chop_low_thresh) or \
                   (state.or_low_rejections >= chop_high_thresh and state.or_high_rejections >= chop_low_thresh):
                    state.or_chop_mode = True
                    state.or_chop_mode_since = bar_time
                    log.warning(f"{state.sym} CHOP MODE: {state.or_high_rejections} high rejections, {state.or_low_rejections} low rejections ΓÇö ALL entries (ORB + bounces) skipped for {chop_hours} hour(s)")

            breakout_triggered = False

            # Check OR breakout ΓÇö fire when a bar closes beyond OR level while flat
            # Directional filter: breakout bar must close in the direction of the trade.
            # Freshness filter: previous bar must have closed inside OR (no chasing).
            pending_direction = ""
            pending_strategy = state.pending_orb_strategy
            pending_boundary = state.pending_orb_boundary
            state.pending_orb_direction = ""
            state.pending_orb_strategy = ""
            state.pending_orb_boundary = 0.0
            if pending_direction:
                self._save_or_levels(state)
            if pending_direction and not state.or_chop_mode and not state.orb_disabled and not state.in_position and ORB_ENABLED and state.bo_fired < MAX_ORB:
                sustained = bcl > pending_boundary if pending_direction == "long" else bcl < pending_boundary
                if sustained:
                    log.info(f"{state.sym} REPEAT ORB {pending_direction.upper()} confirmed | second close={bcl:.2f} beyond {pending_boundary:.2f}")
                    self.enter(state, pending_direction, pending_strategy)
                    if state.in_position:
                        state.bo_fired += 1
                        breakout_triggered = True
                    self._save_or_levels(state)
                else:
                    log.info(f"{state.sym} REPEAT ORB {pending_direction.upper()} canceled | second close={bcl:.2f} returned inside {pending_boundary:.2f}")
                    self._save_or_levels(state)

            prev_in_or = state.prev_bar_close > 0 and or_l <= state.prev_bar_close <= or_h
            candidate_direction = ""
            candidate_strategy = ""
            candidate_boundary = 0.0
            if not breakout_triggered and not state.cfg.get("immediate_orb") and not state.or_chop_mode and not state.orb_disabled and not state.in_position and ORB_ENABLED and state.bo_fired < MAX_ORB:
                if bcl > or_h and prev_in_or:
                    candidate_direction = "long"
                    candidate_strategy = "BO_OR"
                    candidate_boundary = or_h
                elif bcl < or_l and prev_in_or:
                    candidate_direction = "short"
                    candidate_strategy = "BO_OR"
                    candidate_boundary = or_l

                if candidate_direction:
                    if state.bo_fired < MAX_ORB:
                        log.info(f"{state.sym} {candidate_strategy} {candidate_direction.upper()} | close={bcl:.2f} beyond {candidate_boundary:.2f}")
                        self.enter(state, candidate_direction, candidate_strategy)
                        if state.in_position:
                            state.bo_fired += 1
                            breakout_triggered = True
                            self._save_or_levels(state)
                    else:
                        state.pending_orb_direction = candidate_direction
                        state.pending_orb_strategy = candidate_strategy
                        state.pending_orb_boundary = candidate_boundary
                        log.info(f"{state.sym} REPEAT ORB {candidate_direction.upper()} armed | first close={bcl:.2f} beyond {candidate_boundary:.2f}; waiting for second close")
                        self._save_or_levels(state)
            elif not ORB_ENABLED and not state.in_position and not getattr(state, "_orb_disabled_logged", False):
                log.info(f"{state.sym} ORB disabled ΓÇö bounces only (re-enable when NQ > 30,600)")
                state._orb_disabled_logged = True
            elif state.or_chop_mode and not state.in_position:
                log.info(f"{state.sym} ORB breakout blocked ΓÇö chop mode active")
            # Reset retest flags only when price closes back inside OR range
            if or_l <= bcl <= or_h:
                state.or_retested_low = True
                state.or_retested_high = True

        # ΓöÇΓöÇ EMA-20 (NQ only ΓÇö disabled, kept for heartbeat display) ΓöÇΓöÇ
        if state.sym == "NQ":
            state.vol_sum += 1.0
            alpha = 2.0 / (20 + 1)
            if state.ema20 == 0.0:
                state.ema20 = bcl
            else:
                state.ema20 = bcl * alpha + state.ema20 * (1 - alpha)
            state.prev_bar_close = bcl

        # ΓöÇΓöÇ YM: ORB + Pullback + Bounce1 ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
        if state.sym == "YM" and state.or_complete:
            blo_bar = state.bar_low; bhi_bar = state.bar_high

            # ORB ΓÇö primary breakout entry
            if state.bo_fired < 10 and not state.in_position:
                if bcl > or_h:
                    log.info(f"{state.sym} ORB LONG | close={bcl:.2f} > OR_H {or_h:.2f}")
                    self.enter(state, "long", "BO_OR")
                    state.bo_fired += 1
                    state.pb_or_broke = "long"
                elif bcl < or_l:
                    log.info(f"{state.sym} ORB SHORT | close={bcl:.2f} < OR_L {or_l:.2f}")
                    self.enter(state, "short", "BO_OR")
                    state.bo_fired += 1
                    state.pb_or_broke = "short"

            # TWAP update (always accumulate)
            ym_typical = (state.bar_high + state.bar_low + bcl) / 3
            state.ym_twap_sum += ym_typical
            state.ym_twap_bars += 1
            ym_twap_val = state.ym_twap_sum / state.ym_twap_bars

            # Pullback ΓÇö first retest of OR level after ORB exits
            if state.bo_fired > 0 and not state.pb_fired and not state.in_position and state.pb_or_broke:
                if state.pb_or_broke == "long" and blo_bar <= or_h and bcl > or_h:
                    log.info(f"{state.sym} PULLBACK LONG | retested OR_H={or_h:.2f}, closed above @ {bcl:.2f}")
                    self.enter(state, "long", "PB_OR")
                    state.pb_fired = True
                elif state.pb_or_broke == "short" and bhi_bar >= or_l and bcl < or_l:
                    log.info(f"{state.sym} PULLBACK SHORT | retested OR_L={or_l:.2f}, closed below @ {bcl:.2f}")
                    self.enter(state, "short", "PB_OR")
                    state.pb_fired = True

            state.ym_prev_bar_close = bcl  # TWAP signal disabled ΓÇö no edge on YM (PF=0.94 over 2yr)

            # Bounce1 ΓÇö single fade off OR level (PF 1.52 verified)
            # Directional filter: bounce candle must close in the direction of the trade
            if bhi_bar >= or_h and bcl < or_h and bcl < state.bar_open and state.bounce_high_count < 1:
                if not state.in_position:
                    log.info(f"{state.sym} BOUNCE SHORT #1 | touched OR_H={or_h:.2f}, closed below @ {bcl:.2f}")
                    self.enter(state, "short", "BOUNCE")
                    state.bounce_high_count += 1
            elif blo_bar <= or_l and bcl > or_l and bcl > state.bar_open and state.bounce_low_count < 1:
                if not state.in_position:
                    log.info(f"{state.sym} BOUNCE LONG #1 | touched OR_L={or_l:.2f}, closed above @ {bcl:.2f}")
                    self.enter(state, "long", "BOUNCE")
                    state.bounce_low_count += 1

        # ΓöÇΓöÇ ES: VWAP mean-reversion signal ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
        if ORB_ONLY_MODE:
            return
        if state.sym == "ES" and state.vwap_bars >= 3 and not state.in_position:
            sigma = cfg.get("vwap_sigma", 1.0)
            vwap_upper = state.vwap + sigma * state.vwap_std
            vwap_lower = state.vwap - sigma * state.vwap_std
            open_px = state.rth_open if state.rth_open > 0 else bcl
            inside_prev = state.prev_day_high > 0 and state.prev_day_low > 0 and state.prev_day_low <= open_px <= state.prev_day_high
            max_trades = cfg.get("vwap_max_trades", 2)
            cutoff_str = cfg.get("vwap_time_cutoff", "15:00")
            cutoff_h, cutoff_m = map(int, cutoff_str.split(":"))
            vwap_cutoff = dtime(cutoff_h, cutoff_m)

            if inside_prev and state.daily_trades < max_trades and t < vwap_cutoff:
                direction = None
                if bcl > vwap_upper and bcl < state.bar_open:
                    direction = "short"
                elif bcl < vwap_lower and bcl > state.bar_open:
                    direction = "long"

                cooldown_ok = state.bar_num > state.vwap_last_entry_bar + 1
                if direction and cooldown_ok:
                    log.info(f"{state.sym} VWAP {direction.upper()} | close={bcl:.2f} vs VWAP={state.vwap:.2f} +/-{sigma}╧â [{vwap_upper:.2f}/{vwap_lower:.2f}] | prev_range={state.prev_day_low:.2f}-{state.prev_day_high:.2f}")
                    self.enter(state, direction, "VWAP_REV")
                    state.vwap_last_entry_bar = state.bar_num

        # Bounce signal ΓÇö NQ only (YM bounce handled above, ES/RTY bounces verified negative PF)
        if state.sym not in ("NQ",):
            return
        max_bounce = cfg.get("max_bounces_per_side", 1)

        if state.bounce_high_count >= max_bounce and bhi >= or_h and bcl < or_h:
            log.info(f"{state.sym} BOUNCE SHORT skipped ΓÇö already took {state.bounce_high_count} high bounce(s)")
        if state.bounce_low_count >= max_bounce and blo <= or_l and bcl > or_l:
            log.info(f"{state.sym} BOUNCE LONG skipped ΓÇö already took {state.bounce_low_count} low bounce(s)")

        if bhi >= or_h and bcl < or_h and state.bounce_high_count < max_bounce and (state.bar_open is None or state.bar_open <= or_h or state.reclaim_count < cfg.get("max_reclaims", 2)):
            if state.or_chop_mode:
                log.info(f"{state.sym} BOUNCE SHORT skipped ΓÇö chop mode active")
            else:
                log.info(f"{state.sym} BOUNCE SHORT #{state.bounce_high_count+1} | touched OR_H={or_h:.2f}, closed below @ {bcl:.2f}")
                if state.in_position and state.direction == "long":
                    log.info(f"{state.sym} BOUNCE SHORT skipped ΓÇö already in long position")
                if not state.in_position:
                    is_reclaim = state.bar_open is not None and state.bar_open > or_h
                    self.enter(state, "short", "BOUNCE")
                    if state.in_position and is_reclaim:
                        state.reclaim_count += 1
                    state.bounce_high_count += 1
                    state.fade_fired = True
                    self._save_or_levels(state)

        elif blo <= or_l and bcl > or_l and state.bounce_low_count < max_bounce and (state.bar_open is None or state.bar_open >= or_l or state.reclaim_count < cfg.get("max_reclaims", 2)):
            if state.or_chop_mode:
                log.info(f"{state.sym} BOUNCE LONG skipped ΓÇö chop mode active")
            else:
                log.info(f"{state.sym} BOUNCE LONG #{state.bounce_low_count+1} | touched OR_L={or_l:.2f}, closed above @ {bcl:.2f}")
                if state.in_position and state.direction == "short":
                    log.info(f"{state.sym} BOUNCE LONG skipped ΓÇö already in short position")
                if not state.in_position:
                    is_reclaim = state.bar_open is not None and state.bar_open < or_l
                    self.enter(state, "long", "BOUNCE")
                    if state.in_position and is_reclaim:
                        state.reclaim_count += 1
                    state.bounce_low_count += 1
                    state.fade_fired = True
                    self._save_or_levels(state)



    def _check_trail_intrabar(self, state: InstrumentState):
        """Tick-based trail ΓÇö polled every 30 seconds"""
        if not state.in_position:
            return
        last = state.last_price
        if last == 0:
            return
        trail = state.cfg["trail"]
        profit_floor = state.cfg.get("trail_profit_floor", 0.0)
        if state.direction == "long":
            if last > state.best_excursion:
                state.best_excursion = last
            stop = max(state.best_excursion - trail, state.entry_px + profit_floor)
            activate = state.cfg.get("trail_activate", trail)
            trail_active = state.best_excursion >= state.entry_px + activate  # activate after 5pts profit
            if trail_active:
                if not getattr(state, '_trail_logged', False):
                    log.info(f"{state.sym} TRAIL ACTIVE LONG | best={state.best_excursion:.2f} activate={state.entry_px + activate:.2f} stop={stop:.2f}")
                    state._trail_logged = True
                if last <= stop:
                    log.info(f"{state.sym} TRAIL LONG hit @ {last:.2f} stop={stop:.2f}")
                    self.exit_position(state, "TRAIL")
        elif state.direction == "short":
            if state.best_excursion == 0.0:
                state.best_excursion = state.entry_px
            if last < state.best_excursion:
                state.best_excursion = last
            stop = min(state.best_excursion + trail, state.entry_px - profit_floor)
            activate = state.cfg.get("trail_activate", trail)
            trail_active = state.best_excursion <= state.entry_px - activate  # activate after 5pts profit
            if trail_active:
                if not getattr(state, '_trail_logged', False):
                    log.info(f"{state.sym} TRAIL ACTIVE SHORT | best={state.best_excursion:.2f} activate={state.entry_px - activate:.2f} stop={stop:.2f}")
                    state._trail_logged = True
                if last >= stop:
                    log.info(f"{state.sym} TRAIL SHORT hit @ {last:.2f} stop={stop:.2f}")
                    self.exit_position(state, "TRAIL")

    def _check_sl(self, state: InstrumentState):
        """Hard SL ΓÇö polled every SL_POLL_SEC seconds"""
        if not state.in_position:
            return
        last = state.last_price
        if last == 0:
            return
        cfg = state.cfg
        EMERGENCY_BUFFER = 5.0  # pts past SL triggers emergency market order
        # ATR-based SL if set at entry, otherwise fall back to fixed cfg[sl]
        sl_dist = state.atr_sl if state.atr_sl > 0 else cfg["sl"]
        sl_px = state.entry_px - sl_dist if state.direction == "long" else state.entry_px + sl_dist
        if state.direction == "long":
            if last <= sl_px - EMERGENCY_BUFFER:
                log.warning(f"{state.sym} EMERGENCY STOP LONG ΓÇö price {last:.2f} blew {EMERGENCY_BUFFER}pt past SL {sl_px:.2f}, market order")
                self.exit_position(state, "EMERGENCY")
            elif last <= sl_px:
                log.warning(f"{state.sym} SL LONG hit @ {last:.2f}")
                self.exit_position(state, "SL")
        elif state.direction == "short":
            if last >= sl_px + EMERGENCY_BUFFER:
                log.warning(f"{state.sym} EMERGENCY STOP SHORT ΓÇö price {last:.2f} blew {EMERGENCY_BUFFER}pt past SL {sl_px:.2f}, market order")
                self.exit_position(state, "EMERGENCY")
            elif last >= sl_px:
                log.warning(f"{state.sym} SL SHORT hit @ {last:.2f}")
                self.exit_position(state, "SL")

    def _check_tp(self, state: InstrumentState):
        """Take Profit ΓÇö checked every SL_POLL_SEC seconds"""
        if not state.in_position:
            return
        last = state.last_price
        if last == 0:
            return
        cfg = state.cfg
        if state.direction == "long":
            if last >= state.entry_px + cfg["tp"]:
                log.info(f"{state.sym} TP LONG hit @ {last:.2f}")
                self.exit_position(state, "TP")
        elif state.direction == "short":
            if last <= state.entry_px - cfg["tp"]:
                log.info(f"{state.sym} TP SHORT hit @ {last:.2f}")
                self.exit_position(state, "TP")

    def _check_trail(self, state: InstrumentState, bar_close: float):
        """Trail SL ΓÇö checked at bar close"""
        cfg = state.cfg
        activate = cfg.get("trail_activate", cfg["trail"])
        profit_floor = cfg.get("trail_profit_floor", 0.0)
        if state.direction == "long":
            if state.best_excursion == 0.0:
                state.best_excursion = state.entry_px
            if bar_close > state.best_excursion:
                state.best_excursion = bar_close
            if state.best_excursion < state.entry_px + activate:
                return
            stop = max(state.best_excursion - cfg["trail"], state.entry_px + profit_floor)
            if bar_close <= stop:
                log.info(f"{state.sym} TRAIL LONG | best={state.best_excursion:.2f}")
                self.exit_position(state, "Trail")
        elif state.direction == "short":
            if state.best_excursion == 0.0:
                state.best_excursion = state.entry_px
            if bar_close < state.best_excursion:
                state.best_excursion = bar_close
            if state.best_excursion > state.entry_px - activate:
                return
            stop = min(state.best_excursion + cfg["trail"], state.entry_px - profit_floor)
            if bar_close >= stop:
                log.info(f"{state.sym} TRAIL SHORT | best={state.best_excursion:.2f}")
                self.exit_position(state, "Trail")

    def enter(self, state: InstrumentState, direction: str, trade_type: str):
        if state.in_position or state.entry_in_progress:
            return  # should have been flipped before calling enter
        if not self._external_can_enter(direction):
            log.info(f"{state.sym} {trade_type} {direction.upper()} entry blocked — opposite-direction position active")
            return
        if state.sym == "NQ" and state.cfg.get("cooldown_minutes") and state.cooldown_until and datetime.now(TZ) < state.cooldown_until:
            return
        
        # Block entries if OR was seeded from session range (bot started late).
        # VWAP/TWAP signals are still allowed because they don't depend on the OR window.
        if state.or_seeded and not trade_type.startswith(("VWAP", "TWAP")):
            log.warning(f"{state.sym} entry blocked ΓÇö OR was seeded (bot started late), wait for tomorrow")
            return

        # Check daily trade limit
        if state.daily_trades >= state.max_daily_trades:
            log.warning(f"{state.sym} daily trade limit reached ({state.daily_trades}/{state.max_daily_trades})")
            return

        combined_pnl = self._combined_marked_pnl()
        day_str = datetime.now(TZ).strftime("%Y-%m-%d")
        if state.weekly_pause_until and day_str <= state.weekly_pause_until:
            log.warning(f"{state.sym} weekly pause active through {state.weekly_pause_until} ΓÇö no new entries today")
            return
        if self.daily_halt_day == day_str or combined_pnl <= DAILY_LOSS_LIMIT:
            self.daily_halt_day = day_str
            log.warning(f"{state.sym} daily loss limit active (${combined_pnl:+,.0f}) ΓÇö no new entries today")
            return
        if state.daily_profit_halted:
            log.warning(f"{state.sym} daily profit floor active ΓÇö no new entries today")
            return

        side = 0 if direction == "long" else 1
        state.entry_in_progress = True
        try:
            cfg = state.cfg
            # Pick contract/qty based on size_tier
            if state.sym == "NQ" and cfg.get("size_ladder"):
                cid = cfg["contract_id"]
                qty = state.ladder_qty
                mv = cfg["mv"]
                size_label = f"{qty}xMNQ"
            elif state.sym == "NQ" and NQ_FIXED_QTY:
                cid = cfg["contract_id"]
                qty = cfg["qty"]
                mv  = cfg["mv"]
                size_label = f"{qty}xMNQ"
            elif state.sym == "NQ" and state.size_tier > 0:
                cid = cfg["reduced_contract_id"]
                qty = cfg["reduced_qty"]
                mv  = cfg["reduced_mv"]
                size_label = f"{qty}xMNQ"
            else:
                cid = cfg["contract_id"]
                qty = cfg["qty"]
                mv  = cfg["mv"]
                size_label = f"{qty}xMNQ" if state.sym == "NQ" else f"{qty}x{state.sym}"
            order_results = {}
            def _place(acct_id):
                try:
                    order_results[acct_id] = self.client.place_market_order(acct_id, cid, side, qty)
                except Exception as e:
                    order_results[acct_id] = {"error": str(e)}
            threads = [threading.Thread(target=_place, args=(acct_id,)) for acct_id in self.account_ids]
            for t in threads: t.start()
            for t in threads: t.join()
            successful_accounts = {}
            for acct_id, res in order_results.items():
                oid = res.get("orderId") if isinstance(res, dict) else None
                err = res.get("error") if isinstance(res, dict) else None
                accepted = bool(oid) and res.get("success", True) is not False if isinstance(res, dict) else False
                if err:
                    log.error(f"{state.sym} entry order failed for account {acct_id}: {err}")
                elif accepted:
                    successful_accounts[acct_id] = qty
                    log.info(f"{state.sym} entry order placed for account {acct_id}: orderId={oid}")
                else:
                    log.error(f"{state.sym} entry order rejected for account {acct_id}: {res}")
            if not successful_accounts:
                log.critical(f"{state.sym} entry aborted ΓÇö no account accepted the order")
                return
            if len(successful_accounts) != len(self.account_ids):
                failed_accounts = sorted(set(self.account_ids) - set(successful_accounts))
                log.critical(f"{state.sym} partial entry ΓÇö active accounts={sorted(successful_accounts)}, failed accounts={failed_accounts}")
            state.active_contract_id = cid
            state.active_qty = qty
            state.active_mv = mv
            state.active_account_qty = successful_accounts

            # Compute ATR-based stop distance from recent 1m bars (NQ only)
            state.atr_sl = 0.0
            if state.sym == "NQ" and ATR_MULT > 0 and cid:
                try:
                    bars_1m = self.client.get_history_1m(cid, units_back=ATR_PERIOD + 5)
                    bars_1m = sorted(bars_1m, key=lambda b: b.get("t") or b.get("timestamp") or b.get("time") or "")
                    if len(bars_1m) >= ATR_PERIOD + 1:
                        highs = [float(b["high"]) for b in bars_1m]
                        lows  = [float(b["low"])  for b in bars_1m]
                        closes = [float(b["close"]) for b in bars_1m]
                        trs = []
                        for k in range(1, len(bars_1m)):
                            tr = max(highs[k] - lows[k],
                                     abs(highs[k] - closes[k-1]),
                                     abs(lows[k]  - closes[k-1]))
                            trs.append(tr)
                        atr = sum(trs[-ATR_PERIOD:]) / ATR_PERIOD
                        state.atr_sl = min(round(ATR_MULT * atr, 2), NQ_ATR_MAX_STOP)
                        log.info(f"{state.sym} ATR({ATR_PERIOD})={atr:.2f} => SL={state.atr_sl:.2f}pt ({ATR_MULT}x, cap={NQ_ATR_MAX_STOP:.0f})")
                except Exception as e:
                    log.warning(f"{state.sym} ATR calc failed: {e} ΓÇö using fixed SL")

            # Original bot behavior: trust the order fill confirmation and manage the trade

            state.in_position = True
            state.direction = direction
            state.trade_type = trade_type
            state.fade_fired = trade_type == "BOUNCE"
            state.best_excursion = 0.0
            state.entry_px = state.last_price
            state.next_exit_retry_at = 0.0
            state.daily_trades += 1
            log.info(f"ORB {state.sym} ENTERED {direction.upper()} ({trade_type}) @ {state.entry_px:.2f} [{size_label}] (trades today: {state.daily_trades}/{state.max_daily_trades})")
            self._save_or_levels(state)  # persist bo_fired/vwap_fired flags
            
        except Exception as e:
            log.error(f"{state.sym} entry failed: {e}")
        finally:
            state.entry_in_progress = False

    def exit_position(self, state: InstrumentState, reason: str):
        if not state.in_position or state.exit_in_progress:
            return
        if time.time() < state.next_exit_retry_at:
            return  # backoff active ΓÇö avoid hammering the API every tick after a failed exit
        side = 1 if state.direction == "long" else 0
        cid = state.active_contract_id
        targets = dict(state.active_account_qty) if state.active_account_qty else {
            account_id: state.active_qty for account_id in self.account_ids
        }
        if not cid or not targets:
            log.critical(f"{state.sym} exit blocked ΓÇö missing active contract or account quantities")
            return
        state.exit_in_progress = True
        try:
            order_results = {}
            def _place_exit(account_id, account_qty):
                try:
                    order_results[account_id] = self.client.place_market_order(account_id, cid, side, account_qty)
                except Exception as e:
                    order_results[account_id] = {"error": str(e)}
            threads = [
                threading.Thread(target=_place_exit, args=(account_id, account_qty))
                for account_id, account_qty in targets.items()
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

            failed_accounts = {}
            for account_id, account_qty in targets.items():
                res = order_results.get(account_id, {"error": "missing order response"})
                oid = res.get("orderId") if isinstance(res, dict) else None
                err = res.get("error") if isinstance(res, dict) else None
                accepted = bool(oid) and res.get("success", True) is not False if isinstance(res, dict) else False
                if accepted:
                    log.info(f"{state.sym} exit order placed for account {account_id}: orderId={oid}")
                else:
                    failed_accounts[account_id] = account_qty
                    log.critical(f"{state.sym} exit order failed for account {account_id}: {err or res}")
            if failed_accounts:
                state.active_account_qty = failed_accounts
                state.active_qty = next(iter(failed_accounts.values()))
                state.next_exit_retry_at = time.time() + 2.0
                log.critical(f"{state.sym} remains active locally for failed exit accounts {sorted(failed_accounts)}; exit will retry in 2s")
                return

            # Verify broker actually shows flat before resetting state
            flat_verified = False
            for attempt in range(40):
                try:
                    if self._all_accounts_flat(cid):
                        flat_verified = True
                        log.info(f"{state.sym} exit confirmed: all accounts flat")
                        break
                except Exception as e:
                    log.warning(f"{state.sym} flat check attempt {attempt+1} failed: {e}")
                time.sleep(0.5)
            if not flat_verified:
                log.critical(f"{state.sym} EXIT WARNING: broker still reports open position after accepted exit orders ΓÇö will retry")
                state.next_exit_retry_at = time.time() + 2.0
                return

            exited_direction = state.direction
            qty = state.active_qty
            exit_px = state.last_price
            if exited_direction == "long":
                pnl = (exit_px - state.entry_px) * state.active_mv * qty
            else:
                pnl = (state.entry_px - exit_px) * state.active_mv * qty
            state.daily_pnl += pnl
            state.last_trade_pnl = pnl
            if state.sym == "NQ" and state.cfg.get("size_ladder"):
                direction = 1 if pnl > 0 else -1
                state.ladder_qty = min(state.cfg["max_qty"], max(state.cfg["min_qty"], state.ladder_qty + direction))
                state.consecutive_losses = state.consecutive_losses + 1 if pnl <= 0 else 0
                state.consecutive_wins = state.consecutive_wins + 1 if pnl > 0 else 0
                state.cooldown_until = datetime.now(TZ) + timedelta(minutes=state.cfg["cooldown_minutes"])
                log.info(f"{state.sym} LADDER SIZE: next trade {state.ladder_qty} MNQ")
            elif pnl > 0:
                state.consecutive_losses = 0
                state.consecutive_wins += 1
                if state.size_tier > 0:
                    state.consec_wins_since_reduce += 1
                    if state.consec_wins_since_reduce >= state.cfg.get("recovery_wins", 3):
                        state.size_tier = 0
                        state.consec_wins_since_reduce = 0
                        log.info(f"{state.sym} SIZE UP: {state.cfg.get('recovery_wins', 3)} win(s) ΓåÆ {state.cfg['qty']} MNQ")
            else:
                state.consecutive_wins = 0
                state.consecutive_losses += 1
                state.consec_wins_since_reduce = 0
                if state.sym == "NQ" and not NQ_FIXED_QTY and state.consecutive_losses >= NQ_SIZE_DOWN_LOSSES:
                    old_tier = state.size_tier
                    state.size_tier = 1
                    state.consecutive_losses = 0
                    if state.size_tier != old_tier:
                        log.warning(f"{state.sym} SIZE DOWN: {NQ_SIZE_DOWN_LOSSES} loss(es) ΓåÆ {state.cfg['reduced_qty']} MNQ")
            if state.sym == "NQ" and state.cfg.get("cooldown_minutes"):
                state.cooldown_until = datetime.now(TZ) + timedelta(minutes=state.cfg["cooldown_minutes"])
            outcome = "PROFIT" if pnl > 0 else "LOSS" if pnl < 0 else "FLAT"
            exit_type = "TRAIL" if reason == "Trail" else "NON-TRAIL"
            log.info(f"ORB {state.sym} EXITED ({reason}) [{outcome} | {exit_type}] ~{exit_px:.2f} | est PnL=${pnl:+,.0f} | day=${state.daily_pnl:+,.0f} | streak=L{state.consecutive_losses}/W{state.consecutive_wins}")

            state.in_position = False
            state.direction = ""
            state.entry_px = 0.0
            state.best_excursion = 0.0
            state._trail_logged = False
            state.trade_type = ""
            state.fade_fired = False
            state._flip_pending_dir = None
            state._flip_confirm_count = 0
            state.active_contract_id = None
            state.active_qty = 1
            state.active_account_qty = {}
            if pnl < 0:
                state.or_retested_high = False
                state.or_retested_low = False
                log.info(f"{state.sym} RETEST GUARD: loss exit, both ORB directions locked until price returns to OR")
            elif exited_direction == "long":
                state.or_retested_high = False
                log.info(f"{state.sym} RETEST GUARD: long exit ΓÇö wait for price to return to OR before next long ORB")
            elif exited_direction == "short":
                state.or_retested_low = False
                log.info(f"{state.sym} RETEST GUARD: short exit ΓÇö wait for price to return to OR before next short ORB")
            self._save_or_levels(state)
        except Exception as e:
            log.error(f"{state.sym} exit failed: {e}")
        finally:
            state.exit_in_progress = False

    def _combined_marked_pnl(self) -> float:
        total = sum(s.daily_pnl for s in self.states.values())
        for state in self.states.values():
            if not state.in_position or state.last_price <= 0 or state.entry_px <= 0:
                continue
            sign = 1 if state.direction == "long" else -1
            total += sign * (state.last_price - state.entry_px) * state.active_mv * state.active_qty
        return total

    def _check_daily_profit_floor(self, state: InstrumentState) -> bool:
        trigger = float(state.cfg.get("daily_profit_trigger", 0.0))
        floor = float(state.cfg.get("daily_profit_floor", 0.0))
        if state.sym != "NQ" or trigger <= 0 or floor <= 0:
            return False
        if state.daily_profit_halted:
            if state.in_position:
                self.exit_position(state, "DAILY_PROFIT_FLOOR")
            return True
        marked_pnl = state.daily_pnl
        if state.in_position and state.last_price > 0 and state.entry_px > 0:
            sign = 1 if state.direction == "long" else -1
            marked_pnl += sign * (state.last_price - state.entry_px) * state.active_mv * state.active_qty
        if not state.daily_profit_floor_armed and marked_pnl >= trigger:
            state.daily_profit_floor_armed = True
            log.info(f"{state.sym} DAILY PROFIT FLOOR ARMED: marked PnL=${marked_pnl:+,.0f}; locking ${floor:,.0f}")
            self._save_or_levels(state)
        if state.daily_profit_floor_armed and marked_pnl <= floor:
            state.daily_profit_halted = True
            log.warning(f"{state.sym} DAILY PROFIT FLOOR HIT: marked PnL=${marked_pnl:+,.0f} <= ${floor:,.0f} ΓÇö flattening and blocking entries until tomorrow")
            if state.in_position:
                self.exit_position(state, "DAILY_PROFIT_FLOOR")
            self._save_or_levels(state)
            return True
        return False

    def _check_daily_loss_limit(self, day_str: str) -> bool:
        if self.daily_halt_day == day_str:
            for state in self.states.values():
                if state.in_position:
                    self.exit_position(state, "DAILY_LOSS_LIMIT")
            return True
        marked_pnl = self._combined_marked_pnl()
        if marked_pnl > DAILY_LOSS_LIMIT:
            return False
        self.daily_halt_day = day_str
        log.critical(f"DAILY LOSS LIMIT HIT: marked PnL=${marked_pnl:+,.0f} <= ${DAILY_LOSS_LIMIT:,.0f} ΓÇö flattening and blocking entries until tomorrow")
        for state in self.states.values():
            if state.in_position:
                self.exit_position(state, "DAILY_LOSS_LIMIT")
            self._save_or_levels(state)
        return True

    def run(self):
        log.info("="*60)
        log.info("  Boof ORB + VWAP Pullback | NQ + YM")
        log.info("="*60)
        self.setup()
        self.start_market_feed()
        log.info("Market feed live. Waiting for 9:30 ET...")

        while True:
            now = datetime.now(TZ)
            t   = now.time()
            weekday = now.weekday()  # 0=Monday, 6=Sunday

            # Daily reset at start of day
            day_str = now.strftime("%Y-%m-%d")
            if self.daily_halt_day is not None and self.daily_halt_day != day_str:
                log.info("Daily loss halt reset ΓÇö trading re-enabled")
                self.daily_halt_day = None
            for state in self.states.values():
                if state.day != day_str:
                    if state.in_position:
                        log.critical(f"{state.sym} still has an open position at day reset ΓÇö retrying flatten before reset")
                        self.exit_position(state, "EOD_RECOVERY")
                        if state.in_position:
                            continue
                    if state.or_complete and state.day:
                        state.prev3_high = state.prev2_high
                        state.prev3_low = state.prev2_low
                        state.prev2_high = state.prev_high
                        state.prev2_low = state.prev_low
                        state.prev_high = state.or_high
                        state.prev_low = state.or_low
                        if state.day_high > 0 and state.day_low < float("inf"):
                            state.prev_day_high = state.day_high
                            state.prev_day_low = state.day_low
                    # Before resetting, check combined daily PnL for streak tracking
                    if state.sym == "NQ":  # only trigger once, on NQ (first symbol)
                        combined_day_pnl = sum(s.daily_pnl for s in self.states.values())
                        if combined_day_pnl > 0:
                            self.win_streak += 1; self.loss_streak = 0
                            if self.win_streak >= self._sizing_trigger:
                                self.dynamic_qty = min(self.dynamic_qty + 1, self._max_qty)
                                self.win_streak = 0
                                log.info(f"DYNAMIC SIZING: {self._sizing_trigger} win days ΓåÆ qty now {self.dynamic_qty}")
                        elif combined_day_pnl < 0:
                            self.loss_streak += 1; self.win_streak = 0
                            if self.loss_streak >= self._sizing_trigger:
                                self.dynamic_qty = max(self.dynamic_qty - 1, self._min_qty)
                                self.loss_streak = 0
                                log.info(f"DYNAMIC SIZING: {self._sizing_trigger} loss days ΓåÆ qty now {self.dynamic_qty}")
                    state.reset_day()
                    state.day = day_str

            # Only trade Monday-Friday (0-4)
            if weekday < 5:  # Monday=0, Friday=4
                daily_halted = self._check_daily_loss_limit(day_str)
                # SL and TP polling loop
                if not daily_halted and ENTRY_START <= t < EOD_EXIT:
                    for state in self.states.values():
                        self._check_sl(state)
                        self._check_tp(state)
                        self._check_trail_intrabar(state)

                # EOD hard exit
                if t >= EOD_EXIT:
                    for state in self.states.values():
                        if state.in_position:
                            log.info(f"EOD exit: {state.sym}")
                            self.exit_position(state, "EOD")

            # Heartbeat every minute
            if now.second < SL_POLL_SEC:
                parts = []
                for s in self.states.values():
                    if s.sym != "NQ":
                        continue
                    if s.in_position:
                        mult = s.active_mv
                        sign = 1 if s.direction == "long" else -1
                        upnl = sign * (s.last_price - s.entry_px) * s.active_qty * mult
                        pos = f"IN {s.direction.upper()} @{round(s.entry_px,2)} uPnL=${upnl:+.0f}"
                    else:
                        pos = "flat"
                    orb_status = " ORB_DISABLED" if s.orb_disabled else ""
                    parts.append(f"{s.sym} px={s.last_price:.2f} OR[{s.or_high:.2f}/{s.or_low:.2f}]{'Γ£ô' if s.or_complete else 'ΓÇª'} OR15_vol={s.or15_volume:.0f} {pos}{orb_status} bounces[H={s.bounce_high_count}/L={s.bounce_low_count}] dayPnL=${s.daily_pnl:+.0f} lastTrade=${s.last_trade_pnl:+.0f}")
                nq_state = self.states.get("NQ")
                next_qty = INSTRUMENTS["NQ"]["reduced_qty"] if nq_state and nq_state.size_tier > 0 else INSTRUMENTS["NQ"]["qty"]
                if getattr(self, '_ws_closed', False):
                    conn_status = "DISCONNECTED"
                elif self._last_quote_time > 0 and (time.time() - self._last_quote_time) < 15:
                    conn_status = "CONNECTED"
                else:
                    conn_status = "STALE"
                log.info(f"[HEARTBEAT] {conn_status} | {' | '.join(parts)} | next_qty={next_qty} MNQ")

            # WS reconnect ΓÇö on explicit close event or stale feed during RTH
            # In combined mode the runner handles reconnect centrally
            if not self._combined_mode:
                now_et = datetime.now(TZ)
                is_rth = dtime(9, 0) <= now_et.time() <= dtime(16, 30)
                needs_reconnect = getattr(self, '_ws_closed', False)
                if not needs_reconnect and is_rth and self._last_quote_time > 0:
                    secs_since = time.time() - self._last_quote_time
                    if secs_since > 120:
                        log.warning(f"[WS] No quotes for {secs_since:.0f}s ΓÇö stale feed detected")
                        needs_reconnect = True
                if needs_reconnect:
                    log.warning("[WS] Reconnecting market feed...")
                    self._ws_closed = False
                    try:
                        self.client.authenticate()  # refresh JWT
                        self.start_market_feed()
                        self._last_quote_time = time.time()
                        log.info("[WS] Market feed reconnected successfully")
                    except Exception as re:
                        log.error(f"[WS] Reconnect failed: {re}")
                        raise RuntimeError(f"[WS] Reconnect failed: {re}") from re

            time.sleep(SL_POLL_SEC)

# ΓöÇΓöÇ ENTRY POINT ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        os.environ["PROJECT_X_API_KEY"] = sys.argv[1]
    if len(sys.argv) > 2:
        os.environ["PROJECT_X_USERNAME"] = sys.argv[2]
    print("="*60)
    print("  Boof ORB + VWAP/Pullback Futures Live Bot")
    print("  NQ + YM | TopstepX REST + SignalR")
    print("="*60)
    print()

    if not os.environ.get("PROJECT_X_USERNAME") or not os.environ.get("PROJECT_X_API_KEY"):
        pass  # fallback credentials hardcoded in BoofBot.__init__

    import signal
    _confirm_exit = [False]

    def _sigint_handler(sig, frame):
        if _confirm_exit[0]:
            print("\n[BOT] Confirmed ΓÇö shutting down.")
            os._exit(0)
        _confirm_exit[0] = True
        print("\n*** Ctrl+C detected ΓÇö press Ctrl+C again within 5 seconds to stop, or wait to continue...")
        import threading
        def _reset():
            import time; time.sleep(5)
            if _confirm_exit[0]:
                print("[BOT] Continuing...")
                _confirm_exit[0] = False
        threading.Thread(target=_reset, daemon=True).start()

    signal.signal(signal.SIGINT, _sigint_handler)

    while True:
        try:
            bot = BoofBot()
            bot.run()
        except KeyboardInterrupt:
            print("\n[BOT] Keyboard interrupt ΓÇö shutting down.")
            break
        except Exception as e:
            import traceback
            traceback.print_exc()
            log.error(f"[BOT] Crashed: {e} ΓÇö restarting in 15 seconds...")
            time.sleep(15)
