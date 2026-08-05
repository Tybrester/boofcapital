"""
Levels Live Bot — NQ Prior-Day High/Low + Asia-Session Range Breakout
TopstepX via REST API + SignalR WebSocket (designed to share a hub/client
with boof_futures_live.BoofBot and fade_scalp_live.FadeScalpBot via
combined_runner.py, same as the Fade bot does).

Strategy (backtested on 148 days of real NQ tick data):
  A) Prior-day RTH high/low breakout   | 108 trades | WR 66.7% | PF 1.41 | +$2,644
  C) Asia session (18:00-00:00 ET) range breakout | 185 trades | WR 65.9% | PF 1.28 | +$3,432
  One entry per level per day (first fresh tick-cross during RTH). Only one
  position at a time across both levels combined.

Risk management (identical to live ORB config for consistency):
  ATR-based SL: 0.5x ATR(14) on 1m bars, capped at 20pts
  Trail: activates after +8pts favorable, trails 5pts behind peak
  EOD forced flat at 15:55 ET

Position size: 5 MNQ ($2/pt) — matches ORB and Fade live config.

Usage (standalone):
  py levels_live.py "YOUR_API_KEY" "your@email.com"
Usage (combined): imported and driven by combined_runner.py
"""

import json
import os
import sys
import logging
import time
import threading
from datetime import datetime, time as dtime, timedelta, date as dtdate
from zoneinfo import ZoneInfo
from typing import Optional
from dataclasses import dataclass, field

from signalrcore.hub_connection_builder import HubConnectionBuilder

TZ = ZoneInfo("America/New_York")
UTC = ZoneInfo("UTC")

# Runtime config (from dashboard / Render server)
_SYMBOL_MAP = {"MNQ": "MNQU26", "NQ": "NQU26"}
_MV_MAP     = {"MNQ": 2, "NQ": 20}
_runtime_cfg = {}
_cfg_path = os.environ.get("BOT_RUNTIME_CONFIG_PATH", "")
if _cfg_path and os.path.isfile(_cfg_path):
    try:
        with open(_cfg_path) as _f:
            _runtime_cfg = json.load(_f)
    except Exception:
        pass

API_URL = "https://api.topstepx.com"
MARKET_HUB = "wss://rtc.topstepx.com/hubs/market"

CONTRACT_NAME = _SYMBOL_MAP.get(_runtime_cfg.get("baseSymbol", ""), "MNQU26")
QTY = _runtime_cfg.get("baseQty", 5)
MV = _MV_MAP.get(_runtime_cfg.get("baseSymbol", ""), 2)
DOLLAR_PER_PT = QTY * MV

ATR_MULT = 0.5
ATR_PERIOD = 14
ATR_CAP = 20.0
TRAIL_ACTIVATE = 15.0
TRAIL = 10.0

ENTRY_START = dtime(9, 30)
ENTRY_CUTOFF = dtime(15, 50)
EOD_EXIT = dtime(15, 55)

_log_dir = os.environ.get("BOT_LOG_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs"))
os.makedirs(_log_dir, exist_ok=True)
_log_file = os.path.join(_log_dir, f"levels_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[logging.StreamHandler(), logging.FileHandler(_log_file, encoding="utf-8")],
)
log = logging.getLogger("LevelsBot")
log.info(f"Log file: {_log_file}")


@dataclass
class LevelsState:
    day: Optional[str] = None
    prior_high: float = 0.0
    prior_low: float = 0.0
    asia_high: float = 0.0
    asia_low: float = 0.0
    levels_ready: bool = False
    fired: set = field(default_factory=set)  # level names already entered today
    last_price: float = 0.0
    in_position: bool = False
    direction: str = ""
    entry_px: float = 0.0
    best_excursion: float = 0.0
    atr_sl: float = 0.0
    active_qty: int = 0
    active_account_qty: dict = field(default_factory=dict)
    daily_pnl: float = 0.0
    daily_trades: int = 0
    wins: int = 0
    losses: int = 0
    entry_in_progress: bool = False
    exit_in_progress: bool = False
    _trail_logged: bool = False


def _net_position(positions, contract_id):
    net = 0
    for p in positions:
        if p.get("contractId") != contract_id and p.get("contract_id") != contract_id:
            continue
        qty = int(p.get("size") or p.get("quantity") or p.get("qty") or 0)
        side = str(p.get("side", "")).lower()
        if side in ("buy", "long", "0"):
            net += qty
        elif side in ("sell", "short", "1"):
            net -= qty
        else:
            net_pos = p.get("netPosition") or p.get("netPos") or p.get("position")
            if net_pos is not None:
                net += int(float(net_pos))
    return net


def _prev_calendar_day(d: dtdate) -> dtdate:
    return d - timedelta(days=1)


def _prev_business_day(d: dtdate) -> dtdate:
    d = d - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


class LevelsBot:
    def __init__(self, api_key: str = "", username: str = "", client=None, hub=None, combined_mode: bool = False):
        if client is not None:
            self.client = client
        else:
            from boof_futures_live import TopstepClient
            self.client = TopstepClient(username, api_key)
        self.state = LevelsState()
        self._hub = hub
        self._running = False
        self._last_quote_time: float = 0.0
        self._ws_closed = False
        self._combined_mode = combined_mode
        self._external_can_enter = lambda direction: True
        self.account_ids: list = []
        self.account_id: Optional[int] = None
        self.contract_id: Optional[int] = None

    # ── SETUP ────────────────────────────────────────────────────────────

    def setup(self):
        if not getattr(self.client, "jwt_token", None):
            self.client.authenticate()

        accounts = self.client.get_accounts()
        if not accounts:
            raise RuntimeError("No active accounts found")

        allowlist_raw = os.environ.get("TRADE_ACCOUNT_IDS", "").strip()
        if allowlist_raw:
            allowlist = {int(x.strip()) for x in allowlist_raw.split(",") if x.strip()}
            accounts = [a for a in accounts if a["id"] in allowlist]
        else:
            name_filter = os.environ.get("ACCOUNT_NAME_FILTER", "EXPRESS").strip().upper()
            if name_filter:
                accounts = [a for a in accounts if name_filter in a.get("name", "").upper()]
        if not accounts:
            raise RuntimeError("No accounts matched account filter")

        min_balance = float(os.environ.get("MIN_ACCOUNT_BALANCE", "50").strip() or "50")
        accounts = [a for a in accounts if (a.get("balance") or 0) >= min_balance]
        if not accounts:
            raise RuntimeError(f"No accounts with balance >= ${min_balance}")

        self.account_ids = [a["id"] for a in accounts]
        self.account_id = self.account_ids[0]
        for account in accounts:
            log.info(f"Trading account: {account['name']} (id={account['id']})")

        contract = self.client.search_contract(CONTRACT_NAME)
        self.contract_id = contract["id"]
        log.info(f"Contract: {CONTRACT_NAME} (id={contract['id']})")

        # Reconcile any pre-existing position at startup
        try:
            positions = self.client.get_positions(self.account_id)
            net = _net_position(positions, self.contract_id)
            if net != 0:
                direction = "long" if net > 0 else "short"
                entry_px = 0.0
                for p in positions:
                    if p.get("contractId") == self.contract_id or p.get("contract_id") == self.contract_id:
                        entry_px = float(p.get("avgPrice") or p.get("avg_entry_price") or p.get("price") or 0)
                        break
                self.state.in_position = True
                self.state.direction = direction
                self.state.entry_px = entry_px or self.state.last_price
                self.state.best_excursion = self.state.entry_px
                self.state.active_qty = abs(net)
                self.state.daily_trades += 1
                log.warning(f"RECONCILE: found {net:+d} contract position ({direction.upper()}) @ {self.state.entry_px:.2f}")
            else:
                log.info("Position reconciliation: flat")
        except Exception as e:
            log.warning(f"Position reconciliation failed: {e}")

        self._refresh_levels(force=True)
        log.info(f"Strategy: Prior-Day H/L + Asia-Range breakout | ATR SL 0.5x cap {ATR_CAP:.0f} | "
                 f"Trail activate {TRAIL_ACTIVATE:.0f}/trail {TRAIL:.0f} | Size {QTY} MNQ")

    # ── LEVEL COMPUTATION ────────────────────────────────────────────────

    def _fetch_bars(self, start_et: datetime, end_et: datetime, unit_number: int = 5):
        try:
            start_utc = start_et.astimezone(UTC)
            end_utc = end_et.astimezone(UTC)
            resp = self.client.http.post(f"{API_URL}/api/History/retrieveBars", headers=self.client._headers(), json={
                "contractId": self.contract_id,
                "live": False,
                "startTime": start_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "endTime": end_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "unit": 3,
                "unitNumber": unit_number,
                "limit": 2000,
                "includePartialBar": True,
            }, timeout=15)
            if resp.status_code == 200:
                return resp.json().get("bars") or []
        except Exception as e:
            log.warning(f"_fetch_bars failed: {e}")
        return []

    @staticmethod
    def _range_from_bars(bars):
        highs, lows = [], []
        for b in bars:
            h = float(b.get("h") or b.get("high") or 0)
            l = float(b.get("l") or b.get("low") or 0)
            if h > 0:
                highs.append(h)
            if l > 0:
                lows.append(l)
        if not highs or not lows:
            return None, None
        return max(highs), min(lows)

    def _refresh_levels(self, force: bool = False):
        """Compute today's Prior-Day RTH H/L and Asia-Range H/L via REST history."""
        today = datetime.now(TZ).date()
        if not force and self.state.day == str(today) and self.state.levels_ready:
            return

        # Prior-day RTH high/low: walk back up to 5 business days to find data.
        prior_high = prior_low = None
        d = today
        for _ in range(5):
            d = _prev_business_day(d)
            start_et = datetime.combine(d, ENTRY_START, tzinfo=TZ)
            end_et = datetime.combine(d, EOD_EXIT, tzinfo=TZ)
            bars = self._fetch_bars(start_et, end_et)
            prior_high, prior_low = self._range_from_bars(bars)
            if prior_high is not None:
                break

        # Asia session range: yesterday 18:00 ET -> today 00:00 ET (calendar day, not business day)
        asia_high = asia_low = None
        d = today
        for _ in range(4):
            asia_start_day = _prev_calendar_day(d)
            start_et = datetime.combine(asia_start_day, dtime(18, 0), tzinfo=TZ)
            end_et = datetime.combine(d, dtime(0, 0), tzinfo=TZ)
            bars = self._fetch_bars(start_et, end_et)
            asia_high, asia_low = self._range_from_bars(bars)
            if asia_high is not None:
                break
            d = asia_start_day

        if prior_high is None or asia_high is None:
            log.warning(f"Level refresh incomplete — prior={prior_high}/{prior_low} asia={asia_high}/{asia_low}")

        self.state.prior_high = prior_high or 0.0
        self.state.prior_low = prior_low or 0.0
        self.state.asia_high = asia_high or 0.0
        self.state.asia_low = asia_low or 0.0
        self.state.levels_ready = bool(prior_high and asia_high)
        self.state.day = str(today)
        self.state.fired = set()
        log.info(f"LEVELS for {today}: PriorDay H={self.state.prior_high:.2f} L={self.state.prior_low:.2f} | "
                 f"Asia H={self.state.asia_high:.2f} L={self.state.asia_low:.2f}")

    # ── TICK HANDLING ────────────────────────────────────────────────────

    def _now_et(self) -> datetime:
        return datetime.now(TZ)

    def _check_new_day(self):
        today = str(self._now_et().date())
        if self.state.day != today:
            if self.state.day is not None:
                log.info(f"Day closed: PnL=${self.state.daily_pnl:+.0f} | Trades={self.state.daily_trades} | "
                         f"W={self.state.wins} L={self.state.losses}")
            self.state.daily_pnl = 0.0
            self.state.daily_trades = 0
            self.state.wins = 0
            self.state.losses = 0
            self._refresh_levels(force=True)

    def _is_trading_hours(self) -> bool:
        now = self._now_et()
        return now.weekday() < 5 and ENTRY_START <= now.time() <= ENTRY_CUTOFF

    def _should_force_exit(self) -> bool:
        return self._now_et().time() >= EOD_EXIT

    def _on_tick(self, price: float):
        now = self._now_et()
        self._check_new_day()
        prev_price = self.state.last_price
        self.state.last_price = price

        if self.state.in_position and self._should_force_exit():
            self._exit_trade(price, "EOD")
            return

        if self.state.in_position:
            self._manage_exit(price)
            return  # only one position at a time; skip new-entry checks while in a trade

        if not self.state.levels_ready or not self._is_trading_hours() or prev_price <= 0:
            return

        candidates = [
            ("prior_high", "long", self.state.prior_high),
            ("prior_low", "short", self.state.prior_low),
            ("asia_high", "long", self.state.asia_high),
            ("asia_low", "short", self.state.asia_low),
        ]
        for name, direction, level in candidates:
            if not level or name in self.state.fired:
                continue
            crossed = (direction == "long" and prev_price <= level < price) or \
                      (direction == "short" and prev_price >= level > price)
            if crossed:
                log.info(f"LEVEL CROSS: {name}={level:.2f} px={price:.2f} -> {direction.upper()} breakout")
                self.state.fired.add(name)
                self._enter_trade(direction, price, name)
                break

    # ── ENTRY / EXIT ─────────────────────────────────────────────────────

    def _enter_trade(self, direction: str, price: float, level_name: str):
        if not self._external_can_enter(direction):
            log.info(f"Levels {direction.upper()} entry blocked — opposite-direction position active")
            return
        if self.state.entry_in_progress:
            return
        self.state.entry_in_progress = True
        try:
            side = 0 if direction == "long" else 1
            order_results = {}

            def _place(acct_id):
                try:
                    order_results[acct_id] = self.client.place_market_order(acct_id, self.contract_id, side, QTY)
                except Exception as e:
                    order_results[acct_id] = {"error": str(e)}

            threads = [threading.Thread(target=_place, args=(a,)) for a in self.account_ids]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            successful = {}
            for acct_id, res in order_results.items():
                oid = res.get("orderId") if isinstance(res, dict) else None
                err = res.get("error") if isinstance(res, dict) else None
                if err:
                    log.error(f"LEVELS entry order failed acct {acct_id}: {err}")
                elif oid:
                    successful[acct_id] = QTY
                    log.info(f"LEVELS entry order placed acct {acct_id}: {direction.upper()} {QTY} MNQ | orderId={oid}")
                else:
                    log.error(f"LEVELS entry order rejected acct {acct_id}: {res}")
            if not successful:
                log.critical("LEVELS entry aborted — no account accepted the order")
                return

            self.state.active_account_qty = successful
            self.state.active_qty = QTY

            # ATR-based SL from recent 1m bars
            self.state.atr_sl = 0.0
            try:
                bars_1m = self.client.get_history_1m(self.contract_id, units_back=ATR_PERIOD + 5) \
                    if hasattr(self.client, "get_history_1m") else []
                bars_1m = sorted(bars_1m, key=lambda b: b.get("t") or b.get("timestamp") or b.get("time") or "")
                if len(bars_1m) >= ATR_PERIOD + 1:
                    highs = [float(b["high"]) for b in bars_1m]
                    lows = [float(b["low"]) for b in bars_1m]
                    closes = [float(b["close"]) for b in bars_1m]
                    trs = []
                    for k in range(1, len(bars_1m)):
                        tr = max(highs[k] - lows[k], abs(highs[k] - closes[k - 1]), abs(lows[k] - closes[k - 1]))
                        trs.append(tr)
                    atr = sum(trs[-ATR_PERIOD:]) / ATR_PERIOD
                    self.state.atr_sl = min(round(ATR_MULT * atr, 2), ATR_CAP)
                    log.info(f"LEVELS ATR({ATR_PERIOD})={atr:.2f} => SL={self.state.atr_sl:.2f}pt")
            except Exception as e:
                log.warning(f"LEVELS ATR calc failed: {e} — using fixed cap SL")
            if self.state.atr_sl <= 0:
                self.state.atr_sl = ATR_CAP

            self.state.in_position = True
            self.state.direction = direction
            self.state.entry_px = price
            self.state.best_excursion = price
            self.state.daily_trades += 1
            self.state._trail_logged = False
            log.info(f"LEVELS ENTERED {direction.upper()} ({level_name}) @ {price:.2f} | SL_dist={self.state.atr_sl:.2f} "
                     f"| Trade #{self.state.daily_trades}")
        finally:
            self.state.entry_in_progress = False

    def _manage_exit(self, price: float):
        st = self.state
        if st.direction == "long":
            if price > st.best_excursion:
                st.best_excursion = price
            sl_px = st.entry_px - st.atr_sl
            trail_active = st.best_excursion >= st.entry_px + TRAIL_ACTIVATE
            trail_stop = st.best_excursion - TRAIL
            if trail_active and not st._trail_logged:
                log.info(f"LEVELS TRAIL ACTIVE LONG | best={st.best_excursion:.2f} stop={trail_stop:.2f}")
                st._trail_logged = True
            if price <= sl_px:
                self._exit_trade(price, "SL")
            elif trail_active and price <= trail_stop:
                self._exit_trade(price, "TRAIL")
        else:
            if st.best_excursion == 0.0 or price < st.best_excursion:
                st.best_excursion = price
            sl_px = st.entry_px + st.atr_sl
            trail_active = st.best_excursion <= st.entry_px - TRAIL_ACTIVATE
            trail_stop = st.best_excursion + TRAIL
            if trail_active and not st._trail_logged:
                log.info(f"LEVELS TRAIL ACTIVE SHORT | best={st.best_excursion:.2f} stop={trail_stop:.2f}")
                st._trail_logged = True
            if price >= sl_px:
                self._exit_trade(price, "SL")
            elif trail_active and price >= trail_stop:
                self._exit_trade(price, "TRAIL")

    def _exit_trade(self, price: float, reason: str):
        st = self.state
        if not st.in_position or st.exit_in_progress:
            return
        st.exit_in_progress = True
        try:
            side = 1 if st.direction == "long" else 0
            targets = dict(st.active_account_qty) if st.active_account_qty else {a: st.active_qty for a in self.account_ids}
            order_results = {}

            def _place_exit(acct_id, qty):
                try:
                    order_results[acct_id] = self.client.place_market_order(acct_id, self.contract_id, side, qty)
                except Exception as e:
                    order_results[acct_id] = {"error": str(e)}

            threads = [threading.Thread(target=_place_exit, args=(a, q)) for a, q in targets.items()]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            any_ok = any(isinstance(r, dict) and r.get("orderId") for r in order_results.values())
            for acct_id, res in order_results.items():
                err = res.get("error") if isinstance(res, dict) else None
                if err:
                    log.critical(f"LEVELS EXIT FAILED acct {acct_id}: {err} — MANUAL INTERVENTION NEEDED")
            if not any_ok:
                log.critical("LEVELS EXIT FAILED ALL ACCOUNTS — MANUAL INTERVENTION NEEDED")
                return

            flat_confirmed = False
            for attempt in range(40):
                try:
                    all_flat = True
                    for acct_id in self.account_ids:
                        positions = self.client.get_positions(acct_id)
                        if _net_position(positions, self.contract_id) != 0:
                            all_flat = False
                            break
                    if all_flat:
                        flat_confirmed = True
                        break
                except Exception:
                    pass
                time.sleep(0.5)
            if not flat_confirmed:
                log.critical("LEVELS EXIT WARNING: broker still shows open position — MANUAL INTERVENTION NEEDED")
                return

            pnl_pts = (price - st.entry_px) if st.direction == "long" else (st.entry_px - price)
            pnl_dollar = pnl_pts * DOLLAR_PER_PT
            st.daily_pnl += pnl_dollar
            if pnl_dollar > 0:
                st.wins += 1
            else:
                st.losses += 1
            log.info(f"LEVELS EXIT {reason}: {st.direction.upper()} entry={st.entry_px:.2f} exit={price:.2f} | "
                     f"PnL={pnl_pts:+.1f}pts (${pnl_dollar:+.0f}) | Day: ${st.daily_pnl:+.0f} W={st.wins} L={st.losses}")

            st.in_position = False
            st.direction = ""
            st.entry_px = 0.0
            st.best_excursion = 0.0
            st.atr_sl = 0.0
            st.active_account_qty = {}
            st._trail_logged = False
        finally:
            st.exit_in_progress = False

    # ── WEBSOCKET (standalone mode only; combined mode shares hub) ──────

    def _connect_websocket(self):
        if self._combined_mode:
            return
        hub_url = f"{MARKET_HUB}?access_token={self.client.jwt_token}"
        self._hub = HubConnectionBuilder().with_url(hub_url).build()
        self._setup_hub_callbacks(self._hub)
        self._hub.start()
        time.sleep(2)
        self._subscribe_contract(self._hub)

    def _setup_hub_callbacks(self, hub):
        hub.on("GatewayQuote", self._on_quote)
        hub.on("GatewayTrade", self._on_quote)
        hub.on("GatewayLogout", self._on_logout)
        hub.on_close(self._on_ws_close)

    def _subscribe_contract(self, hub):
        try:
            hub.send("SubscribeContractQuotes", [self.contract_id])
            hub.send("SubscribeContractTrades", [self.contract_id])
            log.info(f"Subscribed to quotes+trades for {self.contract_id}")
        except Exception as e:
            log.warning(f"Subscribe send failed: {e}")

    def _on_ws_close(self):
        log.warning("WebSocket disconnected")
        self._ws_closed = True

    def _on_logout(self, data):
        log.warning(f"GatewayLogout: {data}")
        self._ws_closed = True

    def _on_quote(self, data):
        try:
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

    def run(self):
        self.setup()
        self._running = True
        if not self._combined_mode:
            self._connect_websocket()
        while self._running:
            time.sleep(1)
