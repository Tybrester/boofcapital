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

function calcRSI(closes: number[], period: number): number[] {
  const rsi: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcMACD(closes: number[], fast: number, slow: number, signal: number): { macdLine: number[], signalLine: number[], hist: number[] } {
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = closes.map((_, i) => (isNaN(emaFast[i]) || isNaN(emaSlow[i])) ? NaN : emaFast[i] - emaSlow[i]);
  const validStart = macdLine.findIndex(v => !isNaN(v));
  const signalLine: number[] = new Array(closes.length).fill(NaN);
  if (validStart >= 0) {
    const validMacd = macdLine.slice(validStart);
    const emaSignal = calcEMA(validMacd, signal);
    for (let i = 0; i < emaSignal.length; i++) signalLine[validStart + i] = emaSignal[i];
  }
  const hist = macdLine.map((v, i) => (isNaN(v) || isNaN(signalLine[i])) ? NaN : v - signalLine[i]);
  return { macdLine, signalLine, hist };
}

function calcBollinger(closes: number[], period: number, stdDev: number): { upper: number[], mid: number[], lower: number[] } {
  const upper: number[] = new Array(closes.length).fill(NaN);
  const mid: number[]   = new Array(closes.length).fill(NaN);
  const lower: number[] = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    mid[i]   = mean;
    upper[i] = mean + stdDev * sd;
    lower[i] = mean - stdDev * sd;
  }
  return { upper, mid, lower };
}

function generateSignalRSIMACD(candles: Candle[]): SignalResult {
  const closes = candles.map(c => c.close);
  const n = closes.length;
  const i = n - 2; // last completed bar

  const rsi  = calcRSI(closes, 14);
  const ema50 = calcEMA(closes, 50);
  const { hist } = calcMACD(closes, 12, 26, 9);

  const curRSI   = rsi[i];
  const curEma   = ema50[i];
  const curHist  = hist[i];
  const curClose = closes[i];

  let inLong = false;
  // Replay state to determine current position (mirror Pine logic)
  for (let j = 50; j <= i; j++) {
    const r = rsi[j], h = hist[j], e = ema50[j], c = closes[j];
    if (isNaN(r) || isNaN(h) || isNaN(e)) continue;
    const buyCond  = (r < 30 || h > 0) && c > e;
    const sellCond = (r > 70 || h < 0) && c < e;
    if (!inLong && buyCond)  inLong = true;
    if (inLong  && sellCond) inLong = false;
  }

  // Check signal on bar i (what just closed)
  const buyCond  = (curRSI < 30 || curHist > 0) && curClose > curEma;
  const sellCond = (curRSI > 70 || curHist < 0) && curClose < curEma;

  let signal: 'buy' | 'sell' | 'none' = 'none';
  let reason = `rsi=${curRSI?.toFixed(1)}, macd_hist=${curHist?.toFixed(4)}, ema=${curEma?.toFixed(2)}, close=${curClose?.toFixed(2)}`;

  if (!inLong && buyCond)  { signal = 'buy';  reason = `RSI+MACD BUY. ${reason}`; }
  if (inLong  && sellCond) { signal = 'sell'; reason = `RSI+MACD SELL. ${reason}`; }

  return { signal, price: curClose, trend: buyCond ? 1 : -1, ema: curEma, adx: curRSI, reason };
}

// ─────────────────────────────────────────────
// FETCH CANDLES  (Polygon.io)
// ─────────────────────────────────────────────

interface Candle { time: number; open: number; high: number; low: number; close: number; }

async function fetchCandles(symbol: string, interval = '1h', bars = 150): Promise<Candle[]> {
  const POLYGON_KEY = Deno.env.get('POLYGON_API_KEY')!;

  // Map interval to Polygon multiplier/timespan
  const intervalMap: Record<string, { multiplier: number; timespan: string; days: number }> = {
    '1m':  { multiplier: 1,  timespan: 'minute', days: 5   },
    '5m':  { multiplier: 5,  timespan: 'minute', days: 10  },
    '10m': { multiplier: 10, timespan: 'minute', days: 15  },
    '15m': { multiplier: 15, timespan: 'minute', days: 20  },
    '30m': { multiplier: 30, timespan: 'minute', days: 30  },
    '45m': { multiplier: 45, timespan: 'minute', days: 45  },
    '1h':  { multiplier: 1,  timespan: 'hour',   days: 60  },
    '2h':  { multiplier: 2,  timespan: 'hour',   days: 120 },
    '4h':  { multiplier: 4,  timespan: 'hour',   days: 180 },
    '1d':  { multiplier: 1,  timespan: 'day',    days: 365 },
  };
  const { multiplier, timespan, days } = intervalMap[interval] ?? intervalMap['1h'];

  // Polygon uses X: prefix for crypto, plain ticker for stocks
  const isCrypto = symbol.endsWith('-USD');
  const polygonTicker = isCrypto
    ? 'X:' + symbol.replace('-USD', 'USD')
    : symbol.replace('.', '-'); // handle BRK.B → BRK-B (already correct)

  const to   = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const fromStr = from.toISOString().split('T')[0];
  const toStr   = to.toISOString().split('T')[0];

  const url = `https://api.polygon.io/v2/aggs/ticker/${polygonTicker}/range/${multiplier}/${timespan}/${fromStr}/${toStr}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_KEY}`;
  const res = await fetch(url);
  const json = await res.json();

  if (!json.results || json.results.length === 0) throw new Error(`No Polygon data for ${symbol} (${json.status}: ${json.error ?? ''})`);

  const candles: Candle[] = json.results.map((r: { t: number; o: number; h: number; l: number; c: number }) => ({
    time: r.t, open: r.o, high: r.h, low: r.l, close: r.c,
  }));
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

  const supabaseGET = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  // GET /portfolio-value?bot_id=xxx — cash + current value of open stock positions
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const botId = url.searchParams.get('bot_id');
    if (!botId) return new Response(JSON.stringify({ error: 'bot_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const { data: bot } = await supabaseGET.from('stock_bots').select('paper_balance').eq('id', botId).single();
    const cash = Number(bot?.paper_balance ?? 100000);

    // Fetch open (filled, no pnl) trades
    const { data: openTrades } = await supabaseGET.from('stock_trades').select('*').eq('bot_id', botId).eq('status', 'filled').is('pnl', null);
    let openValue = 0;
    if (openTrades && openTrades.length > 0) {
      for (const t of openTrades) {
        try {
          const candles = await fetchCandles(t.symbol, '1h', 5);
          const price = candles.length ? candles[candles.length - 1].close : Number(t.price);
          openValue += price * Number(t.quantity);
        } catch (_) { openValue += Number(t.price) * Number(t.quantity); }
      }
    }

    return new Response(JSON.stringify({ cash, open_value: openValue, total: cash + openValue }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Allow cron (no auth header) OR user JWT OR service role key
  const authHeader = req.headers.get('Authorization') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const isCronOrInternal = authHeader === '' || authHeader === `Bearer ${serviceKey}` || authHeader === `Bearer ${anonKey}`;
  if (!isCronOrInternal) {
    // Validate as user JWT — just allow it through, service role client handles data access
    const bearerToken = authHeader.replace('Bearer ', '');
    if (!bearerToken || bearerToken.split('.').length !== 3) {
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
    // Can be triggered by cron OR manually with { bot_id, user_id } in body
    let targetBotId: string | null = null;
    let targetUserId: string | null = null;

    if (req.method === 'POST') {
      try {
        const body = await req.json();
        targetBotId = body.bot_id || body.system_id || null;
        targetUserId = body.user_id || null;
      } catch (_) {}
    }

    // Load all auto-bot enabled stock bots (or just the one requested)
    let query = supabase
      .from('stock_bots')
      .select('*')
      .eq('enabled', true)
      .eq('auto_submit', true);

    if (targetBotId) query = query.eq('id', targetBotId);
    if (targetUserId)   query = query.eq('user_id', targetUserId);

    const { data: bots, error: botErr } = await query;
    if (botErr) throw botErr;
    if (!bots || bots.length === 0) {
      return new Response(JSON.stringify({ message: 'No active stock bots found' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    console.log(`[AutoBot] Found ${bots.length} active stock bots`);

    // ── Symbol lists for scan mode ──────────────────────────────────────────
    const SCAN_STOCKS = [
      // Mega-cap / most liquid
      'AAPL','MSFT','AMZN','NVDA','TSLA','GOOG','GOOGL','META','NFLX','BRK-B',
      'JPM','BAC','WFC','V','MA','PG','KO','PFE','UNH','HD',
      // Tech / consumer
      'INTC','CSCO','ADBE','CRM','ORCL','AMD','QCOM','TXN','IBM','AVGO',
      // Energy / industrial
      'XOM','CVX','BA','CAT','MMM','GE','HON','LMT','NOC','DE',
      // Financial / banking
      'C','GS','MS','AXP','BLK','SCHW','BK','SPGI','ICE',
      // Healthcare / pharma
      'MRK','ABBV','AMGN','BMY','LLY','GILD','JNJ','REGN','VRTX','BIIB',
      // Consumer / retail
      'WMT','COST','TGT','LOW','MCD','SBUX','NKE','BKNG',
      // Communications / internet
      'SNAP','UBER','LYFT','SPOT','ZM','DOCU','PINS','ROKU','SHOP',
      // Misc large caps
      'CVS','TMO','MDT','ISRG','F','GM',
    ];
    // Crypto: all with consistent daily volume > $100M
    const SCAN_CRYPTO = [
      'BTC-USD',   // ~$30B+ daily
      'ETH-USD',   // ~$15B+ daily
      'SOL-USD',   // ~$3B+ daily
      'XRP-USD',   // ~$2B+ daily
      'BNB-USD',   // ~$1B+ daily
      'DOGE-USD',  // ~$1B+ daily
      'ADA-USD',   // ~$500M+ daily
      'AVAX-USD',  // ~$500M+ daily
      'LINK-USD',  // ~$500M+ daily
      'MATIC-USD', // ~$400M+ daily
      'LTC-USD',   // ~$400M+ daily
      'UNI-USD',   // ~$200M+ daily
      'SHIB-USD',  // ~$300M+ daily
      'TON-USD',   // ~$300M+ daily
      'DOT-USD',   // ~$200M+ daily
      'TRX-USD',   // ~$500M+ daily
      'NEAR-USD',  // ~$200M+ daily
      'APT-USD',   // ~$200M+ daily
      'ARB-USD',   // ~$150M+ daily
      'SUI-USD',   // ~$500M+ daily
    ];
    const SCAN_ALL = [...SCAN_STOCKS, ...SCAN_CRYPTO];

    // ── Per-symbol processing helper ─────────────────────────────────────────
    async function processSymbol(bot: Record<string,unknown>, sym: string, settings: BotSettings): Promise<object> {
      try {
        const candles = await fetchCandles(sym, settings.interval, 150);
        if (candles.length < 60) return { bot_id: bot.id, symbol: sym, status: 'skipped', reason: 'Not enough candle data' };

        const overrideSettings = { ...settings, symbol: sym };
        const botSignal = (bot.bot_signal as string) || 'supertrend';
        const { signal, price, trend, ema, adx, reason } = botSignal === 'rsi_macd'
          ? generateSignalRSIMACD(candles)
          : generateSignal(candles, overrideSettings);
        console.log(`[AutoBot] ${sym} → ${signal} | ${reason}`);

        if (signal === 'buy'  && settings.tradeDirection === 'short') return { bot_id: bot.id, symbol: sym, status: 'skipped', reason: 'Direction: short only' };
        if (signal === 'sell' && settings.tradeDirection === 'long')  return { bot_id: bot.id, symbol: sym, status: 'skipped', reason: 'Direction: long only' };

        if (signal === 'none') {
          await supabase.from('stock_bot_logs').insert({ bot_id: bot.id, user_id: bot.user_id, symbol: sym, signal: 'none', price, trend, ema, adx, reason, created_at: new Date().toISOString() });
          return { bot_id: bot.id, symbol: sym, status: 'no_signal', reason };
        }

        // Duplicate check per symbol
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const { data: recentTrades } = await supabase.from('stock_trades').select('action').eq('bot_id', bot.id as string).eq('user_id', bot.user_id as string).eq('symbol', sym).gte('created_at', twoHoursAgo).order('created_at', { ascending: false }).limit(1);
        if (recentTrades && recentTrades.length > 0 && recentTrades[0].action === signal) {
          return { bot_id: bot.id, symbol: sym, status: 'skipped', reason: `Duplicate ${signal} within 2h` };
        }

        let orderId: string | undefined;
        let quantity = Math.max(1, Math.round(settings.dollarAmount / price));
        let tradeStatus = 'filled';
        let brokerError: string | undefined;

        if (bot.broker === 'tastytrade') {
          try {
            const r = await placeTastyOrder(supabase, bot.user_id as string, signal, sym, price, settings.dollarAmount);
            orderId = r.orderId;
            quantity = r.quantity;
          } catch (e) {
            brokerError = String(e);
            tradeStatus = 'failed';
            console.error('[AutoBot] Tastytrade error:', brokerError);
          }
        } else if (bot.broker === 'alpaca') {
          try {
            const alpacaRes = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/alpaca-order`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
              },
              body: JSON.stringify({
                user_id: bot.user_id,
                symbol: sym,
                side: signal === 'buy' ? 'buy' : 'sell',
                notional: settings.dollarAmount,
              }),
            });
            const alpacaJson = await alpacaRes.json();
            if (!alpacaRes.ok || alpacaJson.error) throw new Error(alpacaJson.error || 'Alpaca order failed');
            orderId = alpacaJson.order_id;
            tradeStatus = 'filled';
          } catch (e) {
            brokerError = String(e);
            tradeStatus = 'failed';
            console.error('[AutoBot] Alpaca error:', brokerError);
          }
        } else {
          // Paper trading: update virtual balance
          const tradeValue = quantity * price;
          const { data: botRow } = await supabase.from('stock_bots').select('paper_balance').eq('id', bot.id as string).single();
          const currentBalance = Number(botRow?.paper_balance ?? 100000);
          const newBalance = signal === 'buy'
            ? currentBalance - tradeValue
            : currentBalance + tradeValue;
          await supabase.from('stock_bots').update({ paper_balance: Math.max(0, newBalance) }).eq('id', bot.id as string);
        }

        const { data: trade } = await supabase.from('stock_trades').insert({
          user_id: bot.user_id, bot_id: bot.id, symbol: sym, action: signal,
          quantity, price, order_type: 'market', broker: bot.broker || 'paper', source: 'auto',
          status: tradeStatus, broker_order_id: orderId || null, broker_error: brokerError || null,
          filled_at: tradeStatus === 'filled' ? new Date().toISOString() : null,
          payload: { source: 'auto-bot', scan_mode: bot.bot_scan_mode, reason, trend, ema: ema?.toFixed(2), adx: adx?.toFixed(1) },
          created_at: new Date().toISOString(),
        }).select().single();

        await supabase.from('stock_bot_logs').insert({ bot_id: bot.id, user_id: bot.user_id, symbol: sym, signal, price, trend, ema, adx, reason, trade_id: trade?.id || null, created_at: new Date().toISOString() });

        return { bot_id: bot.id, status: tradeStatus, signal, symbol: sym, price, quantity, order_id: orderId, reason, broker_error: brokerError };
      } catch (err) {
        return { bot_id: bot.id, symbol: sym, status: 'error', error: String(err) };
      }
    }

    // ── Main loop ────────────────────────────────────────────────────────────
    const results: object[] = [];

    for (const bot of bots) {
      const settings: BotSettings = {
        atrLength:      bot.bot_atr_length     ?? 10,
        atrMultiplier:  bot.bot_atr_multiplier ?? 3.0,
        emaLength:      bot.bot_ema_length     ?? 50,
        adxLength:      bot.bot_adx_length     ?? 14,
        adxThreshold:   bot.bot_adx_threshold  ?? 20,
        symbol:         bot.bot_symbol         ?? 'SPY',
        dollarAmount:   bot.bot_dollar_amount  ?? 500,
        interval:       bot.bot_interval       ?? '1h',
        tradeDirection: bot.bot_trade_direction ?? bot.trade_direction ?? 'both',
      };

      const scanMode: string = (bot.bot_scan_mode as string) || 'single';
      console.log(`[AutoBot] Bot "${bot.name}" | mode=${scanMode} | ${settings.interval}`);

      try {
        if (scanMode === 'scan_stocks') {
          // Run all stocks in parallel batches of 10
          for (let i = 0; i < SCAN_STOCKS.length; i += 10) {
            const batch = SCAN_STOCKS.slice(i, i + 10);
            const batchResults = await Promise.all(batch.map(sym => processSymbol(bot, sym, settings)));
            results.push(...batchResults);
          }
        } else if (scanMode === 'scan_crypto') {
          for (let i = 0; i < SCAN_CRYPTO.length; i += 10) {
            const batch = SCAN_CRYPTO.slice(i, i + 10);
            const batchResults = await Promise.all(batch.map(sym => processSymbol(bot, sym, settings)));
            results.push(...batchResults);
          }
        } else if (scanMode === 'scan_all') {
          for (let i = 0; i < SCAN_ALL.length; i += 10) {
            const batch = SCAN_ALL.slice(i, i + 10);
            const batchResults = await Promise.all(batch.map(sym => processSymbol(bot, sym, settings)));
            results.push(...batchResults);
          }
        } else {
          // Single symbol mode
          const r = await processSymbol(bot, settings.symbol, settings);
          results.push(r);
        }
      } catch (err) {
        console.error(`[AutoBot] Error on bot ${bot.id}:`, err);
        results.push({ bot_id: bot.id, status: 'error', error: String(err) });
      }
    }

    console.log(`[AutoBot] Processed ${results.length} results:`, results);

    return new Response(JSON.stringify({ processed: results.length, results }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
