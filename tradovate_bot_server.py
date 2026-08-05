#!/usr/bin/env python3
"""
TopstepX Bot Control Server — MULTI-TENANT
--------------------------------------------
Always-on Flask service that the BoofCapital dashboard talks to directly
(NOT through Supabase — Supabase Edge Functions can't hold a long-running
process or WebSocket connection, which the futures bot needs all day).

Each logged-in dashboard user gets their own isolated bot subprocess, runtime
config file, and log stream, keyed by their Supabase user id (`userId`) — so
many people can run the bot at once from the same server without stepping on
each other. TopstepX issues one username + API key per trading account, not
per platform, so each user submits their OWN username and API key from the
dashboard — this server never needs its own.

Deploy this once, anywhere reachable by everyone's browser (a small VPS,
Railway, Render, etc. — NOT your laptop, or it stops working when your PC is
off/asleep):

    pip install flask flask-cors
    python tradovate_bot_server.py

Then point the dashboard's RUNNER_URL (in dashboard.html) at that deployment's
public URL instead of http://localhost:8787.

Endpoints (all take/return JSON; userId is required on every call):
  POST /api/start      {userId, username, apiKey, baseSymbol, baseQty, lossSymbol, lossQty}
  POST /api/stop       {userId}
  POST /api/set-config {userId, baseSymbol, baseQty, lossSymbol, lossQty}  (live update, no restart)
  GET  /api/status?userId=...
  GET  /api/stream?userId=...  (Server-Sent Events — live stdout/stderr for that user's bot)
"""

import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone

import httpx
from flask import Flask, Response, jsonify, request
from flask_cors import CORS

TOPSTEP_API_URL = os.environ.get("PROJECT_X_API_URL", "https://api.topstepx.com")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Bot scripts — keyed by botType sent from the dashboard.
# Each user can run one instance of each type simultaneously.
BOT_SCRIPTS = {
    "orb": os.path.join(BASE_DIR, "boof_futures_live.py"),
    "fade": os.path.join(BASE_DIR, "fade_scalp_live.py"),
    "combined": os.path.join(BASE_DIR, "combined_runner.py"),
}
DEFAULT_BOT_TYPE = "orb"

# Per-user runtime config files live here — one JSON file per userId so
# concurrent users' live qty/symbol updates never collide.
RUNTIME_CONFIG_DIR = os.path.join(BASE_DIR, "bot_runtime_configs")
os.makedirs(RUNTIME_CONFIG_DIR, exist_ok=True)
MAX_HISTORY = 500

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": [
    "https://boofcapital.com", "https://www.boofcapital.com",
    "http://localhost:3000", "http://127.0.0.1:5500",
    "http://localhost:5500", "http://127.0.0.1:3000",
    # Local dev preview tooling (e.g. IDE proxy ports) — origin varies per
    # session, so allow any localhost/127.0.0.1 port during local testing.
    re.compile(r"^https?://(localhost|127\.0\.0\.1):\d+$"),
]}})

# Optional fallback only — used if a user leaves their own username/API key
# blank (e.g. for the operator's own testing). Real users provide their own
# via the dashboard, since TopstepX issues these per trading account.
PX_USERNAME = os.environ.get("PROJECT_X_USERNAME", "")
PX_API_KEY  = os.environ.get("PROJECT_X_API_KEY", "")

# ── Per-user session state ──────────────────────────────────────────────────
# _sessions[user_id] = {
#   "process": subprocess.Popen | None,
#   "started_at": float | None,
#   "log_lines": [str, ...],
#   "log_lock": threading.Lock,
#   "subscribers": [queue.Queue, ...],
# }
_sessions_lock = threading.Lock()
_sessions = {}


def _safe_filename(user_id: str) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in user_id)


def _session_key(user_id: str, bot_type: str) -> str:
    return f"{user_id}:{bot_type}"


def _config_path(user_id: str, bot_type: str = "orb") -> str:
    return os.path.join(RUNTIME_CONFIG_DIR, f"{_safe_filename(user_id)}_{bot_type}.json")


def _get_session(user_id: str, bot_type: str = "orb") -> dict:
    key = _session_key(user_id, bot_type)
    with _sessions_lock:
        sess = _sessions.get(key)
        if sess is None:
            sess = {
                "process": None,
                "started_at": None,
                "log_lines": [],
                "log_lock": threading.Lock(),
                "subscribers": [],
            }
            _sessions[key] = sess
        return sess


def _broadcast(sess: dict, line: str):
    with sess["log_lock"]:
        sess["log_lines"].append(line)
        if len(sess["log_lines"]) > MAX_HISTORY:
            del sess["log_lines"][: len(sess["log_lines"]) - MAX_HISTORY]
        dead = []
        for q in sess["subscribers"]:
            try:
                q.put_nowait(line)
            except queue.Full:
                dead.append(q)
        for q in dead:
            sess["subscribers"].remove(q)


def _reader(sess: dict, proc: subprocess.Popen):
    for raw in iter(proc.stdout.readline, b""):
        try:
            line = raw.decode("utf-8", errors="replace").rstrip("\n")
        except Exception:
            line = str(raw)
        if line:
            _broadcast(sess, line)
    _broadcast(sess, "[server] Bot process exited.")
    sess["process"] = None


def _require_user_id(source) -> tuple:
    """Returns (user_id, error_response_or_None)."""
    user_id = source.get("userId")
    if not user_id or not isinstance(user_id, str):
        return None, (jsonify({"error": "Missing required field: userId"}), 400)
    return user_id, None


@app.route("/api/start", methods=["POST", "OPTIONS"])
def start_bot():
    if request.method == "OPTIONS":
        return ("", 204)
    body = request.get_json(force=True, silent=True) or {}

    user_id, err = _require_user_id(body)
    if err:
        return err

    bot_type = body.get("botType", DEFAULT_BOT_TYPE)
    if bot_type not in BOT_SCRIPTS:
        return jsonify({"error": f"Unknown botType: {bot_type}. Valid: {list(BOT_SCRIPTS.keys())}"}), 400

    # TopstepX issues one username + API key per trading account (much
    # simpler than Tradovate's 5-credential model) — each user submits their
    # own from the dashboard. Only fall back to the runner's own env vars
    # (useful for the operator's personal testing) if left blank.
    user_username = body.get("username") or PX_USERNAME
    user_api_key  = body.get("apiKey") or PX_API_KEY
    if not user_username or not user_api_key:
        return jsonify({"error": "Missing TopstepX credentials: username and API key are required (from TopstepX \u2192 Settings \u2192 API Keys)."}), 400

    sess = _get_session(user_id, bot_type)

    with _sessions_lock:
        if sess["process"] is not None and sess["process"].poll() is None:
            return jsonify({"error": f"{bot_type.upper()} bot is already running. Stop it first."}), 409

        try:
            base_qty = max(1, int(body.get("baseQty", 1)))
        except (TypeError, ValueError):
            base_qty = 1
        try:
            loss_qty = max(1, int(body.get("lossQty", base_qty)))
        except (TypeError, ValueError):
            loss_qty = base_qty
        base_symbol = body.get("baseSymbol") if body.get("baseSymbol") in ("NQ", "MNQ") else "MNQ"
        loss_symbol = body.get("lossSymbol") if body.get("lossSymbol") in ("NQ", "MNQ") else base_symbol

        env = dict(os.environ)
        env["PROJECT_X_USERNAME"] = user_username
        env["PROJECT_X_API_KEY"]  = user_api_key
        env["PYTHONUNBUFFERED"]   = "1"
        # Tell the bot process which per-user config file to poll.
        env["BOT_RUNTIME_CONFIG_PATH"] = _config_path(user_id, bot_type)
        # NQ is $20/pt vs MNQ $2/pt, so the daily cap must scale with notional.
        if bot_type == "combined" and "HARD_DAILY_LOSS_CAP" not in env:
            env["HARD_DAILY_LOSS_CAP"] = "1000" if base_symbol == "NQ" else "650"

        try:
            with open(_config_path(user_id, bot_type), "w") as f:
                json.dump({
                    "baseSymbol": base_symbol, "baseQty": base_qty,
                    "lossSymbol": loss_symbol, "lossQty": loss_qty,
                }, f)
        except Exception:
            pass

        bot_script = BOT_SCRIPTS[bot_type]
        try:
            proc = subprocess.Popen(
                [sys.executable, bot_script],
                cwd=BASE_DIR,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
            )
        except Exception as e:
            return jsonify({"error": f"Failed to launch {bot_type} bot: {e}"}), 500

        sess["process"] = proc
        sess["started_at"] = time.time()
        with sess["log_lock"]:
            sess["log_lines"].clear()
        _broadcast(sess, f"[server] {bot_type.upper()} bot started pid={proc.pid}")

        t = threading.Thread(target=_reader, args=(sess, proc), daemon=True)
        t.start()

    return jsonify({"status": "started", "botType": bot_type, "pid": proc.pid})


@app.route("/api/stop", methods=["POST", "OPTIONS"])
def stop_bot():
    if request.method == "OPTIONS":
        return ("", 204)
    body = request.get_json(force=True, silent=True) or {}
    user_id, err = _require_user_id(body)
    if err:
        return err

    bot_type = body.get("botType", DEFAULT_BOT_TYPE)
    sess = _get_session(user_id, bot_type)
    proc = sess["process"]
    if proc is None or proc.poll() is not None:
        return jsonify({"status": "not_running"})
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    sess["process"] = None
    _broadcast(sess, f"[server] {bot_type.upper()} bot stopped by user.")
    return jsonify({"status": "stopped", "botType": bot_type})


@app.route("/api/set-config", methods=["POST", "OPTIONS"])
def set_config():
    if request.method == "OPTIONS":
        return ("", 204)
    body = request.get_json(force=True, silent=True) or {}
    user_id, err = _require_user_id(body)
    if err:
        return err

    bot_type = body.get("botType", DEFAULT_BOT_TYPE)
    base_symbol = body.get("baseSymbol")
    loss_symbol = body.get("lossSymbol")
    if base_symbol not in ("NQ", "MNQ") or loss_symbol not in ("NQ", "MNQ"):
        return jsonify({"error": "baseSymbol and lossSymbol must each be 'NQ' or 'MNQ'"}), 400
    try:
        base_qty = int(body.get("baseQty"))
        loss_qty = int(body.get("lossQty"))
    except (TypeError, ValueError):
        return jsonify({"error": "baseQty and lossQty must be integers"}), 400
    if base_qty < 1 or loss_qty < 1:
        return jsonify({"error": "baseQty and lossQty must be at least 1"}), 400

    try:
        with open(_config_path(user_id, bot_type), "w") as f:
            json.dump({
                "baseSymbol": base_symbol, "baseQty": base_qty,
                "lossSymbol": loss_symbol, "lossQty": loss_qty,
            }, f)
    except Exception as e:
        return jsonify({"error": f"Failed to write config: {e}"}), 500
    sess = _get_session(user_id, bot_type)
    _broadcast(sess, f"[server] Config updated: base={base_qty}x{base_symbol} loss={loss_qty}x{loss_symbol}")
    return jsonify({
        "status": "ok",
        "baseSymbol": base_symbol, "baseQty": base_qty,
        "lossSymbol": loss_symbol, "lossQty": loss_qty,
    })


@app.route("/", methods=["GET"])
@app.route("/health", methods=["GET"])
def health():
    # No userId required — meant for external uptime pingers (e.g. UptimeRobot)
    # to keep this free-tier Render service from spinning down mid-trade.
    return jsonify({"status": "ok"})


@app.route("/api/account-info", methods=["POST", "OPTIONS"])
def account_info():
    """Fetch TopstepX account balance(s) + recent trade history on demand.

    Stateless — takes the user's own username/API key directly from the
    request each time (same credentials as /api/start), does a fresh login,
    and returns account balances plus recent fills. Does not require the bot
    to be running.
    """
    if request.method == "OPTIONS":
        return ("", 204)
    body = request.get_json(force=True, silent=True) or {}
    username = body.get("username")
    api_key = body.get("apiKey")
    if not username or not api_key:
        return jsonify({"error": "Missing TopstepX credentials: username and API key are required."}), 400

    try:
        client = httpx.Client(timeout=10)
        resp = client.post(f"{TOPSTEP_API_URL}/api/Auth/loginKey", json={
            "userName": username, "apiKey": api_key,
        })
        data = resp.json()
    except Exception as e:
        return jsonify({"error": f"Could not reach TopstepX: {e}"}), 502

    if not data.get("success", False):
        return jsonify({"error": data.get("errorMessage") or "TopstepX authentication failed"}), 401

    token = data.get("token")
    if not token:
        return jsonify({"error": "TopstepX authentication succeeded but no token received"}), 502
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    try:
        accts_resp = client.post(f"{TOPSTEP_API_URL}/api/Account/search", headers=headers,
                                  json={"onlyActiveAccounts": True})
        accounts = accts_resp.json().get("accounts") or []
    except Exception as e:
        return jsonify({"error": f"Failed to fetch accounts: {e}"}), 502

    end = datetime.now(timezone.utc)
    start = end - timedelta(days=7)
    all_trades = []
    for acct in accounts:
        acct_id = acct.get("id")
        try:
            tr_resp = client.post(f"{TOPSTEP_API_URL}/api/Trade/search", headers=headers, json={
                "accountId": acct_id,
                "startTimestamp": start.isoformat(),
                "endTimestamp": end.isoformat(),
            })
            trades = tr_resp.json().get("trades") or []
            for t in trades:
                t["accountName"] = acct.get("name")
            all_trades.extend(trades)
        except Exception:
            pass

    all_trades.sort(key=lambda t: t.get("creationTimestamp", ""), reverse=True)

    return jsonify({
        "accounts": [{
            "id": a.get("id"), "name": a.get("name"), "balance": a.get("balance"),
            "canTrade": a.get("canTrade"), "simulated": a.get("simulated"),
        } for a in accounts],
        "trades": all_trades[:50],
    })


@app.route("/api/status", methods=["GET"])
def status():
    user_id, err = _require_user_id(request.args)
    if err:
        return err
    bot_type = request.args.get("botType", DEFAULT_BOT_TYPE)
    sess = _get_session(user_id, bot_type)
    proc = sess["process"]
    running = proc is not None and proc.poll() is None
    pid = proc.pid if running else None
    started_at = sess["started_at"] if running else None
    return jsonify({"running": running, "pid": pid, "started_at": started_at, "botType": bot_type})


@app.route("/api/stream", methods=["GET"])
def stream():
    user_id, err = _require_user_id(request.args)
    if err:
        return err
    bot_type = request.args.get("botType", DEFAULT_BOT_TYPE)
    sess = _get_session(user_id, bot_type)

    q = queue.Queue(maxsize=1000)
    with sess["log_lock"]:
        for line in sess["log_lines"]:
            q.put_nowait(line)
        sess["subscribers"].append(q)

    def gen():
        try:
            while True:
                try:
                    line = q.get(timeout=15)
                    yield f"data: {json.dumps(line)}\n\n"
                except queue.Empty:
                    yield ": keepalive\n\n"
        finally:
            with sess["log_lock"]:
                if q in sess["subscribers"]:
                    sess["subscribers"].remove(q)

    return Response(gen(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8787))
    print(f"Tradovate bot control server (multi-tenant) on http://0.0.0.0:{port}")
    print(f"Bot scripts: {BOT_SCRIPTS}")
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
