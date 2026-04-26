import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ─────────────────────────────────────────────
// MATH HELPERS
// ─────────────────────────────────────────────

function calcEMA(data: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema = new Array(data.length).fill(0);
  ema[0] = data[0];
  for (let i = 1; i < data.length; i++) ema[i] = data[i] * k + ema[i - 1] * (1 - k);
  return ema;
}

function calcATR(highs: number[], lows: number[], closes: number[], period: number): number[] {
  const tr = highs.map((h, i) => i === 0 ? h - lows[i] : Math.max(h - lows[i], Math.abs(h - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  const atr = new Array(tr.length).fill(0);
  atr[period - 1] = tr.slice(0, period).reduce((a, b) => a + b) / period;
  for (let i = period; i < tr.length; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  return atr;
}

function calcSuperTrend(highs: number[], lows: number[], closes: number[], atrLen: number, mult: number) {
  const atr = calcATR(highs, lows, closes, atrLen);
  const n = closes.length;
  const trend = new Array(n).fill(1);
  const upperBand = new Array(n).fill(0);
  const lowerBand = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    upperBand[i] = hl2 + mult * atr[i];
    lowerBand[i] = hl2 - mult * atr[i];
    if (i > 0) {
      lowerBand[i] = lowerBand[i] > lowerBand[i - 1] || closes[i - 1] < lowerBand[i - 1] ? lowerBand[i] : lowerBand[i - 1];
      upperBand[i] = upperBand[i] < upperBand[i - 1] || closes[i - 1] > upperBand[i - 1] ? upperBand[i] : upperBand[i - 1];
      if (trend[i - 1] === -1 && closes[i] > upperBand[i - 1]) trend[i] = 1;
      else if (trend[i - 1] === 1 && closes[i] < lowerBand[i - 1]) trend[i] = -1;
      else trend[i] = trend[i - 1];
    }
  }
  return { trend, upperBand, lowerBand };
}

function calcDMI(highs: number[], lows: number[], closes: number[], period: number) {
  const n = highs.length;
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    if (up > down && up > 0) plusDM[i] = up;
    if (down > up && down > 0) minusDM[i] = down;
  }
  const atr = calcATR(highs, lows, closes, period);
  const smoothPlusDM = calcEMA(plusDM, period);
  const smoothMinusDM = calcEMA(minusDM, period);
  const plusDI = smoothPlusDM.map((v, i) => atr[i] ? (v / atr[i]) * 100 : 0);
  const minusDI = smoothMinusDM.map((v, i) => atr[i] ? (v / atr[i]) * 100 : 0);
  const dx = plusDI.map((v, i) => (v + minusDI[i]) ? Math.abs(v - minusDI[i]) / (v + minusDI[i]) * 100 : 0);
  const adx = new Array(n).fill(0);
  const start2 = period * 2 - 1;
  if (start2 < n) {
    const validDx = dx.slice(period - 1, start2);
    adx[start2] = validDx.reduce((a, b) => a + b, 0) / period;
    for (let i = start2 + 1; i < n; i++) adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  }
  return { plusDI, minusDI, adx };
}

// ─────────────────────────────────────────────
// FETCH CANDLES (Polygon.io)
// ─────────────────────────────────────────────

interface Candle { time: number; open: number; high: number; low: number; close: number; }

async function fetchCandles(symbol: string, interval = '1h', bars = 150): Promise<Candle[]> {
  const POLYGON_KEY = Deno.env.get('POLYGON_API_KEY')!;
  const intervalMap: Record<string, { multiplier: number; timespan: string; days: number }> = {
    '1h': { multiplier: 1, timespan: 'hour', days: 60 },
    '4h': { multiplier: 4, timespan: 'hour', days: 180 },
    '1d': { multiplier: 1, timespan: 'day',  days: 365 },
  };
  const { multiplier, timespan, days } = intervalMap[interval] ?? intervalMap['1h'];
  const to   = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${from.toISOString().split('T')[0]}/${to.toISOString().split('T')[0]}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_KEY}`;
  const res  = await fetch(url);
  const json = await res.json();
  if (!json.results?.length) throw new Error(`No Polygon data for ${symbol}`);
  const candles: Candle[] = json.results.map((r: { t: number; o: number; h: number; l: number; c: number }) => ({
    time: r.t, open: r.o, high: r.h, low: r.l, close: r.c,
  }));
  return candles.slice(-bars);
}

// ─────────────────────────────────────────────
// SIGNAL GENERATION
// ─────────────────────────────────────────────

function generateSignal(candles: Candle[], settings: BotSettings) {
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const n = closes.length;
  const emaArr = calcEMA(closes, settings.emaLength);
  const { trend } = calcSuperTrend(highs, lows, closes, settings.atrLength, settings.atrMultiplier);
  const { adx }   = calcDMI(highs, lows, closes, settings.adxLength);
  const i = n - 2;
  const curTrend = trend[i], prevTrend = trend[i - 1];
  const curEma = emaArr[i], curAdx = adx[i], curClose = closes[i];
  const trendJustFlipped = curTrend !== prevTrend;
  const longOK  = curTrend === 1  && curClose > curEma && curAdx > settings.adxThreshold;
  const shortOK = curTrend === -1 && curClose < curEma && curAdx > settings.adxThreshold;
  let signal: 'buy' | 'sell' | 'none' = 'none';
  let reason = `trend=${curTrend}, close=${curClose.toFixed(2)}, ema=${curEma.toFixed(2)}, adx=${curAdx?.toFixed(1)}`;
  if (trendJustFlipped && longOK)  { signal = 'buy';  reason = `SuperTrend flipped UP. ${reason}`; }
  if (trendJustFlipped && shortOK) { signal = 'sell'; reason = `SuperTrend flipped DOWN. ${reason}`; }
  return { signal, price: curClose, trend: curTrend, ema: curEma, adx: curAdx, reason };
}

// ─────────────────────────────────────────────
// BLACK-SCHOLES OPTION PRICING
// ─────────────────────────────────────────────

function erf(x: number): number {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return sign * y;
}

function normCDF(x: number): number { return 0.5 * (1 + erf(x / Math.sqrt(2))); }

function blackScholes(S: number, K: number, T: number, r: number, sigma: number, type: 'call' | 'put'): number {
  if (T <= 0) return Math.max(0, type === 'call' ? S - K : K - S);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  if (type === 'call') return S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2);
  return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
}

function calcHistoricalVolatility(closes: number[], period = 20): number {
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) returns.push(Math.log(closes[i] / closes[i - 1]));
  const recent = returns.slice(-period);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
  return Math.sqrt(variance * 252); // annualized
}

function getExpirationDate(type: string): string {
  const now = new Date();
  if (type === '0dte') {
    // Today (market day)
    return now.toISOString().split('T')[0];
  } else if (type === 'weekly') {
    // Next Friday
    const day = now.getDay();
    const daysToFriday = (5 - day + 7) % 7 || 7;
    const friday = new Date(now.getTime() + daysToFriday * 24 * 60 * 60 * 1000);
    return friday.toISOString().split('T')[0];
  } else {
    // Monthly — third Friday of next month
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    let fridays = 0;
    while (fridays < 3) { if (next.getDay() === 5) fridays++; if (fridays < 3) next.setDate(next.getDate() + 1); }
    return next.toISOString().split('T')[0];
  }
}

function pickStrike(spotPrice: number, otmStrikes: number, optionType: 'call' | 'put', strikeInterval = 5): number {
  // Round spot to nearest strike interval
  const atm = Math.round(spotPrice / strikeInterval) * strikeInterval;
  if (optionType === 'call') return atm + otmStrikes * strikeInterval;
  return atm - otmStrikes * strikeInterval;
}

// ─────────────────────────────────────────────
// SETTINGS INTERFACE
// ─────────────────────────────────────────────

interface BotSettings {
  atrLength: number; atrMultiplier: number; emaLength: number;
  adxLength: number; adxThreshold: number; symbol: string;
  dollarAmount: number; interval: string; tradeDirection: string;
  expiryType: string; otmStrikes: number;
  strikeMode: string; manualStrike: number | null;
}

// ─────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  try {
    let targetBotId: string | null = null;
    let targetUserId: string | null = null;

    if (req.method === 'POST') {
      const authHeader = req.headers.get('Authorization');
      const cronSecret = (await req.json().catch(() => ({}))).cron_secret;
      const validCron  = cronSecret === Deno.env.get('CRON_SECRET');
      if (!validCron && authHeader) {
        const token = authHeader.replace('Bearer ', '');
        const { data: { user } } = await supabase.auth.getUser(token);
        if (user) targetUserId = user.id;
      }
      try { const b = await req.json().catch(() => ({})); targetBotId = b.bot_id || null; targetUserId = targetUserId || b.user_id || null; } catch (_) {}
    }

    let query = supabase.from('options_bots').select('*').eq('enabled', true).eq('auto_submit', true);
    if (targetBotId)  query = query.eq('id', targetBotId);
    if (targetUserId) query = query.eq('user_id', targetUserId);

    const { data: bots, error: botErr } = await query;
    if (botErr) throw botErr;
    if (!bots || bots.length === 0) {
      return new Response(JSON.stringify({ message: 'No active options bots' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const results: object[] = [];
    const R = 0.05; // risk-free rate

    const SCAN_STOCKS = [
      'AAPL','MSFT','AMZN','NVDA','TSLA','GOOG','GOOGL','META','NFLX','BRK-B',
      'JPM','BAC','WFC','V','MA','PG','KO','PFE','UNH','HD',
      'INTC','CSCO','ADBE','CRM','ORCL','AMD','QCOM','TXN','IBM','AVGO',
      'XOM','CVX','BA','CAT','MMM','GE','HON','LMT','NOC','DE',
      'C','GS','MS','AXP','BLK','SCHW','BK','SPGI','ICE',
      'MRK','ABBV','AMGN','BMY','LLY','GILD','JNJ','REGN','VRTX','BIIB',
      'WMT','COST','TGT','LOW','MCD','SBUX','NKE','BKNG',
      'SNAP','UBER','LYFT','SPOT','ZM','DOCU','PINS','ROKU','SHOP',
      'CVS','TMO','MDT','ISRG','F','GM',
    ];
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
        tradeDirection: bot.bot_trade_direction ?? 'both',
        expiryType:     bot.bot_expiry_type    ?? 'weekly',
        otmStrikes:     bot.bot_otm_strikes    ?? 1,
        strikeMode:     bot.bot_strike_mode    ?? 'budget',
        manualStrike:   bot.bot_manual_strike  ?? null,
      };

      const scanMode: string = (bot.bot_scan_mode as string) || 'single';
      const symbolList = scanMode === 'scan_stocks' ? SCAN_STOCKS : [settings.symbol];

      try {
        for (let i = 0; i < symbolList.length; i += 10) {
          const batch = symbolList.slice(i, i + 10);
          await Promise.all(batch.map(async (sym) => {
            try {
              const candles = await fetchCandles(sym, settings.interval, 150);
              if (candles.length < 60) { results.push({ bot_id: bot.id, symbol: sym, status: 'skipped', reason: 'Not enough candle data' }); return; }

              const { signal, price, reason } = generateSignal(candles, settings);
              if (signal === 'none') { results.push({ bot_id: bot.id, symbol: sym, status: 'no_signal', reason }); return; }
              if (signal === 'buy'  && settings.tradeDirection === 'short') { results.push({ bot_id: bot.id, symbol: sym, status: 'skipped', reason: 'Direction filter' }); return; }
              if (signal === 'sell' && settings.tradeDirection === 'long')  { results.push({ bot_id: bot.id, symbol: sym, status: 'skipped', reason: 'Direction filter' }); return; }

              // Duplicate check
              const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
              const { data: recent } = await supabase.from('options_trades').select('signal').eq('bot_id', bot.id).eq('symbol', sym).gte('created_at', fourHoursAgo).limit(1);
              if (recent && recent.length > 0 && recent[0].signal === signal) { results.push({ bot_id: bot.id, symbol: sym, status: 'skipped', reason: `Duplicate ${signal} within 4h` }); return; }

              // Close open opposite positions
              const { data: openTrades } = await supabase.from('options_trades').select('*').eq('bot_id', bot.id).eq('symbol', sym).eq('status', 'open');
              const sigma = calcHistoricalVolatility(candles.map(c => c.close));
              if (openTrades && openTrades.length > 0) {
                for (const open of openTrades) {
                  const optType: 'call' | 'put' = open.option_type;
                  const expDate = new Date(open.expiration_date);
                  const T = Math.max(0, (expDate.getTime() - Date.now()) / (365 * 24 * 60 * 60 * 1000));
                  const exitPremium = blackScholes(price, open.strike, T, R, sigma, optType);
                  const pnl = (exitPremium - open.premium_per_contract) * open.contracts * 100;
                  await supabase.from('options_trades').update({ status: 'closed', exit_price: exitPremium, pnl, closed_at: new Date().toISOString() }).eq('id', open.id);
                }
              }

              const optionType: 'call' | 'put' = signal === 'buy' ? 'call' : 'put';
              const expirationDate = getExpirationDate(settings.expiryType);
              const expDate = new Date(expirationDate);
              const T = Math.max(1 / 365, (expDate.getTime() - Date.now()) / (365 * 24 * 60 * 60 * 1000));
              const strikeInterval = price > 500 ? 5 : price > 100 ? 5 : price > 50 ? 2.5 : 1;

              let strike: number;
              let premium: number;

              if (settings.strikeMode === 'manual' && settings.manualStrike && settings.manualStrike > 0) {
                strike = settings.manualStrike;
                premium = blackScholes(price, strike, T, R, sigma, optionType);
              } else {
                const atmStrike = Math.round(price / strikeInterval) * strikeInterval;
                let bestStrike = atmStrike;
                let bestPremium = blackScholes(price, atmStrike, T, R, sigma, optionType);
                for (let offset = -5; offset <= 5; offset++) {
                  const s = atmStrike + offset * strikeInterval;
                  if (s <= 0) continue;
                  const p = blackScholes(price, s, T, R, sigma, optionType);
                  if (p * 100 <= settings.dollarAmount && (p > bestPremium || bestPremium * 100 > settings.dollarAmount)) {
                    bestStrike = s; bestPremium = p;
                  }
                }
                strike = bestStrike; premium = bestPremium;
              }

              if (premium <= 0.01) { results.push({ bot_id: bot.id, symbol: sym, status: 'skipped', reason: 'Premium too low' }); return; }

              const contracts = Math.max(1, Math.floor(settings.dollarAmount / (premium * 100)));
              const totalCost = contracts * premium * 100;

              const { data: botRow } = await supabase.from('options_bots').select('paper_balance').eq('id', bot.id).single();
              const currentBalance = Number(botRow?.paper_balance ?? 150000);
              await supabase.from('options_bots').update({ paper_balance: Math.max(0, currentBalance - totalCost) }).eq('id', bot.id);

              await supabase.from('options_trades').insert({
                user_id: bot.user_id, bot_id: bot.id, symbol: sym,
                option_type: optionType, strike, expiration_date: expirationDate,
                contracts, premium_per_contract: premium, total_cost: totalCost,
                entry_price: premium, status: 'open', signal, reason,
                created_at: new Date().toISOString(),
              });

              results.push({ bot_id: bot.id, status: 'filled', symbol: sym, option_type: optionType, strike, expiration_date: expirationDate, contracts, premium: premium.toFixed(2), total_cost: totalCost.toFixed(2), sigma: (sigma * 100).toFixed(1) + '%', signal, reason });

            } catch (err) {
              results.push({ bot_id: bot.id, symbol: sym, status: 'error', error: String(err) });
            }
          }));
        }
      } catch (err) {
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
