import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ─────────────────────────────────────────────
// INDICATOR MATH
// ─────────────────────────────────────────────

function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = new Array(values.length).fill(NaN);
  // Find first valid index
  let start = period - 1;
  result[start] = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = start + 1; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function calcATR(highs: number[], lows: number[], closes: number[], period: number): number[] {
  const tr: number[] = [highs[0] - lows[0]];
  for (let i = 1; i < highs.length; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  // Wilder's smoothing (RMA)
  const atr: number[] = new Array(highs.length).fill(NaN);
  atr[period - 1] = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < highs.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

function calcSuperTrend(
  highs: number[], lows: number[], closes: number[],
  atrPeriod: number, multiplier: number
): { trend: number[], upper: number[], lower: number[] } {
  const hl2 = highs.map((h, i) => (h + lows[i]) / 2);
  const atr = calcATR(highs, lows, closes, atrPeriod);

  const upper: number[] = new Array(highs.length).fill(NaN);
  const lower: number[] = new Array(highs.length).fill(NaN);
  const trend: number[] = new Array(highs.length).fill(1);

  for (let i = atrPeriod; i < highs.length; i++) {
    const basicUpper = hl2[i] + multiplier * atr[i];
    const basicLower = hl2[i] - multiplier * atr[i];

    upper[i] = (isNaN(upper[i - 1]) || basicUpper < upper[i - 1] || closes[i - 1] > upper[i - 1])
      ? basicUpper : upper[i - 1];

    lower[i] = (isNaN(lower[i - 1]) || basicLower > lower[i - 1] || closes[i - 1] < lower[i - 1])
      ? basicLower : lower[i - 1];

    if (closes[i] > upper[i - 1]) {
      trend[i] = 1;
    } else if (closes[i] < lower[i - 1]) {
      trend[i] = -1;
    } else {
      trend[i] = trend[i - 1];
    }
  }
  return { trend, upper, lower };
}

function calcDMI(
  highs: number[], lows: number[], closes: number[], period: number
): { plusDI: number[], minusDI: number[], adx: number[] } {
  const n = highs.length;
  const plusDM: number[] = new Array(n).fill(0);
  const minusDM: number[] = new Array(n).fill(0);
  const tr: number[] = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }

  // Wilder smoothing
  const smoothTR: number[] = new Array(n).fill(NaN);
  const smoothPlus: number[] = new Array(n).fill(NaN);
  const smoothMinus: number[] = new Array(n).fill(NaN);

  smoothTR[period] = tr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  smoothPlus[period] = plusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);
  smoothMinus[period] = minusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);

  for (let i = period + 1; i < n; i++) {
    smoothTR[i] = smoothTR[i - 1] - smoothTR[i - 1] / period + tr[i];
    smoothPlus[i] = smoothPlus[i - 1] - smoothPlus[i - 1] / period + plusDM[i];
    smoothMinus[i] = smoothMinus[i - 1] - smoothMinus[i - 1] / period + minusDM[i];
  }

  const plusDI: number[] = new Array(n).fill(NaN);
  const minusDI: number[] = new Array(n).fill(NaN);
  const dx: number[] = new Array(n).fill(NaN);
  const adx: number[] = new Array(n).fill(NaN);

  for (let i = period; i < n; i++) {
    plusDI[i] = (smoothPlus[i] / smoothTR[i]) * 100;
    minusDI[i] = (smoothMinus[i] / smoothTR[i]) * 100;
    dx[i] = Math.abs(plusDI[i] - minusDI[i]) / (plusDI[i] + minusDI[i]) * 100;
  }

  // ADX = EMA of DX (Wilder)
  const start2 = period * 2 - 1;
  const validDx = dx.slice(period, start2 + 1).filter(v => !isNaN(v));
  if (validDx.length === period) {
    adx[start2] = validDx.reduce((a, b) => a + b, 0) / period;
    for (let i = start2 + 1; i < n; i++) {
      adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
    }
  }

  return { plusDI, minusDI, adx };
}

// ─────────────────────────────────────────────
// FETCH CANDLES  (Yahoo Finance 1h)
// ─────────────────────────────────────────────

interface Candle { time: number; open: number; high: number; low: number; close: number; }

async function fetchCandles(symbol: string, interval = '1h', bars = 100): Promise<Candle[]> {
  const rangeMap: Record<string, string> = {
    '1m': '5d', '5m': '60d', '15m': '60d', '30m': '60d',
    '1h': '60d', '4h': '730d', '1d': '730d',
  };
  const range = rangeMap[interval] || '60d';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${symbol}`);
  const ts: number[] = result.timestamp;
  const q = result.indicators.quote[0];
  const candles: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null) continue;
    candles.push({
      time: ts[i], open: q.open[i], high: q.high[i],
      low: q.low[i], close: q.close[i],
    });
  }
  return candles.slice(-bars);
}

// ─────────────────────────────────────────────
// SIGNAL GENERATION
// ─────────────────────────────────────────────

interface SignalResult {
  signal: 'buy' | 'sell' | 'none';
  price: number;
  trend: number;
  ema: number;
  adx: number;
  reason: string;
}

function generateSignal(candles: Candle[], settings: BotSettings): SignalResult {
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const n = closes.length;

  const emaArr = calcEMA(closes, settings.emaLength);
  const { trend } = calcSuperTrend(highs, lows, closes, settings.atrLength, settings.atrMultiplier);
  const { adx } = calcDMI(highs, lows, closes, settings.adxLength);

  // Current (last completed bar = n-2, n-1 is the forming bar)
  const i = n - 2;
  const prevTrend = trend[i - 1];
  const curTrend  = trend[i];
  const curEma    = emaArr[i];
  const curAdx    = adx[i];
  const curClose  = closes[i];

  const longOK  = curTrend === 1  && curClose > curEma && curAdx > settings.adxThreshold;
  const shortOK = curTrend === -1 && curClose < curEma && curAdx > settings.adxThreshold;

  // Only signal on NEW trend crossover (trend just changed this bar)
  const trendJustFlipped = curTrend !== prevTrend;

  let signal: 'buy' | 'sell' | 'none' = 'none';
  let reason = `trend=${curTrend}, close=${curClose.toFixed(2)}, ema=${curEma.toFixed(2)}, adx=${curAdx?.toFixed(1)}`;

  if (trendJustFlipped && longOK) {
    signal = 'buy';
    reason = `SuperTrend flipped UP. ${reason}`;
  } else if (trendJustFlipped && shortOK) {
    signal = 'sell';
    reason = `SuperTrend flipped DOWN. ${reason}`;
  }

  return { signal, price: curClose, trend: curTrend, ema: curEma, adx: curAdx, reason };
}

// ─────────────────────────────────────────────
// TASTYTRADE ORDER PLACEMENT
// ─────────────────────────────────────────────

interface BotSettings {
  atrLength: number;
  atrMultiplier: number;
  emaLength: number;
  adxLength: number;
  adxThreshold: number;
  symbol: string;
  dollarAmount: number;
  interval: string;
  tradeDirection: string;
}

async function placeTastyOrder(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  action: 'buy' | 'sell',
  symbol: string,
  price: number,
  dollarAmount: number
) {
  const { data: credRow } = await supabase
    .from('broker_credentials')
    .select('credentials')
    .eq('user_id', userId)
    .eq('broker', 'tastytrade')
    .maybeSingle();

  if (!credRow?.credentials) throw new Error('No Tastytrade credentials found');

  const { username, password, remember_token } = credRow.credentials;
  let sessionToken: string = credRow.credentials.session_token;
  let accountNumber: string = credRow.credentials.account_number;
  let sessionValid = false;

  // Try existing session
  if (sessionToken) {
    try {
      const testRes = await fetch('https://api.tastytrade.com/customers/me/accounts', {
        headers: { Authorization: sessionToken }
      });
      if (testRes.ok) {
        const tj = await testRes.json();
        if (tj?.data?.items?.[0]?.account?.['account-number']) {
          sessionValid = true;
          accountNumber = tj.data.items[0].account['account-number'];
        }
      }
    } catch (_) { sessionValid = false; }
  }

  // Re-authenticate if needed
  if (!sessionValid) {
    const sessRes = await fetch('https://api.tastytrade.com/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        remember_token
          ? { login: username, password, 'remember-me': true, 'remember-token': remember_token }
          : { login: username, password, 'remember-me': true }
      )
    });
    const sessJson = await sessRes.json();
    sessionToken = sessJson?.data?.['session-token'];
    if (!sessionToken) throw new Error('Tastytrade auth failed');

    const acctRes = await fetch('https://api.tastytrade.com/customers/me/accounts', {
      headers: { Authorization: sessionToken }
    });
    const acctJson = await acctRes.json();
    accountNumber = acctJson?.data?.items?.[0]?.account?.['account-number'];
    if (!accountNumber) throw new Error('No account number found');

    await supabase.from('broker_credentials').update({
      credentials: { ...credRow.credentials, session_token: sessionToken, account_number: accountNumber, session_created_at: new Date().toISOString() }
    }).eq('user_id', userId).eq('broker', 'tastytrade');
  }

  // Calculate quantity from dollar amount
  const quantity = Math.max(1, Math.round(dollarAmount / price));
  const orderAction = action === 'buy' ? 'Buy to Open' : 'Sell to Close';

  const orderRes = await fetch(`https://api.tastytrade.com/accounts/${accountNumber}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: sessionToken },
    body: JSON.stringify({
      'order-type': 'Market',
      'time-in-force': 'Day',
      legs: [{ 'instrument-type': 'Equity', symbol, quantity, action: orderAction }]
    })
  });

  const orderJson = await orderRes.json();
  console.log('[AutoBot] Order response:', JSON.stringify(orderJson));
  return { orderId: orderJson?.data?.order?.id, quantity, orderJson };
}

// ─────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const authHeader = req.headers.get('Authorization') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const isCronOrInternal = authHeader === '' || authHeader === `Bearer ${serviceKey}` || authHeader === `Bearer ${anonKey}`;
  if (!isCronOrInternal) {
    const token = authHeader.replace('Bearer ', '');
    if (!token || token.split('.').length !== 3) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  try {
    let targetBotId: string | null = null;
    let targetUserId: string | null = null;
    if (req.method === 'POST') {
      try { const b = await req.json(); targetBotId = b.bot_id || null; targetUserId = b.user_id || null; } catch (_) {}
    }

    // ── Load bots (fully separate from systems table) ────────────────────────
    let q = supabase.from('bots').select('*').eq('enabled', true);
    if (targetBotId)  q = q.eq('id', targetBotId);
    if (targetUserId) q = q.eq('user_id', targetUserId);
    const { data: bots, error: botsErr } = await q;
    if (botsErr) throw botsErr;
    if (!bots || bots.length === 0) {
      return new Response(JSON.stringify({ message: 'No active bots found' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── Symbol scan lists ────────────────────────────────────────────────────
    const SCAN_STOCKS = [
      'SPY','QQQ','AAPL','MSFT','NVDA','TSLA','AMZN','GOOGL','META','NFLX',
      'AMD','INTC','AVGO','ORCL','CRM','ADBE','PYPL','SQ','SHOP','UBER',
      'DIS','BA','JPM','GS','BAC','WFC','V','MA','BRK-B','UNH',
      'XOM','CVX','PFE','JNJ','KO','PEP','WMT','TGT','COST','HD',
      'T','VZ','CSCO','IBM','MU','QCOM','TXN','ARM','PLTR','COIN',
    ];
    const SCAN_CRYPTO = [
      'BTC-USD','ETH-USD','SOL-USD','BNB-USD','XRP-USD','ADA-USD','AVAX-USD',
      'DOGE-USD','DOT-USD','MATIC-USD','LINK-USD','UNI-USD','LTC-USD',
      'ATOM-USD','ICP-USD','FIL-USD','APT-USD','ARB-USD','OP-USD','INJ-USD',
    ];
    const SCAN_ALL = [...SCAN_STOCKS, ...SCAN_CRYPTO];

    // ── Per-symbol helper ────────────────────────────────────────────────────
    async function processSymbol(bot: Record<string,unknown>, sym: string, settings: BotSettings): Promise<object> {
      try {
        const candles = await fetchCandles(sym, settings.interval, 150);
        if (candles.length < 60) return { bot_id: bot.id, symbol: sym, status: 'skipped', reason: 'Not enough candle data' };

        const { signal, price, trend, ema, adx, reason } = generateSignal(candles, { ...settings, symbol: sym });
        console.log(`[AutoBot] ${sym} → ${signal} | ${reason}`);

        if (signal === 'buy'  && settings.tradeDirection === 'short') return { bot_id: bot.id, symbol: sym, status: 'skipped', reason: 'Direction: short only' };
        if (signal === 'sell' && settings.tradeDirection === 'long')  return { bot_id: bot.id, symbol: sym, status: 'skipped', reason: 'Direction: long only' };
        if (signal === 'none') return { bot_id: bot.id, symbol: sym, status: 'no_signal', reason };

        // Duplicate check in bot_trades
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const { data: recent } = await supabase.from('bot_trades').select('action').eq('bot_id', bot.id as string).eq('symbol', sym).gte('created_at', twoHoursAgo).order('created_at', { ascending: false }).limit(1);
        if (recent?.length && recent[0].action === signal) return { bot_id: bot.id, symbol: sym, status: 'skipped', reason: `Duplicate ${signal} within 2h` };

        let orderId: string | undefined;
        let quantity = Math.max(1, Math.round(settings.dollarAmount / price));
        let tradeStatus = 'open';
        let brokerError: string | undefined;

        if (bot.broker === 'tastytrade') {
          try {
            const r = await placeTastyOrder(supabase, bot.user_id as string, signal, sym, price, settings.dollarAmount);
            orderId = r.orderId; quantity = r.quantity; tradeStatus = 'open';
          } catch (e) {
            brokerError = String(e); tradeStatus = 'failed';
            console.error('[AutoBot] Tastytrade error:', brokerError);
          }
        }

        await supabase.from('bot_trades').insert({
          bot_id: bot.id, user_id: bot.user_id, symbol: sym, action: signal,
          quantity, entry_price: price, status: tradeStatus,
          broker: bot.broker || 'paper', broker_order_id: orderId || null, broker_error: brokerError || null,
          signal_reason: reason, trend, ema, adx, created_at: new Date().toISOString(),
        });

        return { bot_id: bot.id, status: tradeStatus, signal, symbol: sym, price, quantity, order_id: orderId, reason, broker_error: brokerError };
      } catch (err) {
        return { bot_id: bot.id, symbol: sym, status: 'error', error: String(err) };
      }
    }

    // ── Main loop ────────────────────────────────────────────────────────────
    const results: object[] = [];

    for (const bot of bots) {
      const settings: BotSettings = {
        atrLength:      bot.atr_length     ?? 10,
        atrMultiplier:  bot.atr_multiplier ?? 3.0,
        emaLength:      bot.ema_length     ?? 50,
        adxLength:      bot.adx_length     ?? 14,
        adxThreshold:   bot.adx_threshold  ?? 20,
        symbol:         bot.symbol         ?? 'SPY',
        dollarAmount:   bot.dollar_amount  ?? 500,
        interval:       bot.interval       ?? '1h',
        tradeDirection: bot.trade_direction ?? 'both',
      };
      const scanMode: string = (bot.scan_mode as string) || 'single';
      console.log(`[AutoBot] Bot "${bot.name}" | scan=${scanMode} | ${settings.interval}`);

      try {
        const symList = scanMode === 'scan_stocks' ? SCAN_STOCKS
                      : scanMode === 'scan_crypto' ? SCAN_CRYPTO
                      : scanMode === 'scan_all'    ? SCAN_ALL
                      : [settings.symbol];

        for (let i = 0; i < symList.length; i += 10) {
          const batch = symList.slice(i, i + 10);
          const batchResults = await Promise.all(batch.map(sym => processSymbol(bot, sym, settings)));
          results.push(...batchResults);
        }
      } catch (err) {
        console.error(`[AutoBot] Error on bot ${bot.id}:`, err);
        results.push({ bot_id: bot.id, status: 'error', error: String(err) });
      }
    }

    return new Response(JSON.stringify({ processed: results.length, results }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
