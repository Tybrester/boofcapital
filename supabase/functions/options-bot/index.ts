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

function calcRSI(closes: number[], period: number): number[] {
  const rsi: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0, l = diff < 0 ? -diff : 0;
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
    const emaSignal = calcEMA(macdLine.slice(validStart), signal);
    for (let i = 0; i < emaSignal.length; i++) signalLine[validStart + i] = emaSignal[i];
  }
  const hist = macdLine.map((v, i) => (isNaN(v) || isNaN(signalLine[i])) ? NaN : v - signalLine[i]);
  return { macdLine, signalLine, hist };
}

function generateSignalRSIMACD(candles: Candle[], tradeDirection = 'both'): { signal: 'buy' | 'sell' | 'none', price: number, trend: number, ema: number, adx: number, reason: string } {
  const closes = candles.map(c => c.close);
  const n = closes.length;
  const i = n - 2;
  const rsi = calcRSI(closes, 14);
  const ema50 = calcEMA(closes, 50);
  const { hist } = calcMACD(closes, 12, 26, 9);
  const curRSI = rsi[i], curEma = ema50[i], curHist = hist[i], curClose = closes[i];
  
  // Replay position state
  let inLong = false, inShort = false;
  for (let j = 50; j < i; j++) {
    const r = rsi[j], h = hist[j], e = ema50[j], c = closes[j];
    if (isNaN(r) || isNaN(h) || isNaN(e)) continue;
    const buyCond = (r < 30 || h > 0) && c > e;
    const sellCond = (r > 70 || h < 0) && c < e;
    if (!inLong && !inShort && buyCond) inLong = true;
    else if (!inLong && !inShort && sellCond) inShort = true;
    else if (inLong && sellCond) { inLong = false; inShort = true; }
    else if (inShort && buyCond) { inShort = false; inLong = true; }
  }
  
  const buyCond  = (curRSI < 30 || curHist > 0) && curClose > curEma;
  const sellCond = (curRSI > 70 || curHist < 0) && curClose < curEma;
  let signal: 'buy' | 'sell' | 'none' = 'none';
  let reason = `rsi=${curRSI?.toFixed(1)}, macd_hist=${curHist?.toFixed(4)}, ema=${curEma?.toFixed(2)}, close=${curClose?.toFixed(2)}, pos=${inLong ? 'long' : inShort ? 'short' : 'flat'}`;
  
  if (buyCond) {
    if (inShort) { signal = 'buy'; reason = `EXIT SHORT->LONG. ${reason}`; }
    else if (!inLong) { signal = 'buy'; reason = `ENTER LONG. ${reason}`; }
  } else if (sellCond) {
    if (inLong) { signal = 'sell'; reason = `EXIT LONG->SHORT. ${reason}`; }
    else if (!inShort && tradeDirection !== 'long') { signal = 'sell'; reason = `ENTER SHORT. ${reason}`; }
    else if (tradeDirection === 'long' && inLong) { signal = 'sell'; reason = `EXIT LONG (long-only). ${reason}`; }
  }
  return { signal, price: curClose, trend: buyCond ? 1 : -1, ema: curEma, adx: curRSI, reason };
}

// ─────────────────────────────────────────────
// BOOF 2.0 ML-STYLE INDICATOR
// ─────────────────────────────────────────────

function generateSignalBoof20(candles: Candle[], tradeDirection = 'both', thresholdBuy = 0.0, thresholdSell = 0.0): { signal: 'buy' | 'sell' | 'none', price: number, trend: number, ema: number, adx: number, reason: string } {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const n = closes.length;

  if (n < 25) {
    return { signal: 'none', price: closes[n - 1], trend: 0, ema: closes[n - 1], adx: 50, reason: 'Insufficient data for Boof 2.0' };
  }

  const length = 14, maFast = 5, maSlow = 20;

  // Past return
  const pastReturn: number[] = new Array(n).fill(0);
  for (let i = length; i < n; i++) {
    pastReturn[i] = (closes[i] - closes[i - length]) / closes[i - length];
  }

  // MA calculations
  const maFastVals: number[] = new Array(n).fill(NaN);
  const maSlowVals: number[] = new Array(n).fill(NaN);
  for (let i = maFast - 1; i < n; i++) {
    maFastVals[i] = closes.slice(i - maFast + 1, i + 1).reduce((a, b) => a + b, 0) / maFast;
  }
  for (let i = maSlow - 1; i < n; i++) {
    maSlowVals[i] = closes.slice(i - maSlow + 1, i + 1).reduce((a, b) => a + b, 0) / maSlow;
  }

  // RSI
  const rsi = calcRSI(closes, length);

  // Current bar
  const i = n - 2;
  const rPast = pastReturn[i] || 0;
  const rMa = (maFastVals[i] - maSlowVals[i]) / closes[i] || 0;
  const rRsi = (rsi[i] - 50) / 50 || 0;

  // Simplified ATR
  const atrSlice = highs.slice(i - 13, i + 1).map((h, idx) => h - lows[i - 13 + idx]);
  const rAtr = Math.max(...atrSlice) / closes[i] || 0;

  // ML prediction
  const predictedReturn = 0.4 * rPast + 0.3 * rMa + 0.2 * rRsi - 0.1 * rAtr;

  // Track position
  let inLong = false;
  for (let j = maSlow; j <= i; j++) {
    const pr = 0.4 * (pastReturn[j] || 0) + 0.3 * ((maFastVals[j] - maSlowVals[j]) / closes[j] || 0) + 0.2 * ((rsi[j] - 50) / 50 || 0) - 0.1 * rAtr;
    if (pr > thresholdBuy && !inLong) inLong = true;
    else if (pr < thresholdSell && inLong) inLong = false;
  }

  let signal: 'buy' | 'sell' | 'none' = 'none';
  let reason = `predicted=${predictedReturn.toFixed(4)}, rsi=${rsi[i]?.toFixed(1)}, inLong=${inLong}`;

  if (!inLong && predictedReturn > thresholdBuy) {
    signal = 'buy';
    reason = `Boof 2.0 BUY. ${reason}`;
  } else if (inLong && predictedReturn < thresholdSell) {
    signal = 'sell';
    reason = `Boof 2.0 SELL. ${reason}`;
  }

  if (tradeDirection === 'long' && signal === 'sell') signal = 'none';
  if (tradeDirection === 'short' && signal === 'buy') signal = 'none';

  return { signal, price: closes[i], trend: predictedReturn > 0 ? 1 : -1, ema: maSlowVals[i], adx: rsi[i], reason };
}

// ─────────────────────────────────────────────
// BOOF 3.0 KMEANS REGIME DETECTION
// ─────────────────────────────────────────────

type MarketRegime = 'Trend' | 'Range' | 'HighVol';

function kMeansClustering(data: number[][], k: number, maxIterations = 100) {
  const n = data.length;
  const dims = data[0].length;
  const centroids: number[][] = [];
  const usedIndices = new Set<number>();
  for (let i = 0; i < k; i++) {
    let idx = Math.floor(Math.random() * n);
    while (usedIndices.has(idx)) idx = Math.floor(Math.random() * n);
    usedIndices.add(idx);
    centroids.push([...data[idx]]);
  }
  let clusters: number[] = new Array(n).fill(0);
  let changed = true, iterations = 0;
  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;
    for (let i = 0; i < n; i++) {
      let minDist = Infinity, bestCluster = 0;
      for (let j = 0; j < k; j++) {
        let dist = 0;
        for (let d = 0; d < dims; d++) dist += (data[i][d] - centroids[j][d]) ** 2;
        dist = Math.sqrt(dist);
        if (dist < minDist) { minDist = dist; bestCluster = j; }
      }
      if (clusters[i] !== bestCluster) { clusters[i] = bestCluster; changed = true; }
    }
    const newCentroids: number[][] = Array(k).fill(null).map(() => Array(dims).fill(0));
    const counts = Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const c = clusters[i];
      counts[c]++;
      for (let d = 0; d < dims; d++) newCentroids[c][d] += data[i][d];
    }
    for (let j = 0; j < k; j++) {
      if (counts[j] > 0) {
        for (let d = 0; d < dims; d++) newCentroids[j][d] /= counts[j];
        centroids[j] = newCentroids[j];
      }
    }
  }
  return { clusters, centroids };
}

function generateSignalBoof30(candles: Candle[], tradeDirection = 'both'): { signal: 'buy' | 'sell' | 'none', price: number, trend: number, ema: number, adx: number, reason: string } {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => (c as any).volume || 1000000);
  const n = closes.length;

  if (n < 35) return { signal: 'none', price: closes[n - 1], trend: 0, ema: closes[n - 1], adx: 50, reason: 'Insufficient data' };

  const lookback = 14;

  // Returns
  const returns: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) returns[i] = (closes[i] - closes[i - 1]) / closes[i - 1];

  // Return std
  const returnStd: number[] = new Array(n).fill(0);
  for (let i = lookback; i < n; i++) {
    const slice = returns.slice(i - lookback + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / lookback;
    returnStd[i] = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / lookback);
  }

  // MA slope
  const maFast: number[] = new Array(n).fill(NaN);
  const maSlow: number[] = new Array(n).fill(NaN);
  for (let i = 4; i < n; i++) maFast[i] = closes.slice(i - 4, i + 1).reduce((a, b) => a + b, 0) / 5;
  for (let i = 19; i < n; i++) maSlow[i] = closes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
  const maSlope = maFast.map((f, i) => !isNaN(f) && !isNaN(maSlow[i]) ? f - maSlow[i] : 0);

  // RSI
  const rsi = calcRSI(closes, lookback);

  // Volume std
  const volumeStd: number[] = new Array(n).fill(0);
  for (let i = lookback; i < n; i++) {
    const slice = volumes.slice(i - lookback + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / lookback;
    volumeStd[i] = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / lookback);
  }

  // Prepare features for clustering
  const validStart = Math.max(lookback, 20);
  const features: number[][] = [];
  const validIndices: number[] = [];
  for (let i = validStart; i < n; i++) {
    if (!isNaN(rsi[i])) {
      features.push([returnStd[i] * 100, maSlope[i], rsi[i], volumeStd[i] / 1000000]);
      validIndices.push(i);
    }
  }

  if (features.length < 10) return { signal: 'none', price: closes[n - 1], trend: 0, ema: closes[n - 1], adx: 50, reason: 'Not enough data' };

  // KMeans clustering
  const { clusters } = kMeansClustering(features, 3, 50);

  // Map clusters to regimes by avg slope
  const clusterStats: { cluster: number, avgSlope: number }[] = [];
  for (let c = 0; c < 3; c++) {
    const indices = validIndices.filter((_, idx) => clusters[idx] === c);
    const avgSlope = indices.reduce((a, idx) => a + maSlope[idx], 0) / indices.length;
    clusterStats.push({ cluster: c, avgSlope });
  }
  clusterStats.sort((a, b) => a.avgSlope - b.avgSlope);
  const regimeMap: Record<number, MarketRegime> = {
    [clusterStats[0].cluster]: 'Range',
    [clusterStats[1].cluster]: 'HighVol',
    [clusterStats[2].cluster]: 'Trend'
  };

  // Generate signals for each point
  const signals: { regime: MarketRegime, signal: number }[] = [];
  for (let idx = 0; idx < validIndices.length; idx++) {
    const i = validIndices[idx];
    const regime = regimeMap[clusters[idx]];
    let signal = 0;
    if (regime === 'Trend') {
      if (maSlope[i] > 0 && rsi[i] > 50) signal = 1;
      else if (maSlope[i] < 0 && rsi[i] < 50) signal = -1;
    } else if (regime === 'Range') {
      if (rsi[i] < 35) signal = 1;
      else if (rsi[i] > 65) signal = -1;
    } else if (regime === 'HighVol') {
      if (rsi[i] < 25 && maSlope[i] > 0) signal = 1;
      else if (rsi[i] > 75 && maSlope[i] < 0) signal = -1;
    }
    signals.push({ regime, signal });
  }

  // Current bar
  const i = n - 2;
  const idx = validIndices.indexOf(i);
  const current = idx >= 0 ? signals[idx] : { regime: 'Range' as MarketRegime, signal: 0 };
  const curClose = closes[i];

  // Track position
  let inLong = false;
  for (let j = 0; j <= idx; j++) {
    if (signals[j].signal === 1 && !inLong) inLong = true;
    else if (signals[j].signal === -1 && inLong) inLong = false;
  }

  let signal: 'buy' | 'sell' | 'none' = 'none';
  let reason = `regime=${current.regime}, rsi=${rsi[i]?.toFixed(1)}, slope=${maSlope[i]?.toFixed(4)}, inLong=${inLong}`;

  if (!inLong && current.signal === 1) {
    signal = 'buy';
    reason = `Boof 3.0 BUY [${current.regime}]. ${reason}`;
  } else if (inLong && current.signal === -1) {
    signal = 'sell';
    reason = `Boof 3.0 SELL [${current.regime}]. ${reason}`;
  } else {
    reason = `Boof 3.0 NONE [${current.regime}]. ${reason}`;
  }

  if (tradeDirection === 'long' && signal === 'sell') signal = 'none';
  if (tradeDirection === 'short' && signal === 'buy') signal = 'none';

  return { signal, price: curClose, trend: maSlope[i] > 0 ? 1 : -1, ema: maSlow[i], adx: rsi[i], reason };
}

// ─────────────────────────────────────────────
// FETCH CANDLES (Yahoo Finance - Free)
// ─────────────────────────────────────────────

interface Candle { time: number; open: number; high: number; low: number; close: number; }

async function fetchCandles(symbol: string, interval = '1h', bars = 150): Promise<Candle[]> {
  // Yahoo Finance API (free, no key needed)
  const yahooSymbol = symbol.includes('-USD') ? symbol.replace('-USD', '-USD') : symbol;
  
  // Map intervals to Yahoo format
  const intervalMap: Record<string, { yahooInterval: string; range: string }> = {
    '1m':  { yahooInterval: '1m',  range: '1d'   },
    '5m':  { yahooInterval: '5m',  range: '5d'   },
    '10m': { yahooInterval: '15m', range: '5d'   },
    '15m': { yahooInterval: '15m', range: '5d'   },
    '30m': { yahooInterval: '30m', range: '1mo'  },
    '45m': { yahooInterval: '60m', range: '1mo'  },
    '1h':  { yahooInterval: '60m', range: '1mo'  },
    '2h':  { yahooInterval: '60m', range: '3mo'  },
    '4h':  { yahooInterval: '60m', range: '6mo'  },
    '1d':  { yahooInterval: '1d',  range: '1y'   },
  };
  
  const { yahooInterval, range } = intervalMap[interval] ?? intervalMap['1h'];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=${yahooInterval}&range=${range}`;
  
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Yahoo API error: ${res.status} - ${text.substring(0, 100)}`);
  }
  
  const json = await res.json();
  
  if (!json.chart?.result?.[0]) {
    throw new Error(`No Yahoo data for ${symbol}`);
  }
  
  const result = json.chart.result[0];
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  
  const candles: Candle[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (quote.open?.[i] && quote.high?.[i] && quote.low?.[i] && quote.close?.[i]) {
      candles.push({
        time: timestamps[i] * 1000,
        open: quote.open[i],
        high: quote.high[i],
        low: quote.low[i],
        close: quote.close[i],
      });
    }
  }
  
  if (candles.length < 60) {
    throw new Error(`Not enough data for ${symbol} (got ${candles.length} candles)`);
  }
  
  return candles.slice(-bars);
}

// ─────────────────────────────────────────────
// SIGNAL GENERATION
// ─────────────────────────────────────────────

function generateSignal(candles: Candle[], settings: BotSettings): { signal: 'buy' | 'sell' | 'none', price: number, trend: number, ema: number, adx: number, reason: string } {
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const n = closes.length;
  const tradeDirection = settings.tradeDirection || 'both';
  const emaArr = calcEMA(closes, settings.emaLength);
  const { trend } = calcSuperTrend(highs, lows, closes, settings.atrLength, settings.atrMultiplier);
  const { adx }   = calcDMI(highs, lows, closes, settings.adxLength);
  
  // Replay position state
  let inLong = false, inShort = false;
  for (let j = 1; j < n - 2; j++) {
    const prevTrend = trend[j - 1], curTrend = trend[j];
    const trendJustFlipped = curTrend !== prevTrend;
    const curEma = emaArr[j], curAdx = adx[j], curClose = closes[j];
    const longOK  = curTrend === 1  && curClose > curEma && curAdx > settings.adxThreshold;
    const shortOK = curTrend === -1 && curClose < curEma && curAdx > settings.adxThreshold;
    if (trendJustFlipped && longOK) {
      if (inShort) { inShort = false; inLong = true; }
      else if (!inLong && !inShort) { inLong = true; }
    } else if (trendJustFlipped && shortOK) {
      if (inLong) { inLong = false; inShort = true; }
      else if (!inLong && !inShort && tradeDirection !== 'long') { inShort = true; }
    }
  }
  
  const i = n - 2;
  const curTrend = trend[i], prevTrend = trend[i - 1];
  const curEma = emaArr[i], curAdx = adx[i], curClose = closes[i];
  const trendJustFlipped = curTrend !== prevTrend;
  const longOK  = curTrend === 1  && curClose > curEma && curAdx > settings.adxThreshold;
  const shortOK = curTrend === -1 && curClose < curEma && curAdx > settings.adxThreshold;
  let signal: 'buy' | 'sell' | 'none' = 'none';
  let reason = `trend=${curTrend}, close=${curClose.toFixed(2)}, ema=${curEma.toFixed(2)}, adx=${curAdx?.toFixed(1)}, pos=${inLong ? 'long' : inShort ? 'short' : 'flat'}`;
  if (trendJustFlipped && longOK) {
    if (inShort) { signal = 'buy'; reason = `EXIT SHORT->LONG. SuperTrend UP. ${reason}`; }
    else if (!inLong) { signal = 'buy'; reason = `ENTER LONG. SuperTrend UP. ${reason}`; }
  } else if (trendJustFlipped && shortOK) {
    if (inLong) { signal = 'sell'; reason = `EXIT LONG->SHORT. SuperTrend DOWN. ${reason}`; }
    else if (!inShort && tradeDirection !== 'long') { signal = 'sell'; reason = `ENTER SHORT. SuperTrend DOWN. ${reason}`; }
    else if (tradeDirection === 'long' && inLong) { signal = 'sell'; reason = `EXIT LONG (long-only). SuperTrend DOWN. ${reason}`; }
  }
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

// ─────────────────────────────────────────────
// REAL OPTION PRICE FETCHING (via Tradier or fallback)
// ─────────────────────────────────────────────

async function fetchRealOptionPrice(symbol: string, strike: number, expiration: string, optionType: string): Promise<number> {
  try {
    // Build Tradier option symbol format: SPY241231C00580000
    const expDate = new Date(expiration);
    const yy = String(expDate.getFullYear()).slice(-2);
    const mm = String(expDate.getMonth() + 1).padStart(2, '0');
    const dd = String(expDate.getDate()).padStart(2, '0');
    const strikeCents = Math.round(strike * 1000);
    const optSymbol = `${symbol}${yy}${mm}${dd}${optionType.toUpperCase().charAt(0)}${String(strikeCents).padStart(8, '0')}`;
    
    // Call our get-option-price edge function
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://isanhutzyctcjygjhzbn.supabase.co';
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
    
    const res = await fetch(`${SUPABASE_URL}/functions/v1/get-option-price?symbol=${encodeURIComponent(optSymbol)}`, {
      headers: { 
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!res.ok) throw new Error(`Edge function error: ${res.status}`);
    
    const data = await res.json();
    return data?.price || 0;
  } catch (err) {
    console.log('[OptionsBot] Failed to fetch real option price:', err);
    return 0;
  }
}

function getExpirationDate(type: string): string {
  const now = new Date();
  if (type === '0dte') {
    // Find the closest future valid expiration day (today if available, otherwise next available day)
    const target = new Date(now.getTime());
    
    // Search up to 7 days forward for the next valid trading day
    for (let i = 0; i < 7; i++) {
      const candidate = new Date(target.getTime());
      candidate.setDate(candidate.getDate() + i);
      const day = candidate.getDay();
      
      // Skip weekends (0=Sunday, 6=Saturday)
      if (day === 0 || day === 6) continue;
      
      // Return first valid weekday (handles holidays via findValidExpiration later)
      return candidate.toISOString().split('T')[0];
    }
    
    // Fallback to today if no valid day found (shouldn't happen)
    return target.toISOString().split('T')[0];
  } else if (type === 'weekly') {
    // Always pick NEXT Friday for consistent 7+ day holds (minimum 7 days)
    const thisFriday = new Date(now.getTime());
    const daysToThisFriday = (5 - thisFriday.getDay() + 7) % 7;
    thisFriday.setDate(thisFriday.getDate() + daysToThisFriday);
    
    const nextFriday = new Date(thisFriday.getTime());
    nextFriday.setDate(nextFriday.getDate() + 7);
    
    // Always use next Friday (at least 7 days from today)
    return nextFriday.toISOString().split('T')[0];
  } else {
    // Monthly — third Friday closest to 30 days away
    // Find this month's and next month's third Friday
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    let thisFridays = 0, thisThirdFriday: Date | null = null;
    for (let d = 1; d <= 31; d++) {
      const date = new Date(thisMonth.getFullYear(), thisMonth.getMonth(), d);
      if (date.getMonth() !== thisMonth.getMonth()) break;
      if (date.getDay() === 5) {
        thisFridays++;
        if (thisFridays === 3) { thisThirdFriday = date; break; }
      }
    }
    
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    let nextFridays = 0, nextThirdFriday: Date | null = null;
    for (let d = 1; d <= 31; d++) {
      const date = new Date(nextMonth.getFullYear(), nextMonth.getMonth(), d);
      if (date.getMonth() !== nextMonth.getMonth()) break;
      if (date.getDay() === 5) {
        nextFridays++;
        if (nextFridays === 3) { nextThirdFriday = date; break; }
      }
    }
    
    // Pick whichever third Friday is closest to 30 days from now
    const daysToThis = thisThirdFriday ? Math.ceil((thisThirdFriday.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)) : Infinity;
    const daysToNext = nextThirdFriday ? Math.ceil((nextThirdFriday.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)) : Infinity;
    
    const diffFrom30This = Math.abs(daysToThis - 30);
    const diffFrom30Next = Math.abs(daysToNext - 30);
    
    const target = diffFrom30This <= diffFrom30Next && daysToThis > 0 ? thisThirdFriday : nextThirdFriday;
    return target ? target.toISOString().split('T')[0] : (thisThirdFriday || nextThirdFriday || now).toISOString().split('T')[0];
  }
}

// Find nearest valid expiration: tries target, then -1 day, then +1 day, then -2 day, then +2 day
function findValidExpiration(targetDate: string): string {
  const target = new Date(targetDate);
  const candidates = [
    target,
    new Date(target.getTime() - 1 * 24 * 60 * 60 * 1000), // -1 day
    new Date(target.getTime() + 1 * 24 * 60 * 60 * 1000), // +1 day
    new Date(target.getTime() - 2 * 24 * 60 * 60 * 1000), // -2 days
    new Date(target.getTime() + 2 * 24 * 60 * 60 * 1000), // +2 days
  ];
  for (const d of candidates) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) return d.toISOString().split('T')[0]; // Skip weekends
  }
  return targetDate; // Fallback to original
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
  takeProfitPct: number; stopLossPct: number;
  botSignal: string;
}

// ─────────────────────────────────────────────
// ALPACA OPTIONS TRADING
// ─────────────────────────────────────────────

// Format option symbol for Alpaca: SPY240531C00580000
function formatOptionSymbol(symbol: string, expirationDate: string, optionType: 'call' | 'put', strike: number): string {
  const date = new Date(expirationDate);
  const year = date.getFullYear().toString().slice(2); // 24
  const month = (date.getMonth() + 1).toString().padStart(2, '0'); // 06
  const day = date.getDate().toString().padStart(2, '0'); // 15
  const type = optionType === 'call' ? 'C' : 'P';
  const strikeStr = Math.round(strike * 1000).toString().padStart(8, '0'); // 00580000
  return `${symbol.toUpperCase()}${year}${month}${day}${type}${strikeStr}`;
}

// Place options order via Alpaca
async function placeAlpacaOptionOrder(
  supabase: any,
  userId: string,
  symbol: string,
  expirationDate: string,
  optionType: 'call' | 'put',
  strike: number,
  side: 'buy' | 'sell',
  qty: number
): Promise<{ success: boolean; orderId?: string; error?: string; status?: string }> {
  try {
    // Fetch Alpaca credentials
    const { data: creds } = await supabase
      .from('broker_credentials')
      .select('credentials')
      .eq('user_id', userId)
      .eq('broker', 'alpaca')
      .maybeSingle();

    if (!creds) {
      return { success: false, error: 'No Alpaca credentials found' };
    }

    const { api_key, secret_key, env } = creds.credentials;
    const baseUrl = env === 'live'
      ? 'https://api.alpaca.markets'
      : 'https://paper-api.alpaca.markets';

    const optionSymbol = formatOptionSymbol(symbol, expirationDate, optionType, strike);

    const orderBody = {
      symbol: optionSymbol,
      side,
      type: 'market',
      time_in_force: 'day',
      qty: String(qty),
    };

    console.log(`[AlpacaOptions] Placing order: ${side} ${qty} x ${optionSymbol}`);

    const res = await fetch(`${baseUrl}/v2/orders`, {
      method: 'POST',
      headers: {
        'APCA-API-KEY-ID': api_key,
        'APCA-API-SECRET-KEY': secret_key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(orderBody),
    });

    const order = await res.json();

    if (!res.ok) {
      console.error('[AlpacaOptions] Order failed:', order.message || order);
      return { success: false, error: order.message || 'Alpaca order failed', status: 'failed' };
    }

    console.log(`[AlpacaOptions] Order placed: ${order.id} status=${order.status}`);
    return { success: true, orderId: order.id, status: order.status };

  } catch (err) {
    console.error('[AlpacaOptions] Error:', err);
    return { success: false, error: String(err), status: 'error' };
  }
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

  // GET /portfolio-value?bot_id=xxx — returns cash + live value of open positions
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const botId = url.searchParams.get('bot_id');
    if (!botId) return new Response(JSON.stringify({ error: 'bot_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const { data: bot } = await supabase.from('options_bots').select('paper_balance, bot_interval').eq('id', botId).single();
    const cash = Number(bot?.paper_balance ?? 100000);
    const interval = bot?.bot_interval ?? '1h';

    const { data: openTrades } = await supabase.from('options_trades').select('*').eq('bot_id', botId).eq('status', 'open');
    let openValue = 0;
    const R = 0.05;
    if (openTrades && openTrades.length > 0) {
      for (const t of openTrades) {
        try {
          const candles = await fetchCandles(t.symbol, interval, 60);
          if (!candles.length) { openValue += Number(t.total_cost); continue; }
          const price = candles[candles.length - 1].close;
          const sigma = calcHistoricalVolatility(candles.map(c => c.close));
          const expDate = new Date(t.expiration_date);
          const T = Math.max(0, (expDate.getTime() - Date.now()) / (365 * 24 * 60 * 60 * 1000));
          const currentPremium = blackScholes(price, t.strike, T, R, sigma, t.option_type);
          openValue += currentPremium * t.contracts * 100;
        } catch (_) { openValue += Number(t.total_cost); }
      }
    }

    return new Response(JSON.stringify({ cash, open_value: openValue, total: cash + openValue }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  try {
    let targetBotId: string | null = null;
    let targetUserId: string | null = null;

    // Handle sync trigger from stock bot (process specific symbol immediately)
    let syncSymbol: string | null = null;
    let syncSignal: string | null = null;
    let isSyncTrigger = false;
    let triggerSource: string | null = null;
    let reqBody: any = null;

    if (req.method === 'POST') {
      const authHeader = req.headers.get('Authorization');
      const body = await req.json().catch(() => ({}));
      const cronSecret = body.cron_secret;
      const validCron  = cronSecret === Deno.env.get('CRON_SECRET');
      if (!validCron && authHeader) {
        const token = authHeader.replace('Bearer ', '');
        const { data: { user } } = await supabase.auth.getUser(token);
        if (user) targetUserId = user.id;
      }
      targetBotId = body.bot_id || null;
      targetUserId = targetUserId || body.user_id || null;
      
      // Check for sync trigger from stock bot
      syncSymbol = body.symbol || null;
      syncSignal = body.signal || null;
      isSyncTrigger = body.trigger_source === 'auto-bot-sync';
      triggerSource = body.trigger_source;
      reqBody = body;
      console.log(`[OptionsBot] Request body:`, JSON.stringify({trigger_source: body.trigger_source, symbol: body.symbol, signal: body.signal, bot_id: body.bot_id}));
      console.log(`[OptionsBot] isSyncTrigger=${isSyncTrigger}, syncSymbol=${syncSymbol}, syncSignal=${syncSignal}`);
      if (isSyncTrigger && syncSymbol && syncSignal) {
        console.log(`[OptionsBot] Sync trigger from stock bot: ${syncSymbol} ${syncSignal}`);
      }
    }

    let query = supabase.from('options_bots').select('*').eq('enabled', true).eq('auto_submit', true);
    if (targetBotId)  query = query.eq('id', targetBotId);
    if (targetUserId) query = query.eq('user_id', targetUserId);

    console.log(`[OptionsBot] Query: targetBotId=${targetBotId}, targetUserId=${targetUserId}, isSyncTrigger=${isSyncTrigger}`);

    const { data: bots, error: botErr } = await query;
    
    if (botErr) {
      console.error('[OptionsBot] Query error:', botErr);
    }
    console.log(`[OptionsBot] Found ${bots?.length || 0} bots`);
    if (bots && bots.length > 0) {
      console.log('[OptionsBot] Bot names:', bots.map(b => b.name).join(', '));
    }
    if (botErr) throw botErr;
    if (!bots || bots.length === 0) {
      return new Response(JSON.stringify({ message: 'No active options bots', debug: { targetBotId, targetUserId } }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log(`Found ${bots.length} active bots:`, bots.map(b => ({ id: b.id, name: b.name, user_id: b.user_id?.slice(0,8), symbol: b.bot_symbol, scan_mode: b.bot_scan_mode })));

    const results: object[] = [];
    const R = 0.05; // risk-free rate
    const now = new Date();
    
    // Check market hours (options on stocks only trade 9:30 AM - 4:00 PM ET)
    // Use UTC offset for ET (UTC-5 or UTC-4 depending on DST)
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    const utcDay = now.getUTCDay();
    
    // Convert UTC to ET (ET = UTC - 5 hours, or UTC - 4 during DST)
    // Simplified: just subtract 5 hours, this works for most cases
    let etHour = utcHour - 5;
    let etMinute = utcMinute;
    let etDay = utcDay;
    
    // Handle wrap-around for early morning UTC
    if (etHour < 0) {
      etHour += 24;
      etDay = (etDay + 6) % 7; // Previous day
    }
    
    const isWeekday = etDay >= 1 && etDay <= 5;
    const isOptionsMarketHours = isWeekday && (etHour > 9 || (etHour === 9 && etMinute >= 30)) && etHour < 16;
    
    console.log(`[OptionsBot] Market hours check: ET=${etHour}:${etMinute}, day=${etDay}, weekday=${isWeekday}, open=${isOptionsMarketHours}`);

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
      // High volatility growth stocks (great for options)
      'SNOW','CRWD','NET','DDOG','MDB','OKTA','SPLK','FSLR','ENPH','SEDG',
      'DKNG','CHPT','LCID','RIVN','HOOD','SOFI','AI','PLTR','ASML','MU',
      'LRCX','KLAC','AMAT','MRVL','NXPI','CDNS','SNPS','ANET','FTNT','PANW',
      'GME','AMC','BBBY','EXPR','KOSS','NAKD','SNDL','TLRY','ACB','CGC',
      // ETFs (high volume options)
      'QQQ','SPY','VOO','IVV','VTI','VUG','QQQM','SCHG','XLK','VGT','SMH','TQQQ',
    ];

    const SCAN_ETFS = [
      'QQQ','SPY','VOO','IVV','VTI','VUG','QQQM','SCHG','XLK','VGT','SMH','TQQQ',
    ];

    const SCAN_TOP10 = [
      'SMCI','TSLA','NVDA','COIN','PLTR','AMD','MRNA','MSTY','ENPH','VKTX','CCL',
    ];

    const SCAN_TOP50 = [
      'SNGX','HTCO','ERAS','BIYA','ACST','ACB','AIXI','AMST','EOSE','JBLU',
      'LAES','SLS','BE','CIFR','RDW','IREN','BRLS','EDSA','KNSA','OMCL',
      'CVLT','CNC','HRI','NVTS','CLS','RBLX','PLTR','TSLA','NVDA','AMD',
      'META','NFLX','AMZN','SMCI','NVR','AZO','MELI','GEV','MPWR','CAR',
      'SPY','QQQ','AAPL','MSFT','GOOGL','AVGO','INTC','PYPL','SNAP','UBER',
    ];
    for (const bot of bots) {
      // SYNC-ONLY MODE: Only trade on stock bot sync trigger, skip scheduled scans
      console.log(`[OptionsBot] Checking bot "${bot.name}" - isSyncTrigger=${isSyncTrigger}, syncSymbol=${syncSymbol}, syncSignal=${syncSignal}`);
      if (!isSyncTrigger) {
        console.log(`[OptionsBot] Skipping "${bot.name}" - sync-only mode (waiting for stock bot trigger)`);
        continue;
      }
      
      // Check if bot should run based on run_interval_min
      const runIntervalMin = (bot.run_interval_min as number) ?? 15;
      const lastRunAt = bot.last_run_at ? new Date(bot.last_run_at as string) : null;
      const minutesSinceLastRun = lastRunAt ? (now.getTime() - lastRunAt.getTime()) / (1000 * 60) : Infinity;
      
      if (minutesSinceLastRun < runIntervalMin) {
        console.log(`[OptionsBot] Skipping "${bot.name}" - ran ${minutesSinceLastRun.toFixed(1)}m ago, interval=${runIntervalMin}m`);
        continue;
      }
      
      // Options only trade during market hours (skip after hours) - unless test_mode
      const isTestMode = triggerSource === 'auto-bot-sync' && reqBody?.test_mode === true;
      if (!isOptionsMarketHours && !isTestMode) {
        console.log(`[OptionsBot] Skipping "${bot.name}" - options markets closed (ET=${etHour}:${etMinute})`);
        continue;
      }
      if (isTestMode) {
        console.log(`[OptionsBot] TEST MODE - bypassing market hours check for "${bot.name}"`);
      }
      
      // 0DTE cutoff: Don't trade 0DTE after 2:00 PM ET (12:00 PM MT)
      // 0DTE options stop trading 2 hours before market close (4:00 PM ET)
      const expiryType = bot.bot_expiry_type ?? 'weekly';
      const isAfter2PM_ET = etHour >= 14; // 2:00 PM ET or later
      if (expiryType === '0dte' && isAfter2PM_ET) {
        console.log(`[OptionsBot] Skipping "${bot.name}" - 0DTE cutoff reached (after 2:00 PM ET, 2 hours before close)`);
        continue;
      }
      
      console.log(`[OptionsBot] Running "${bot.name}" | interval=${runIntervalMin}m | expiry=${expiryType}`);
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
        takeProfitPct:  bot.take_profit_pct    ?? 100,
        stopLossPct:    bot.stop_loss_pct      ?? 20,
        botSignal:      (bot.bot_signal as string) || 'supertrend',
      };

      const scanMode: string = (bot.bot_scan_mode as string) || 'single';
      
      // Use sync symbol from stock bot trigger (limit to just that symbol for sync)
      let symbolList: string[];
      if (isSyncTrigger && syncSymbol) {
        symbolList = [syncSymbol];
        console.log(`[OptionsBot] "${bot.name}" | SYNC MODE | symbol=${syncSymbol} | signal=${syncSignal}`);
      } else {
        symbolList = scanMode === 'scan_stocks' ? SCAN_STOCKS
          : scanMode === 'scan_etfs' ? SCAN_ETFS
          : scanMode === 'scan_top10' ? SCAN_TOP10
          : scanMode === 'scan_top50' ? SCAN_TOP50
          : [settings.symbol];
      }

      console.log(`[OptionsBot] "${bot.name}" | scanMode=${scanMode} | symbols=${symbolList.length} | list=[${symbolList.slice(0,5).join(',')}...${symbolList.slice(-3).join(',')}]`);

      try {
        // ── TP/SL check on all open positions using REAL option prices ──
        const { data: allOpen } = await supabase.from('options_trades').select('*').eq('bot_id', bot.id).eq('status', 'open');
        if (allOpen && allOpen.length > 0) {
          for (const open of allOpen) {
            try {
              // Build Tradier option symbol format: SPY241231C00580000
              const expDate = new Date(open.expiration_date);
              const yy = String(expDate.getFullYear()).slice(-2);
              const mm = String(expDate.getMonth() + 1).padStart(2, '0');
              const dd = String(expDate.getDate()).padStart(2, '0');
              const strikeCents = Math.round(open.strike * 1000);
              const optSymbol = `${open.symbol}${yy}${mm}${dd}${open.option_type.toUpperCase().charAt(0)}${String(strikeCents).padStart(8, '0')}`;
              
              // Fetch REAL option price from our edge function (or Tradier directly)
              let optionPrice = await fetchRealOptionPrice(open.symbol, open.strike, open.expiration_date, open.option_type);
              
              if (!optionPrice || optionPrice <= 0) {
                console.log(`[OptionsBot] No real price for ${optSymbol}, using Black-Scholes fallback`);
                // Fallback to Black-Scholes
                const candles = await fetchCandles(open.symbol, settings.interval, 60);
                if (!candles.length) continue;
                const currentPrice = candles[candles.length - 1].close;
                const sigma = calcHistoricalVolatility(candles.map(c => c.close));
                const T = Math.max(0, (expDate.getTime() - Date.now()) / (365 * 24 * 60 * 60 * 1000));
                optionPrice = blackScholes(currentPrice, open.strike, T, R, sigma, open.option_type);
              }
              
              const pctChange = ((optionPrice - open.premium_per_contract) / open.premium_per_contract) * 100;
              const shouldTP = pctChange >= settings.takeProfitPct;
              const shouldSL = pctChange <= -settings.stopLossPct;
              
              // EOD exit: 0DTE options must close before market close (3:45pm ET cutoff)
              const is0DTE = open.expiration_date === now.toISOString().split('T')[0];
              // Use already calculated etHour and etMinute from earlier
              const nearMarketClose = etHour === 15 && etMinute >= 45; // 3:45pm ET or later
              const shouldEOD = is0DTE && nearMarketClose;
              
              if (shouldTP || shouldSL || shouldEOD) {
                const pnl = (optionPrice - open.premium_per_contract) * open.contracts * 100;
                let closeStatus = 'closed';
                let closeOrderId = null;
                let closeError = null;

                // Close via Alpaca if live trading
                if (bot.broker === 'alpaca' && open.order_id) {
                  console.log(`[OptionsBot] Closing Alpaca position: ${open.contracts} contracts of ${open.symbol} ${open.option_type}`);
                  const alpacaResult = await placeAlpacaOptionOrder(
                    supabase,
                    bot.user_id,
                    open.symbol,
                    open.expiration_date,
                    open.option_type,
                    open.strike,
                    'sell',
                    open.contracts
                  );
                  if (alpacaResult.success) {
                    closeStatus = alpacaResult.status === 'filled' ? 'closed' : 'closing';
                    closeOrderId = alpacaResult.orderId;
                    console.log(`[OptionsBot] Alpaca close order placed: ${closeOrderId}`);
                  } else {
                    closeError = alpacaResult.error;
                    console.error(`[OptionsBot] Alpaca close failed: ${closeError}`);
                  }
                } else {
                  // Paper trading: update virtual balance
                  const { data: botRow } = await supabase.from('options_bots').select('paper_balance').eq('id', bot.id).single();
                  const bal = Number(botRow?.paper_balance ?? 100000);
                  await supabase.from('options_bots').update({ paper_balance: bal + (open.total_cost + pnl) }).eq('id', bot.id);
                }

                await supabase.from('options_trades').update({ 
                  status: closeStatus, 
                  exit_price: optionPrice, 
                  pnl, 
                  close_order_id: closeOrderId,
                  broker_error: closeError,
                  closed_at: new Date().toISOString() 
                }).eq('id', open.id);
                
                const exitReason = shouldEOD ? 'eod_exit' : shouldTP ? 'take_profit' : 'stop_loss';
                results.push({ bot_id: bot.id, symbol: open.symbol, status: exitReason, pct_change: pctChange.toFixed(1) + '%', pnl: pnl.toFixed(2), order_id: closeOrderId, broker_error: closeError });
              }
            } catch (_) {}
          }
        }

        for (let i = 0; i < symbolList.length; i += 10) {
          const batch = symbolList.slice(i, i + 10);
          await Promise.all(batch.map(async (sym) => {
            try {
              const candles = await fetchCandles(sym, settings.interval, 150);
              if (candles.length < 60) { results.push({ bot_id: bot.id, symbol: sym, status: 'skipped', reason: 'Not enough candle data' }); return; }

              // In sync mode, use stock bot's signal directly. Otherwise generate our own.
              let signal: 'buy' | 'sell' | 'none';
              let price: number;
              let reason: string;
              
              if (isSyncTrigger && syncSignal) {
                // SYNC MODE: Use stock bot's signal directly
                signal = syncSignal as 'buy' | 'sell';
                price = candles[candles.length - 1].close;
                reason = `Synced with stock bot: ${signal} @ $${price.toFixed(2)}`;
                console.log(`[OptionsBot] "${bot.name}" | ${sym} | SYNC SIGNAL: ${signal} | price=$${price.toFixed(2)}`);
              } else {
                // Regular mode: Generate our own signal based on bot_signal setting
                const botSignal = settings.botSignal || 'supertrend';
                let sigResult: { signal: 'buy' | 'sell' | 'none', price: number, reason: string, trend?: number, ema?: number, adx?: number };
                if (botSignal === 'rsi_macd') {
                  sigResult = generateSignalRSIMACD(candles, settings.tradeDirection);
                } else if (botSignal === 'boof20') {
                  sigResult = generateSignalBoof20(candles, settings.tradeDirection, 0.0, 0.0);
                } else if (botSignal === 'boof30') {
                  sigResult = generateSignalBoof30(candles, settings.tradeDirection);
                } else {
                  sigResult = generateSignal(candles, settings);
                }
                signal = sigResult.signal;
                price = sigResult.price;
                reason = sigResult.reason;
              }
              
              if (signal === 'none') { results.push({ bot_id: bot.id, symbol: sym, status: 'skipped', reason: 'no_signal' }); return; }
              if (signal === 'buy'  && settings.tradeDirection === 'short') { results.push({ bot_id: bot.id, symbol: sym, status: 'skipped', reason: 'Direction filter' }); return; }
              if (signal === 'sell' && settings.tradeDirection === 'long')  { results.push({ bot_id: bot.id, symbol: sym, status: 'skipped', reason: 'Direction filter' }); return; }

              // Race condition prevention: check for any trade within 1 minute
              const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
              const { data: recent1m } = await supabase.from('options_trades').select('id').eq('bot_id', bot.id).eq('symbol', sym).gte('created_at', oneMinuteAgo).limit(1);
              if (recent1m && recent1m.length > 0) { results.push({ bot_id: bot.id, symbol: sym, status: 'skipped', reason: `Duplicate trade within 1 minute (race condition)` }); return; }

              // Duplicate check (4 hours)
              const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
              const { data: recent } = await supabase.from('options_trades').select('signal').eq('bot_id', bot.id).eq('symbol', sym).gte('created_at', fourHoursAgo).limit(1);
              if (recent && recent.length > 0 && recent[0].signal === signal) { results.push({ bot_id: bot.id, symbol: sym, status: 'skipped', reason: `Duplicate ${signal} within 4h` }); return; }

              // Close open opposite positions and return balance
              const { data: openTrades } = await supabase.from('options_trades').select('*').eq('bot_id', bot.id).eq('symbol', sym).eq('status', 'open');
              const sigma = calcHistoricalVolatility(candles.map(c => c.close));
              if (openTrades && openTrades.length > 0) {
                for (const open of openTrades) {
                  const optType: 'call' | 'put' = open.option_type;
                  const expDate = new Date(open.expiration_date);
                  const T = Math.max(0, (expDate.getTime() - Date.now()) / (365 * 24 * 60 * 60 * 1000));
                  const exitPremium = blackScholes(price, open.strike, T, R, sigma, optType);
                  const pnl = (exitPremium - open.premium_per_contract) * open.contracts * 100;
                  
                  // Close via Alpaca if live trading
                  if (bot.broker === 'alpaca' && open.order_id) {
                    const alpacaResult = await placeAlpacaOptionOrder(
                      supabase,
                      bot.user_id,
                      open.symbol,
                      open.expiration_date,
                      open.option_type,
                      open.strike,
                      'sell',
                      open.contracts
                    );
                    if (alpacaResult.success) {
                      await supabase.from('options_trades').update({ 
                        status: 'closed', 
                        exit_price: exitPremium, 
                        pnl, 
                        close_order_id: alpacaResult.orderId,
                        closed_at: new Date().toISOString() 
                      }).eq('id', open.id);
                    } else {
                      await supabase.from('options_trades').update({ 
                        status: 'closed', 
                        exit_price: exitPremium, 
                        pnl, 
                        broker_error: alpacaResult.error,
                        closed_at: new Date().toISOString() 
                      }).eq('id', open.id);
                    }
                  } else {
                    // Paper trading
                    await supabase.from('options_trades').update({ status: 'closed', exit_price: exitPremium, pnl, closed_at: new Date().toISOString() }).eq('id', open.id);
                    // Return original cost + profit/loss back to balance
                    const { data: bRow } = await supabase.from('options_bots').select('paper_balance').eq('id', bot.id).single();
                    const bBal = Number(bRow?.paper_balance ?? 100000);
                    await supabase.from('options_bots').update({ paper_balance: bBal + Number(open.total_cost) + pnl }).eq('id', bot.id);
                  }
                }
              }

              // Determine option type based on signal and bot setting
              let optionType: 'call' | 'put';
              const botOptionType = bot.bot_option_type || 'both';
              if (botOptionType === 'call') {
                optionType = 'call';
              } else if (botOptionType === 'put') {
                optionType = 'put';
              } else {
                // 'both' - follow signal
                optionType = signal === 'buy' ? 'call' : 'put';
              }
              const targetExpiration = getExpirationDate(settings.expiryType);
              const expirationDate = findValidExpiration(targetExpiration);
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
                // If quantity is specified, don't filter by budget - just find best strike
                const hasQuantity = bot.bot_quantity && bot.bot_quantity > 0;
                for (let offset = -5; offset <= 5; offset++) {
                  const s = atmStrike + offset * strikeInterval;
                  if (s <= 0) continue;
                  const p = blackScholes(price, s, T, R, sigma, optionType);
                  // When quantity is set, ignore budget constraint and pick best premium
                  // Otherwise, only consider strikes within budget
                  const withinBudget = hasQuantity || p * 100 <= settings.dollarAmount;
                  if (withinBudget && p > bestPremium) {
                    bestStrike = s; bestPremium = p;
                  }
                }
                strike = bestStrike; premium = bestPremium;
              }

              if (premium <= 0.01) { results.push({ bot_id: bot.id, symbol: sym, status: 'skipped', reason: 'Premium too low' }); return; }

              const quantity = bot.bot_quantity;
              const dollarAmount = bot.bot_dollar_amount || 500;
              const contracts = quantity && quantity > 0 ? Math.max(1, quantity) : Math.max(1, Math.floor(dollarAmount / (premium * 100)));
              const totalCost = contracts * premium * 100;
              const overBudget = totalCost > dollarAmount;

              let tradeStatus = 'open';
              let orderId = null;
              let brokerError = null;

              // Live trading via Alpaca
              if (bot.broker === 'alpaca') {
                console.log(`[OptionsBot] Placing Alpaca order: ${contracts} contracts of ${sym} ${optionType}`);
                const alpacaResult = await placeAlpacaOptionOrder(
                  supabase,
                  bot.user_id,
                  sym,
                  expirationDate,
                  optionType,
                  strike,
                  'buy',
                  contracts
                );
                if (alpacaResult.success) {
                  tradeStatus = alpacaResult.status === 'filled' ? 'filled' : 'pending';
                  orderId = alpacaResult.orderId;
                  console.log(`[OptionsBot] Alpaca order placed: ${orderId}`);
                } else {
                  tradeStatus = 'failed';
                  brokerError = alpacaResult.error;
                  console.error(`[OptionsBot] Alpaca order failed: ${brokerError}`);
                }
              } else {
                // Paper trading: update virtual balance
                const { data: botRow } = await supabase.from('options_bots').select('paper_balance').eq('id', bot.id).single();
                const currentBalance = Number(botRow?.paper_balance ?? 100000);
                await supabase.from('options_bots').update({ paper_balance: Math.max(0, currentBalance - totalCost) }).eq('id', bot.id);
              }

              await supabase.from('options_trades').insert({
                user_id: bot.user_id, bot_id: bot.id, symbol: sym,
                option_type: optionType, strike, expiration_date: expirationDate,
                contracts, premium_per_contract: premium, total_cost: totalCost,
                entry_price: premium, status: tradeStatus, signal, reason,
                order_id: orderId,
                broker: bot.broker || 'paper',
                broker_error: brokerError,
                created_at: new Date().toISOString(),
              });

              results.push({ bot_id: bot.id, status: tradeStatus, symbol: sym, option_type: optionType, strike, expiration_date: expirationDate, contracts, premium: premium.toFixed(2), total_cost: totalCost.toFixed(2), budget: dollarAmount, over_budget: overBudget, order_id: orderId, broker_error: brokerError, sigma: (sigma * 100).toFixed(1) + '%', signal, reason });

            } catch (err) {
              results.push({ bot_id: bot.id, symbol: sym, status: 'error', error: String(err) });
            }
          }));
        }
      } catch (err) {
        results.push({ bot_id: bot.id, status: 'error', error: String(err) });
      }
      
      // Update last_run_at after successful processing
      await supabase.from('options_bots').update({ last_run_at: now.toISOString() }).eq('id', bot.id);
    }

    console.log(`Processed ${results.length} results:`, results);

    return new Response(JSON.stringify({ processed: results.length, results }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
