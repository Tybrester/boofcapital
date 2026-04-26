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
// FETCH CANDLES  (Polygon.io)
// ─────────────────────────────────────────────

interface Candle { time: number; open: number; high: number; low: number; close: number; }

async function fetchCandles(symbol: string, interval = '1h', bars = 150): Promise<Candle[]> {
  const POLYGON_KEY = Deno.env.get('POLYGON_API_KEY')!;

  // Map interval to Polygon multiplier/timespan
  const intervalMap: Record<string, { multiplier: number; timespan: string; days: number }> = {
    '1m':  { multiplier: 1,  timespan: 'minute', days: 5   },
    '5m':  { multiplier: 5,  timespan: 'minute', days: 10  },
    '15m': { multiplier: 15, timespan: 'minute', days: 20  },
    '30m': { multiplier: 30, timespan: 'minute', days: 30  },
    '1h':  { multiplier: 1,  timespan: 'hour',   days: 60  },
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
    // Can be triggered by cron OR manually with { system_id, user_id } in body
    let targetSystemId: string | null = null;
    let targetUserId: string | null = null;

    if (req.method === 'POST') {
      try {
        const body = await req.json();
        targetSystemId = body.system_id || null;
        targetUserId = body.user_id || null;
      } catch (_) {}
    }

    // Load all auto-bot enabled systems (or just the one requested)
    let query = supabase
      .from('systems')
      .select('*')
      .eq('enabled', true)
      .eq('auto_submit', true)
      .eq('bot_mode', 'auto');

    if (targetSystemId) query = query.eq('id', targetSystemId);
    if (targetUserId)   query = query.eq('user_id', targetUserId);

    const { data: systems, error: sysErr } = await query;
    if (sysErr) throw sysErr;
    if (!systems || systems.length === 0) {
      return new Response(JSON.stringify({ message: 'No active auto-bot systems found' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── Symbol lists for scan mode ──────────────────────────────────────────
    // SP500 representative (~200 largest) + NQ100
    const SCAN_STOCKS = [
      // NQ100 core
      'QQQ','AAPL','MSFT','NVDA','AMZN','META','TSLA','GOOGL','GOOG','AVGO',
      'COST','NFLX','AMD','ADBE','QCOM','LIN','TXN','INTU','ISRG','AMGN',
      'CMCSA','PEP','HON','VRTX','REGN','PANW','KLAC','LRCX','SNPS','CDNS',
      'MRVL','ASML','ABNB','CRWD','FTNT','DXCM','CEG','MRNA','IDXX','BIIB',
      'CSGP','TTWO','ILMN','WBD','ZS','SIRI','DLTR','FANG','FAST','PCAR',
      // SP500 large caps
      'SPY','V','MA','JPM','UNH','JNJ','WMT','XOM','BAC','PG',
      'HD','CVX','MRK','ABBV','KO','PFE','LLY','TMO','MCD','ACN',
      'DHR','NEE','ABT','ORCL','CRM','WFC','BMY','MS','GS','RTX',
      'CAT','UPS','NOW','SPGI','AXP','BLK','DE','MMM','GE','SCHW',
      'C','CB','TJX','SYK','ZTS','ADI','MDLZ','GILD','CI','BDX',
      'USB','PLD','MO','EOG','DUK','SO','ICE','ITW','CME','PNC',
      'AON','HCA','CL','FDX','EMR','EW','PSA','NSC','D','APD',
      'BSX','MCO','ROP','TGT','REGN','SHW','TFC','AIG','MET','ADP',
      'WELL','ELV','MCHP','F','GM','UBER','LYFT','ABNB','DASH','RBLX',
      'PLTR','COIN','HOOD','SOFI','SQ','PYPL','SHOP','SNOW','DDOG','NET',
      'ZM','ROKU','TWLO','U','PATH','AI','GTLB','MDB','CFLT','BILL',
      'ARM','SMCI','ANET','ONTO','AMBA','ALGN','PODD','AXNX','TMDX','CELH',
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
    async function processSymbol(system: Record<string,unknown>, sym: string, settings: BotSettings): Promise<object> {
      try {
        const candles = await fetchCandles(sym, settings.interval, 150);
        if (candles.length < 60) return { system_id: system.id, symbol: sym, status: 'skipped', reason: 'Not enough candle data' };

        const overrideSettings = { ...settings, symbol: sym };
        const { signal, price, trend, ema, adx, reason } = generateSignal(candles, overrideSettings);
        console.log(`[AutoBot] ${sym} → ${signal} | ${reason}`);

        if (signal === 'buy'  && settings.tradeDirection === 'short') return { system_id: system.id, symbol: sym, status: 'skipped', reason: 'Direction: short only' };
        if (signal === 'sell' && settings.tradeDirection === 'long')  return { system_id: system.id, symbol: sym, status: 'skipped', reason: 'Direction: long only' };

        if (signal === 'none') {
          await supabase.from('bot_logs').insert({ system_id: system.id, user_id: system.user_id, symbol: sym, signal: 'none', price, trend, ema, adx, reason, created_at: new Date().toISOString() });
          return { system_id: system.id, symbol: sym, status: 'no_signal', reason };
        }

        // Duplicate check per symbol
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const { data: recentTrades } = await supabase.from('trades').select('action').eq('system_id', system.id as string).eq('user_id', system.user_id as string).eq('symbol', sym).gte('created_at', twoHoursAgo).order('created_at', { ascending: false }).limit(1);
        if (recentTrades && recentTrades.length > 0 && recentTrades[0].action === signal) {
          return { system_id: system.id, symbol: sym, status: 'skipped', reason: `Duplicate ${signal} within 2h` };
        }

        let orderId: string | undefined;
        let quantity = Math.max(1, Math.round(settings.dollarAmount / price));
        let tradeStatus = 'filled';
        let brokerError: string | undefined;

        if (system.broker === 'tastytrade') {
          try {
            const r = await placeTastyOrder(supabase, system.user_id as string, signal, sym, price, settings.dollarAmount);
            orderId = r.orderId;
            quantity = r.quantity;
          } catch (e) {
            brokerError = String(e);
            tradeStatus = 'failed';
            console.error('[AutoBot] Tastytrade error:', brokerError);
          }
        } else {
          // Paper trading: update virtual balance
          const tradeValue = quantity * price;
          const { data: sysRow } = await supabase.from('systems').select('paper_balance').eq('id', system.id as string).single();
          const currentBalance = Number(sysRow?.paper_balance ?? 150000);
          const newBalance = signal === 'buy'
            ? currentBalance - tradeValue
            : currentBalance + tradeValue;
          await supabase.from('systems').update({ paper_balance: Math.max(0, newBalance) }).eq('id', system.id as string);
        }

        const { data: trade } = await supabase.from('trades').insert({
          user_id: system.user_id, system_id: system.id, symbol: sym, action: signal,
          quantity, price, order_type: 'market', broker: system.broker || 'paper',
          status: tradeStatus, broker_order_id: orderId || null, broker_error: brokerError || null,
          filled_at: tradeStatus === 'filled' ? new Date().toISOString() : null,
          payload: { source: 'auto-bot', scan_mode: system.bot_scan_mode, reason, trend, ema: ema?.toFixed(2), adx: adx?.toFixed(1) },
          created_at: new Date().toISOString(),
        }).select().single();

        await supabase.from('bot_logs').insert({ system_id: system.id, user_id: system.user_id, symbol: sym, signal, price, trend, ema, adx, reason, trade_id: trade?.id || null, created_at: new Date().toISOString() });

        return { system_id: system.id, status: tradeStatus, signal, symbol: sym, price, quantity, order_id: orderId, reason, broker_error: brokerError };
      } catch (err) {
        return { system_id: system.id, symbol: sym, status: 'error', error: String(err) };
      }
    }

    // ── Main loop ────────────────────────────────────────────────────────────
    const results: object[] = [];

    for (const system of systems) {
      const settings: BotSettings = {
        atrLength:      system.bot_atr_length     ?? 10,
        atrMultiplier:  system.bot_atr_multiplier ?? 3.0,
        emaLength:      system.bot_ema_length     ?? 50,
        adxLength:      system.bot_adx_length     ?? 14,
        adxThreshold:   system.bot_adx_threshold  ?? 20,
        symbol:         system.bot_symbol         ?? 'SPY',
        dollarAmount:   system.bot_dollar_amount  ?? 500,
        interval:       system.bot_interval       ?? '1h',
        tradeDirection: system.bot_trade_direction ?? system.trade_direction ?? 'both',
      };

      const scanMode: string = (system.bot_scan_mode as string) || 'single';
      console.log(`[AutoBot] System "${system.name}" | mode=${scanMode} | ${settings.interval}`);

      try {
        if (scanMode === 'scan_stocks') {
          // Run all stocks in parallel batches of 10
          for (let i = 0; i < SCAN_STOCKS.length; i += 10) {
            const batch = SCAN_STOCKS.slice(i, i + 10);
            const batchResults = await Promise.all(batch.map(sym => processSymbol(system, sym, settings)));
            results.push(...batchResults);
          }
        } else if (scanMode === 'scan_crypto') {
          for (let i = 0; i < SCAN_CRYPTO.length; i += 10) {
            const batch = SCAN_CRYPTO.slice(i, i + 10);
            const batchResults = await Promise.all(batch.map(sym => processSymbol(system, sym, settings)));
            results.push(...batchResults);
          }
        } else if (scanMode === 'scan_all') {
          for (let i = 0; i < SCAN_ALL.length; i += 10) {
            const batch = SCAN_ALL.slice(i, i + 10);
            const batchResults = await Promise.all(batch.map(sym => processSymbol(system, sym, settings)));
            results.push(...batchResults);
          }
        } else {
          // Single symbol mode
          const r = await processSymbol(system, settings.symbol, settings);
          results.push(r);
        }
      } catch (err) {
        console.error(`[AutoBot] Error on system ${system.id}:`, err);
        results.push({ system_id: system.id, status: 'error', error: String(err) });
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
