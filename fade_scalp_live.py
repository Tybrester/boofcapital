"""
Fade Scalp Live Bot ΓÇö NQ 1-Minute Big Candle Fade (v2 Optimized)
TopstepX via REST API + SignalR WebSocket

Strategy:
  When a 1m NQ candle has body >= 20pts, fade it (enter opposite direction).
  Confirmation: tick_cross ΓÇö wait for price to tick back past big candle close (60s timeout).
  Exit: Trailing stop with SL=25, Floor=7, Trail=3, MaxHold=15min.
  Position: 1 MNQ ($2/pt)

Expected performance (backtest 148 days, Jan 2025 - Jul 2026):
  PnL: +$3,772 | PF: 1.20 | WR: 80.8% | MDD: $774 | Avg: $1.89/trade | 61% pos days

Usage:
  py fade_scalp_live.py "YOUR_API_KEY" "your@email.com"
"""

import os
import sys
import json
import logging
import time
import threading
from datetime import datetime, time as dtime, timedelta
from zoneinfo import ZoneInfo
from typing import Optional
from dataclasses import dataclass, field

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
            print(f"[FADE] Loaded runtime config: {_runtime_cfg}")
    except Exception as _e:
        print(f"[FADE] Could not read runtime config: {_e}")

# ΓöÇΓöÇ CONFIG ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

TZ = ZoneInfo("America/New_York")

API_URL    = "https://api.topstepx.com"
MARKET_HUB = "wss://rtc.topstepx.com/hubs/market"

# Strategy parameters (optimized v2: tick_cross + 120s cooldown)
CONTRACT_NAME = _SYMBOL_MAP.get(_runtime_cfg.get("baseSymbol", ""), "MNQU26")
QTY = _runtime_cfg.get("baseQty", 5)
MV = _MV_MAP.get(_runtime_cfg.get("baseSymbol", ""), 2)
DOLLAR_PER_PT = QTY * MV

CANDLE_THRESH = 20.0        # 20pt body triggers signal
SL_PTS = 25.0               # Stop loss: 25 pts
FLOOR_PTS = 7.0             # Trail activates after 7 pts favorable
TRAIL_PTS = 3.0             # Trail follows 3 pts behind peak
MAX_HOLD_MIN = 2            # Max hold time: 2 minutes (backtest optimized)
MAX_DAILY_LOSS = -300.0     # Kill switch: stop trading after $300 daily loss
MAX_DAILY_TRADES = 30       # Safety cap

ENTRY_START  = dtime(9, 30)   # RTH start (ET)
ENTRY_CUTOFF = dtime(15, 45)  # No new entries after this
EOD_EXIT     = dtime(15, 55)  # Force exit

SL_POLL_SEC = 1              # Check SL every second
COOLDOWN_SEC = 120           # Min seconds between exit and next entry (2 min)
TICK_CROSS_TIMEOUT = 60      # Max seconds to wait for tick_cross confirmation

_log_dir = os.environ.get("BOT_LOG_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs"))
os.makedirs(_log_dir, exist_ok=True)
_log_file = os.path.join(_log_dir, f"fade_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(_log_file, encoding="utf-8"),
    ]
)
log = logging.getLogger("FadeScalp")
log.info(f"Log file: {_log_file}")


# ΓöÇΓöÇ STATE ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

@dataclass
class TradeState:
    in_position: bool = False
    direction: str = ""          # "long" or "short"
    entry_px: float = 0.0
    entry_time: Optional[datetime] = None
    best_px: float = 0.0        # best price in our favor (for trail)
    trail_active: bool = False
    current_stop: float = 0.0

@dataclass
class BotState:
    # Bar building
    bar_open: float = 0.0
    bar_high: float = 0.0
    bar_low: float = float("inf")
    bar_close: float = 0.0
    bar_start: Optional[datetime] = None
    bar_tick_count: int = 0
    last_price: float = 0.0
    # Completed previous bar (for heartbeat comparison)
    prev_bar_open: float = 0.0
    prev_bar_high: float = 0.0
    prev_bar_low: float = 0.0
    prev_bar_close: float = 0.0
    prev_bar_body: float = 0.0
    
    # Trade
    trade: TradeState = field(default_factory=TradeState)
    daily_pnl: float = 0.0
    daily_trades: int = 0
    day: Optional[str] = None
    halted: bool = False
    
    # Tick-cross confirmation
    pending_signal: bool = False
    pending_fade_dir: str = ""
    pending_big_close: float = 0.0
    pending_signal_time: Optional[datetime] = None
    
    # Tracking
    signals_today: int = 0
    wins: int = 0
    losses: int = 0
    last_trade_pnl: float = 0.0
    last_trade_reason: str = ""
    consec_losses: int = 0
    last_exit_time: Optional[datetime] = None


# ΓöÇΓöÇ API CLIENT ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

class TopstepClient:
    def __init__(self, username: str, api_key: str):
        self.username = username
        self.api_key = api_key
        self.jwt_token: Optional[str] = None
        self.account_id: Optional[int] = None
        self.contract_id: Optional[int] = None
        self.http = httpx.Client(timeout=10)

    def authenticate(self):
        resp = self.http.post(f"{API_URL}/api/Auth/loginKey", json={
            "userName": self.username,
            "apiKey": self.api_key,
        })
        resp.raise_for_status()
        data = resp.json()
        if not data.get("success", False):
            raise ValueError(f"Auth failed: {data.get('errorMessage', 'unknown')}")
        self.jwt_token = data["token"]
        log.info("Authenticated with TopstepX")

    def _headers(self):
        return {"Authorization": f"Bearer {self.jwt_token}", "Content-Type": "application/json"}

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
        contract = contracts[0]
        log.info(f"Contract resolved: {name} ΓåÆ id={contract['id']}")
        return contract

    def place_market_order(self, account_id: int, contract_id: int, side: int, qty: int):
        """side: 0=Buy, 1=Sell"""
        payload = {
            "accountId": account_id,
            "contractId": contract_id,
            "type": 2,  # Market
            "side": side,
            "size": qty,
        }
        log.info(f"ORDER REQUEST: {payload}")
        resp = self.http.post(f"{API_URL}/api/Order/place", headers=self._headers(), json=payload)
        resp.raise_for_status()
        result = resp.json()
        if not result.get("success", True):
            log.error(f"ORDER REJECTED: {result}")
        return result

    def get_positions(self, account_id: Optional[int] = None):
        if account_id is None:
            account_id = self.account_id
        resp = self.http.post(f"{API_URL}/api/Position/search", headers=self._headers(),
                             json={"accountId": account_id})
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        return resp.json().get("positions", [])


# ΓöçΓöÉ POSITION HELPERS ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

def _net_position(positions, contract_id):
    """Return net position size across positions for this contract (positive=long, negative=short)."""
    net = 0
    for p in positions:
        if p.get("contractId") != contract_id and p.get("contract_id") != contract_id:
            continue
        qty = int(p.get("qty", 0) or p.get("quantity", 0) or 0)
        side = str(p.get("side", "")).lower()
        if side in ("buy", "long", "0"):
            net += qty
        elif side in ("sell", "short", "1"):
            net -= qty
        else:
            # netPosition field if available
            net_pos = p.get("netPosition") or p.get("netPos") or p.get("position")
            if net_pos is not None:
                net += int(float(net_pos))
    return net


def _is_flat(positions, contract_id):
    return _net_position(positions, contract_id) == 0


# ΓöÇΓöÇ BOT ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

class FadeScalpBot:
    def __init__(self, api_key: str = "", username: str = "", client: Optional[TopstepClient] = None, hub=None, combined_mode: bool = False):
        if client is not None:
            self.client = client
        else:
            self.client = TopstepClient(username, api_key)
        self.state = BotState()
        self._hub = hub  # may be shared with ORB bot
        self._running = False
        self._last_quote_time: float = 0.0
        self._ws_closed = False
        self._combined_mode = combined_mode
        self._external_can_enter = lambda direction: True  # overridden by combined runner

    def setup(self):
        if not getattr(self.client, "jwt_token", None):
            self.client.authenticate()

        # Get accounts ΓÇö same logic as ORB bot
        accounts = self.client.get_accounts()
        if not accounts:
            raise RuntimeError("No active accounts found")

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
            name_filter = os.environ.get("ACCOUNT_NAME_FILTER", "EXPRESS").strip().upper()
            if name_filter:
                matched = [a for a in accounts if name_filter in a.get("name", "").upper()]
                excluded = [a for a in accounts if a not in matched]
                if excluded:
                    log.warning(f"Excluding non-{name_filter} account(s): {sorted(a['id'] for a in excluded)}")
                if not matched:
                    raise RuntimeError(f"No accounts matched ACCOUNT_NAME_FILTER={name_filter!r}")
                accounts = matched

        # Filter out accounts with insufficient balance to avoid partial fills / rejected orders
        min_balance = float(os.environ.get("MIN_ACCOUNT_BALANCE", "50").strip() or "50")
        funded_accounts = [a for a in accounts if a.get("balance", 0) is not None and a.get("balance", 0) >= min_balance]
        underfunded = [a for a in accounts if a not in funded_accounts]
        if underfunded:
            log.warning(f"Excluding underfunded account(s) below ${min_balance}: "
                        f"{[(a['id'], a.get('balance')) for a in underfunded]}")
        if not funded_accounts:
            raise RuntimeError(f"No accounts with balance >= ${min_balance}")
        accounts = funded_accounts

        self.account_ids = [a["id"] for a in accounts]
        self.account_id = self.account_ids[0]
        self.client.account_id = self.account_ids[0]
        for account in accounts:
            log.info(f"Trading account: {account['name']} (id={account['id']})")
            balance = account.get('balance')
            log.info(f"  Balance: ${balance:,.2f}" if balance else "  Balance: N/A")

        # Resolve contract
        contract = self.client.search_contract(CONTRACT_NAME)
        self.client.contract_id = contract["id"]
        log.info(f"Contract: {CONTRACT_NAME} (id={contract['id']})")

        # Reconcile any pre-existing position at startup
        try:
            positions = self.client.get_positions(self.account_id)
            net = _net_position(positions, self.client.contract_id)
            if net != 0:
                direction = "long" if net > 0 else "short"
                # Estimate entry from avg price if available, otherwise last price
                entry_px = 0.0
                for p in positions:
                    if p.get("contractId") == self.client.contract_id or p.get("contract_id") == self.client.contract_id:
                        entry_px = float(p.get("avgPrice") or p.get("avg_entry_price") or p.get("price") or 0)
                        break
                if entry_px <= 0:
                    entry_px = self.state.last_price or 0
                self.state.trade = TradeState(
                    in_position=True,
                    direction=direction,
                    entry_px=entry_px,
                    entry_time=self._now_et(),
                    best_px=entry_px,
                    trail_active=False,
                    current_stop=(entry_px - SL_PTS if direction == "long" else entry_px + SL_PTS),
                )
                self.state.daily_trades += 1
                log.warning(f"RECONCILE: found {net:+d} contract position ({direction.upper()}) @ {entry_px:.2f} — bot will manage existing trade")
            else:
                log.info("Position reconciliation: flat")
        except Exception as e:
            log.warning(f"Position reconciliation failed: {e}")

        log.info(f"Strategy: Fade 1m candles >= {CANDLE_THRESH}pts")
        log.info(f"Exit: SL={SL_PTS} Floor={FLOOR_PTS} Trail={TRAIL_PTS} MaxHold={MAX_HOLD_MIN}min")
        log.info(f"Size: {QTY} MNQ (${DOLLAR_PER_PT}/pt)")

    def _now_et(self) -> datetime:
        return datetime.now(TZ)

    def _check_new_day(self):
        today = str(self._now_et().date())
        if self.state.day != today:
            if self.state.day is not None:
                log.info(f"Day closed: PnL=${self.state.daily_pnl:+.0f} | Trades={self.state.daily_trades} | W={self.state.wins} L={self.state.losses}")
            self.state.day = today
            self.state.daily_pnl = 0.0
            self.state.daily_trades = 0
            self.state.signals_today = 0
            self.state.wins = 0
            self.state.losses = 0
            self.state.halted = False
            self.state.last_exit_time = None
            self.state.bar_start = None
            self.state.bar_tick_count = 0
            self.state.pending_signal = False
            log.info(f"New day: {today}")

    def _is_trading_hours(self) -> bool:
        now = self._now_et()
        return ENTRY_START <= now.time() <= ENTRY_CUTOFF

    def _should_force_exit(self) -> bool:
        return self._now_et().time() >= EOD_EXIT

    def _on_tick(self, price: float):
        """Called on every price update"""
        now = self._now_et()
        self._check_new_day()
        self.state.last_price = price

        # Force EOD exit
        if self.state.trade.in_position and self._should_force_exit():
            log.info(f"EOD EXIT forced at {price:.2f}")
            self._exit_trade(price, "EOD")
            return

        # Manage open position
        if self.state.trade.in_position:
            self._manage_exit(price, now)

        # Tick-cross confirmation: enter when price crosses back past big candle close
        if self.state.pending_signal and not self.state.trade.in_position:
            elapsed = (now - self.state.pending_signal_time).total_seconds() if self.state.pending_signal_time else 999
            if elapsed > TICK_CROSS_TIMEOUT:
                log.info(f"TICK_CROSS timeout ({elapsed:.0f}s) ΓÇö signal expired")
                self.state.pending_signal = False
            else:
                fade_dir = self.state.pending_fade_dir
                big_close = self.state.pending_big_close
                crossed = False
                if fade_dir == "short" and price < big_close:
                    crossed = True
                elif fade_dir == "long" and price > big_close:
                    crossed = True
                if crossed:
                    log.info(f"TICK_CROSS confirmed: px={price:.2f} crossed big_close={big_close:.2f} ΓåÆ ENTER {fade_dir.upper()}")
                    self.state.pending_signal = False
                    self._enter_trade(fade_dir, price)

        # Build 1m bar
        self._update_bar(price, now)

    def _update_bar(self, price: float, now: datetime):
        """Build 1-minute bars from ticks"""
        # Determine current bar start (floor to minute)
        bar_minute = now.replace(second=0, microsecond=0)

        if self.state.bar_start is None or bar_minute > self.state.bar_start:
            # New bar ΓÇö process previous bar first
            if self.state.bar_start is not None and self.state.bar_tick_count > 0:
                self._on_bar_close()
            
            # Start new bar
            self.state.bar_start = bar_minute
            self.state.bar_open = price
            self.state.bar_high = price
            self.state.bar_low = price
            self.state.bar_close = price
            self.state.bar_tick_count = 1
        else:
            # Update current bar
            self.state.bar_high = max(self.state.bar_high, price)
            self.state.bar_low = min(self.state.bar_low, price)
            self.state.bar_close = price
            self.state.bar_tick_count += 1

    def _on_bar_close(self):
        """Called when a 1m bar closes ΓÇö check for signal"""
        bar_open = self.state.bar_open
        bar_close = self.state.bar_close
        body = abs(bar_close - bar_open)

        # Save completed bar for heartbeat logging
        self.state.prev_bar_open = bar_open
        self.state.prev_bar_high = self.state.bar_high
        self.state.prev_bar_low = self.state.bar_low
        self.state.prev_bar_close = bar_close
        self.state.prev_bar_body = body

        if body < CANDLE_THRESH:
            return

        if not self._is_trading_hours():
            return

        if self.state.halted:
            return

        if self.state.trade.in_position:
            return  # already in a trade

        if self.state.daily_trades >= MAX_DAILY_TRADES:
            return

        # Cooldown check
        if self.state.last_exit_time:
            secs_since_exit = (self._now_et() - self.state.last_exit_time).total_seconds()
            if secs_since_exit < COOLDOWN_SEC:
                log.info(f"SIGNAL skipped: cooldown active ({secs_since_exit:.0f}s < {COOLDOWN_SEC}s)")
                return

        # Signal! Determine direction
        candle_dir = "up" if bar_close > bar_open else "down"
        fade_dir = "short" if candle_dir == "up" else "long"

        self.state.signals_today += 1
        log.info(f"SIGNAL #{self.state.signals_today}: {body:.1f}pt {candle_dir.upper()} candle | Bar O={bar_open:.2f} C={bar_close:.2f} | FADE ΓåÆ {fade_dir.upper()} | awaiting tick_cross")

        # Set pending ΓÇö actual entry happens in _on_tick when price crosses back
        self.state.pending_signal = True
        self.state.pending_fade_dir = fade_dir
        self.state.pending_big_close = bar_close
        self.state.pending_signal_time = self._now_et()

    def _enter_trade(self, direction: str, price: float):
        """Enter a fade trade on all funded accounts"""
        if not self._external_can_enter(direction):
            log.info(f"Fade {direction.upper()} entry blocked — opposite-direction position active")
            return
        side = 0 if direction == "long" else 1  # 0=Buy, 1=Sell

        order_results = {}
        def _place(acct_id):
            try:
                order_results[acct_id] = self.client.place_market_order(acct_id, self.client.contract_id, side, QTY)
            except Exception as e:
                order_results[acct_id] = {"error": str(e)}
        threads = [threading.Thread(target=_place, args=(a,)) for a in self.account_ids]
        for t in threads: t.start()
        for t in threads: t.join()
        any_ok = False
        for acct_id, res in order_results.items():
            err = res.get("error") if isinstance(res, dict) else None
            oid = res.get("orderId") if isinstance(res, dict) else None
            if err:
                log.error(f"ORDER FAILED acct {acct_id}: {err}")
            elif oid:
                any_ok = True
                log.info(f"ORDER PLACED acct {acct_id}: {direction.upper()} {QTY} MNQ | orderId={oid}")
            else:
                log.error(f"ORDER REJECTED acct {acct_id}: {res}")
        if not any_ok:
            log.error(f"ENTRY ABORTED ΓÇö no account accepted order")
            return

        # Trust order fills; do not retry position verification (TopstepX position search can 404)

        now = self._now_et()
        self.state.trade = TradeState(
            in_position=True,
            direction=direction,
            entry_px=price,
            entry_time=now,
            best_px=price,
            trail_active=False,
            current_stop=price - SL_PTS if direction == "long" else price + SL_PTS,
        )
        self.state.daily_trades += 1
        big_close = self.state.pending_big_close
        log.info(f"FADE ENTERED {direction.upper()} @ {price:.2f} | crossed_big_close={big_close:.2f} | SL={self.state.trade.current_stop:.2f} | Trade #{self.state.daily_trades}")

    def _manage_exit(self, price: float, now: datetime):
        """Check SL, trailing stop, and max hold"""
        trade = self.state.trade

        # Max hold check
        if trade.entry_time:
            elapsed = (now - trade.entry_time).total_seconds()
            if elapsed > MAX_HOLD_MIN * 60:
                log.info(f"MAX HOLD {MAX_HOLD_MIN}min reached")
                self._exit_trade(price, "TIMEOUT")
                return

        # Update best price
        if trade.direction == "long":
            if price > trade.best_px:
                trade.best_px = price
            
            # Check if floor reached (trail activates)
            favorable = trade.best_px - trade.entry_px
            if not trade.trail_active and favorable >= FLOOR_PTS:
                trade.trail_active = True
                trade.current_stop = trade.best_px - TRAIL_PTS
                log.info(f"TRAIL ACTIVE: floor={FLOOR_PTS:.0f}pts reached | stop={trade.current_stop:.2f}")
            
            # Update trailing stop
            if trade.trail_active:
                new_stop = trade.best_px - TRAIL_PTS
                if new_stop > trade.current_stop:
                    trade.current_stop = new_stop
            
            # Check stop hit
            if price <= trade.current_stop:
                reason = "TRAIL" if trade.trail_active else "SL"
                self._exit_trade(price, reason)
                return

        else:  # short
            if price < trade.best_px:
                trade.best_px = price
            
            favorable = trade.entry_px - trade.best_px
            if not trade.trail_active and favorable >= FLOOR_PTS:
                trade.trail_active = True
                trade.current_stop = trade.best_px + TRAIL_PTS
                log.info(f"TRAIL ACTIVE: floor={FLOOR_PTS:.0f}pts reached | stop={trade.current_stop:.2f}")
            
            if trade.trail_active:
                new_stop = trade.best_px + TRAIL_PTS
                if new_stop < trade.current_stop:
                    trade.current_stop = new_stop
            
            if price >= trade.current_stop:
                reason = "TRAIL" if trade.trail_active else "SL"
                self._exit_trade(price, reason)
                return

    def _exit_trade(self, price: float, reason: str):
        """Exit current position"""
        trade = self.state.trade
        
        # Place exit order on all accounts
        exit_side = 1 if trade.direction == "long" else 0  # opposite side
        order_results = {}
        def _place_exit(acct_id):
            try:
                order_results[acct_id] = self.client.place_market_order(acct_id, self.client.contract_id, exit_side, QTY)
            except Exception as e:
                order_results[acct_id] = {"error": str(e)}
        threads = [threading.Thread(target=_place_exit, args=(a,)) for a in self.account_ids]
        for t in threads: t.start()
        for t in threads: t.join()
        any_ok = any(isinstance(r, dict) and r.get("orderId") for r in order_results.values())
        for acct_id, res in order_results.items():
            err = res.get("error") if isinstance(res, dict) else None
            if err:
                log.critical(f"EXIT FAILED acct {acct_id}: {err} ΓÇö MANUAL INTERVENTION NEEDED")
            else:
                log.info(f"EXIT ORDER acct {acct_id}: orderId={res.get('orderId') if isinstance(res, dict) else res}")
        if not any_ok:
            log.critical(f"EXIT FAILED ALL ACCOUNTS ΓÇö MANUAL INTERVENTION NEEDED")
            return

        # Verify actually flat before resetting state (check all accounts)
        flat_confirmed = False
        for attempt in range(40):
            try:
                all_flat = True
                position_summary = []
                for acct_id in self.account_ids:
                    positions = self.client.get_positions(acct_id)
                    net = _net_position(positions, self.client.contract_id)
                    position_summary.append(f"{acct_id}={net}")
                    if net != 0:
                        all_flat = False
                log.info(f"Flat check attempt {attempt+1}: positions [{', '.join(position_summary)}]")
                if all_flat:
                    flat_confirmed = True
                    log.info("EXIT confirmed: all accounts flat")
                    break
            except Exception as e:
                log.warning(f"Flat check attempt {attempt+1} failed: {e}")
            time.sleep(0.5)
        if not flat_confirmed:
            log.critical(f"EXIT WARNING: broker still shows open position after exit ΓÇö MANUAL INTERVENTION NEEDED")
            # Do not reset trade state; keep managing the position
            return

        # Calculate PnL
        if trade.direction == "long":
            pnl_pts = price - trade.entry_px
        else:
            pnl_pts = trade.entry_px - price
        
        pnl_dollar = pnl_pts * DOLLAR_PER_PT
        self.state.daily_pnl += pnl_dollar

        if pnl_dollar > 0:
            self.state.wins += 1
        else:
            self.state.losses += 1

        hold_sec = 0
        if trade.entry_time:
            hold_sec = (self._now_et() - trade.entry_time).total_seconds()

        log.info(f"FADE EXIT {reason}: {trade.direction.upper()} @ entry={trade.entry_px:.2f} exit={price:.2f} | "
                 f"PnL={pnl_pts:+.1f}pts (${pnl_dollar:+.0f}) | held {hold_sec:.0f}s | "
                 f"Day: ${self.state.daily_pnl:+.0f} W={self.state.wins} L={self.state.losses}")

        # Track last trade
        self.state.last_trade_pnl = pnl_dollar
        self.state.last_trade_reason = reason

        # Consecutive loss tracking
        if pnl_dollar < 0:
            self.state.consec_losses += 1
        else:
            self.state.consec_losses = 0

        # Reset trade state and set cooldown
        self.state.trade = TradeState()
        self.state.last_exit_time = self._now_et()

        # Kill switch (standalone only — combined runner enforces overall daily cap)
        if not self._combined_mode and self.state.daily_pnl <= MAX_DAILY_LOSS:
            self.state.halted = True
            log.warning(f"DAILY LOSS LIMIT HIT: ${self.state.daily_pnl:.0f} <= ${MAX_DAILY_LOSS:.0f} ΓÇö HALTED")

    def _connect_websocket(self):
        """Connect to TopstepX SignalR market data hub"""
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
        self._subscribe_contract(self._hub)

    def _setup_hub_callbacks(self, hub):
        """Attach callbacks to a hub (used for shared hub in combined mode)"""
        hub.on("GatewayQuote", self._on_quote)
        hub.on("GatewayTrade", self._on_quote)
        hub.on("GatewayLogout", self._on_logout)
        hub.on_close(self._on_ws_close)

    def _subscribe_contract(self, hub):
        """Subscribe to MNQ contract quotes and trades on the given hub"""
        cid = self.client.contract_id
        try:
            hub.send("SubscribeContractQuotes", [cid])
            hub.send("SubscribeContractTrades", [cid])
            log.info(f"Subscribed to quotes+trades for {cid}")
        except Exception as e:
            log.warning(f"Subscribe send failed: {e}")

    def _on_ws_close(self):
        log.warning("WebSocket disconnected")
        self._ws_closed = True

    def _on_logout(self, data):
        log.warning(f"GatewayLogout: {data}")
        self._ws_closed = True

    def _on_quote(self, data):
        """Handle incoming quote from SignalR"""
        try:
            # TopstepX sends: ['CON.F.US.MNQ.U26', {quote dict}]
            if isinstance(data, list) and len(data) >= 2 and isinstance(data[1], dict):
                quote = data[1]
            elif isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict):
                quote = data[0]
            elif isinstance(data, dict):
                quote = data
            else:
                return

            price = float(quote.get("lastPrice") or quote.get("last") or quote.get("price") or 0)
            if price > 0:
                self._last_quote_time = time.time()
                self._on_tick(price)
        except Exception as e:
            log.error(f"Quote parse error: {e} | data={str(data)[:200]}")

    def _polling_fallback(self):
        """Fallback: poll REST API for price if WebSocket fails"""
        log.info("Starting REST polling fallback (2s interval)")
        while self._running:
            try:
                resp = self.client.http.post(
                    f"{API_URL}/api/Quote/search",
                    headers=self.client._headers(),
                    json={"contractId": self.client.contract_id},
                    timeout=3
                )
                if resp.status_code == 200:
                    data = resp.json()
                    quotes = data.get("quotes") or data.get("items") or []
                    if quotes:
                        price = float(quotes[0].get("lastPrice") or quotes[0].get("last") or 0)
                        if price > 0:
                            self._last_quote_time = time.time()
                            self._on_tick(price)
            except Exception as e:
                log.error(f"Poll error: {e}")
            time.sleep(SL_POLL_SEC)

    def run(self):
        """Main loop"""
        self.setup()
        self._running = True

        # Try WebSocket first
        self._use_polling = False
        try:
            self._connect_websocket()
            log.info("Running on WebSocket feed")
        except Exception as e:
            log.warning(f"WebSocket failed: {e} ΓÇö using REST polling")
            self._use_polling = True
            poll_thread = threading.Thread(target=self._polling_fallback, daemon=True)
            poll_thread.start()

        log.info("=" * 60)
        log.info("FADE SCALP BOT v2 (tick_cross + optimized)")
        log.info(f"  Signal: 1m candle body >= {CANDLE_THRESH}pts ΓåÆ FADE")
        log.info(f"  Confirm: tick_cross ({TICK_CROSS_TIMEOUT}s timeout)")
        log.info(f"  Exit: SL={SL_PTS} Floor={FLOOR_PTS} Trail={TRAIL_PTS}")
        log.info(f"  Size: {QTY} MNQ | MaxHold={MAX_HOLD_MIN}min | Cooldown={COOLDOWN_SEC}s")
        log.info(f"  Kill switch: ${MAX_DAILY_LOSS}")
        log.info("=" * 60)

        while self._running:
            time.sleep(SL_POLL_SEC)
            now = self._now_et()

            # Heartbeat every 60s
            if int(time.time()) % 60 == 0:
                if self.state.trade.in_position:
                    trade = self.state.trade
                    if trade.direction == "long":
                        upnl = (self.state.last_price - trade.entry_px) * DOLLAR_PER_PT
                    else:
                        upnl = (trade.entry_px - self.state.last_price) * DOLLAR_PER_PT
                    pos_str = f"IN {trade.direction.upper()} @{trade.entry_px:.2f} uPnL=${upnl:+.0f} stop={trade.current_stop:.2f}{'(TRAIL)' if trade.trail_active else ''}"
                else:
                    pos_str = "FLAT"
                last_str = f"lastTrade=${self.state.last_trade_pnl:+.0f}({self.state.last_trade_reason})" if self.state.last_trade_reason else ""
                halted_str = " HALTED" if self.state.halted else ""
                if self._ws_closed:
                    conn_status = "DISCONNECTED"
                elif self._use_polling:
                    conn_status = "POLLING"
                elif self._last_quote_time > 0 and (time.time() - self._last_quote_time) < 15:
                    conn_status = "CONNECTED"
                else:
                    conn_status = "STALE"
                log.info(f"[HEARTBEAT] {conn_status} | px={self.state.last_price:.2f} {pos_str} | dayPnL=${self.state.daily_pnl:+.0f} W={self.state.wins} L={self.state.losses} signals={self.state.signals_today} {last_str}{halted_str}")

            # WS reconnect on stale feed during RTH
            # In combined mode the runner handles reconnect centrally
            if not self._combined_mode:
                is_rth = dtime(9, 0) <= now.time() <= dtime(16, 30)
                if is_rth and self._last_quote_time > 0 and not self._use_polling:
                    secs_since = time.time() - self._last_quote_time
                    if secs_since > 120:
                        log.warning(f"[WS] No quotes for {secs_since:.0f}s ΓÇö reconnecting...")
                        try:
                            self.client.authenticate()
                            self._connect_websocket()
                            self._last_quote_time = time.time()
                            log.info("[WS] Reconnected successfully")
                        except Exception as e:
                            log.error(f"[WS] Reconnect failed: {e} ΓÇö switching to REST polling")
                            self._use_polling = True
                            poll_thread = threading.Thread(target=self._polling_fallback, daemon=True)
                            poll_thread.start()


# ΓöÇΓöÇ MAIN ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

if __name__ == "__main__":
    if len(sys.argv) >= 3:
        api_key = sys.argv[1]
        username = sys.argv[2]
        os.environ["PROJECT_X_API_KEY"] = api_key
        os.environ["PROJECT_X_USERNAME"] = username
    else:
        api_key = os.environ.get("PROJECT_X_API_KEY", "")
        username = os.environ.get("PROJECT_X_USERNAME", "")
        if not api_key or not username:
            print("Usage: py fade_scalp_live.py <API_KEY> <EMAIL>")
            print("  or set PROJECT_X_API_KEY and PROJECT_X_USERNAME env vars")
            sys.exit(1)

    print("=" * 60)
    print("  Fade Scalp Live Bot ΓÇö NQ 1m Big Candle Fade")
    print("  TopstepX REST + SignalR")
    print("=" * 60)

    import signal
    _confirm_exit = [False]

    def _sigint_handler(sig, frame):
        if _confirm_exit[0]:
            print("\n[FADE] Confirmed ΓÇö shutting down.")
            os._exit(0)
        _confirm_exit[0] = True
        print("\n*** Ctrl+C detected ΓÇö press Ctrl+C again within 5 seconds to stop, or wait to continue...")
        def _reset():
            time.sleep(5)
            if _confirm_exit[0]:
                print("[FADE] Continuing...")
                _confirm_exit[0] = False
        threading.Thread(target=_reset, daemon=True).start()

    signal.signal(signal.SIGINT, _sigint_handler)

    while True:
        try:
            bot = FadeScalpBot(api_key, username)
            bot.run()
        except KeyboardInterrupt:
            print("\n[FADE] Keyboard interrupt ΓÇö shutting down.")
            break
        except Exception as e:
            import traceback
            traceback.print_exc()
            log.error(f"[FADE] Crashed: {e} ΓÇö restarting in 15 seconds...")
            time.sleep(15)
