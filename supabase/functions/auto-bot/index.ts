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

// ─────────────────────────────────────────────
// BOOF 2.0 ML-STYLE INDICATOR
// ─────────────────────────────────────────────

interface Boof20Result {
  predictedReturn: number;
  signal: number;  // 1 = buy, -1 = sell, 0 = neutral
  pastReturn: number;
  maDiff: number;
  rsi: number;
  atr: number;
}

function calcBoof20(
  highs: number[],
  lows: number[],
  closes: number[],
  length = 14,
  maFast = 5,
  maSlow = 20,
  volLength = 14,
  thresholdBuy = 0.0,
  thresholdSell = 0.0
): Boof20Result[] {
  const n = closes.length;
  const result: Boof20Result[] = new Array(n).fill({ predictedReturn: 0, signal: 0, pastReturn: 0, maDiff: 0, rsi: 50, atr: 0 });

  if (n < maSlow + 1) return result;

  // Calculate past return (momentum)
  const pastReturn: number[] = new Array(n).fill(0);
  for (let i = length; i < n; i++) {
    pastReturn[i] = (closes[i] - closes[i - length]) / closes[i - length];
  }

  // Calculate fast and slow MAs
  const maFastVals: number[] = new Array(n).fill(NaN);
  const maSlowVals: number[] = new Array(n).fill(NaN);

  for (let i = maFast - 1; i < n; i++) {
    const slice = closes.slice(i - maFast + 1, i + 1);
    maFastVals[i] = slice.reduce((a, b) => a + b, 0) / maFast;
  }

  for (let i = maSlow - 1; i < n; i++) {
    const slice = closes.slice(i - maSlow + 1, i + 1);
    maSlowVals[i] = slice.reduce((a, b) => a + b, 0) / maSlow;
  }

  // Calculate MA difference (trend)
  const maDiff: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (!isNaN(maFastVals[i]) && !isNaN(maSlowVals[i])) {
      maDiff[i] = maFastVals[i] - maSlowVals[i];
    }
  }

  // Calculate RSI
  const rsi = calcRSI(closes, length);

  // Calculate simplified ATR (high-low range over volLength)
  const atr: number[] = new Array(n).fill(0);
  for (let i = volLength - 1; i < n; i++) {
    const highSlice = highs.slice(i - volLength + 1, i + 1);
    const lowSlice = lows.slice(i - volLength + 1, i + 1);
    atr[i] = Math.max(...highSlice) - Math.min(...lowSlice);
  }

  // Calculate predicted return using weighted formula
  for (let i = maSlow; i < n; i++) {
    const rPast = pastReturn[i] || 0;
    const rMa = maDiff[i] / closes[i] || 0;
    const rRsi = (rsi[i] - 50) / 50 || 0;
    const rAtr = atr[i] / closes[i] || 0;

    // ML-style predicted return
    const predictedReturn = (
      0.4 * rPast +
      0.3 * rMa +
      0.2 * rRsi -
      0.1 * rAtr
    );

    // Generate signal
    let signal = 0;
    if (predictedReturn > thresholdBuy) signal = 1;      // buy
    else if (predictedReturn < thresholdSell) signal = -1;  // sell

    result[i] = {
      predictedReturn,
      signal,
      pastReturn: rPast,
      maDiff: maDiff[i],
      rsi: rsi[i],
      atr: atr[i]
    };
  }

  return result;
}

function generateSignalRSIMACD(candles: Candle[], tradeDirection = 'both'): SignalResult {
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

  // Replay state to track inLong like PineScript (exact match)
  // Pine: if not inLong and buyCond -> inLong := true
  //       if inLong and sellCond -> inLong := false
  let inLong = false;
  for (let j = 50; j <= i; j++) {
    const r = rsi[j], h = hist[j], e = ema50[j], c = closes[j];
    if (isNaN(r) || isNaN(h) || isNaN(e)) continue;
    const buyCond  = (r < 30 || h > 0) && c > e;
    const sellCond = (r > 70 || h < 0) && c < e;
    if (!inLong && buyCond)  inLong = true;
    if (inLong  && sellCond) inLong = false;
  }

  // PineScript logic (exact match):
  // buyCond = (rsi < 30 or macdHist > 0) and close > ema50
  // sellCond = (rsi > 70 or macdHist < 0) and close < ema50
  const buyCond  = (curRSI < 30 || curHist > 0) && curClose > curEma;
  const sellCond = (curRSI > 70 || curHist < 0) && curClose < curEma;

  let signal: 'buy' | 'sell' | 'none' = 'none';
  let reason = `rsi=${curRSI?.toFixed(1)}, macd_hist=${curHist?.toFixed(4)}, ema=${curEma?.toFixed(2)}, close=${curClose?.toFixed(2)}, inLong=${inLong}`;

  // Pine: if not inLong and buyCond -> BUY
  //       if inLong and sellCond -> SELL
  if (!inLong && buyCond)  { signal = 'buy';  reason = `PineScript BUY. ${reason}`; }
  if (inLong  && sellCond) { signal = 'sell'; reason = `PineScript SELL. ${reason}`; }

  return { signal, price: curClose, trend: curClose > curEma ? 1 : -1, ema: curEma, adx: curRSI, reason };
}

function generateSignalBoof20(candles: Candle[], tradeDirection = 'both', thresholdBuy = 0.0, thresholdSell = 0.0): SignalResult {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const n = closes.length;

  if (n < 25) {
    return { signal: 'none', price: closes[n - 1], trend: 0, ema: closes[n - 1], adx: 50, reason: 'Insufficient data for Boof 2.0' };
  }

  const boofResults = calcBoof20(highs, lows, closes, 14, 5, 20, 14, thresholdBuy, thresholdSell);
  const i = n - 2; // last completed bar
  const current = boofResults[i];
  const prev = boofResults[i - 1];
  const curClose = closes[i];

  if (!current) {
    return { signal: 'none', price: curClose, trend: 0, ema: curClose, adx: 50, reason: 'Boof 2.0 calculation error' };
  }

  // Track position state like other strategies
  let inLong = false;
  for (let j = 20; j <= i; j++) {
    if (boofResults[j].signal === 1 && !inLong) inLong = true;
    else if (boofResults[j].signal === -1 && inLong) inLong = false;
  }

  let signal: 'buy' | 'sell' | 'none' = 'none';
  let reason = `predicted_return=${current.predictedReturn?.toFixed(4)}, rsi=${current.rsi?.toFixed(1)}, past_ret=${current.pastReturn?.toFixed(4)}, inLong=${inLong}`;

  // Generate signal based on Boof 2.0 prediction
  if (!inLong && current.signal === 1) {
    signal = 'buy';
    reason = `Boof 2.0 BUY. ${reason}`;
  } else if (inLong && current.signal === -1) {
    signal = 'sell';
    reason = `Boof 2.0 SELL. ${reason}`;
  }

  // Apply trade direction filter
  if (tradeDirection === 'long' && signal === 'sell') signal = 'none';
  if (tradeDirection === 'short' && signal === 'buy') signal = 'none';

  return {
    signal,
    price: curClose,
    trend: current.predictedReturn > 0 ? 1 : -1,
    ema: closes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20,
    adx: current.rsi,
    reason
  };
}

// ─────────────────────────────────────────────
// BOOF 3.0 KMEANS REGIME DETECTION
// ─────────────────────────────────────────────

type MarketRegime = 'Trend' | 'Range' | 'HighVol';

interface Boof30Result {
  regime: MarketRegime;
  returnStd: number;
  maSlope: number;
  rsi: number;
  volumeStd: number;
  signal: number; // 1 = buy, -1 = sell, 0 = neutral
}

// Simple KMeans implementation for 3 clusters
function kMeansClustering(data: number[][], k: number, maxIterations = 100): { clusters: number[], centroids: number[][] } {
  const n = data.length;
  const dims = data[0].length;

  // Initialize centroids randomly
  const centroids: number[][] = [];
  const usedIndices = new Set<number>();
  for (let i = 0; i < k; i++) {
    let idx = Math.floor(Math.random() * n);
    while (usedIndices.has(idx)) idx = Math.floor(Math.random() * n);
    usedIndices.add(idx);
    centroids.push([...data[idx]]);
  }

  let clusters: number[] = new Array(n).fill(0);
  let iterations = 0;
  let changed = true;

  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;

    // Assign points to nearest centroid
    for (let i = 0; i < n; i++) {
      let minDist = Infinity;
      let bestCluster = 0;
      for (let j = 0; j < k; j++) {
        const dist = euclideanDistance(data[i], centroids[j]);
        if (dist < minDist) {
          minDist = dist;
          bestCluster = j;
        }
      }
      if (clusters[i] !== bestCluster) {
        clusters[i] = bestCluster;
        changed = true;
      }
    }

    // Update centroids
    const newCentroids: number[][] = Array(k).fill(null).map(() => Array(dims).fill(0));
    const counts = Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const c = clusters[i];
      counts[c]++;
      for (let d = 0; d < dims; d++) {
        newCentroids[c][d] += data[i][d];
      }
    }
    for (let j = 0; j < k; j++) {
      if (counts[j] > 0) {
        for (let d = 0; d < dims; d++) {
          newCentroids[j][d] /= counts[j];
        }
        centroids[j] = newCentroids[j];
      }
    }
  }

  return { clusters, centroids };
}

function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] - b[i]) ** 2;
  }
  return Math.sqrt(sum);
}

function calcBoof30(
  candles: Candle[],
  lookback = 14
): Boof30Result[] {
  const n = candles.length;
  const result: Boof30Result[] = new Array(n).fill({
    regime: 'Range', returnStd: 0, maSlope: 0, rsi: 50, volumeStd: 0, signal: 0
  });

  if (n < lookback + 20) return result;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => (c as any).volume || 1000000); // Default volume if not available

  // Calculate returns
  const returns: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    returns[i] = (closes[i] - closes[i - 1]) / closes[i - 1];
  }

  // Feature 1: return_std (volatility)
  const returnStd: number[] = new Array(n).fill(0);
  for (let i = lookback; i < n; i++) {
    const slice = returns.slice(i - lookback + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / lookback;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / lookback;
    returnStd[i] = Math.sqrt(variance);
  }

  // Feature 2: ma_slope (trend strength)
  const maFast: number[] = new Array(n).fill(NaN);
  const maSlow: number[] = new Array(n).fill(NaN);
  for (let i = 4; i < n; i++) {
    maFast[i] = closes.slice(i - 4, i + 1).reduce((a, b) => a + b, 0) / 5;
  }
  for (let i = 19; i < n; i++) {
    maSlow[i] = closes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
  }
  const maSlope: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (!isNaN(maFast[i]) && !isNaN(maSlow[i])) {
      maSlope[i] = maFast[i] - maSlow[i];
    }
  }

  // Feature 3: RSI
  const rsi = calcRSI(closes, lookback);

  // Feature 4: volume_std
  const volumeStd: number[] = new Array(n).fill(0);
  for (let i = lookback; i < n; i++) {
    const slice = volumes.slice(i - lookback + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / lookback;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / lookback;
    volumeStd[i] = Math.sqrt(variance);
  }

  // Prepare data for clustering (only valid rows)
  const validStart = Math.max(lookback, 20);
  const features: number[][] = [];
  const validIndices: number[] = [];

  for (let i = validStart; i < n; i++) {
    if (!isNaN(rsi[i])) {
      features.push([
        returnStd[i] * 100, // Scale up for better clustering
        maSlope[i],
        rsi[i],
        volumeStd[i] / 1000000 // Scale down volume
      ]);
      validIndices.push(i);
    }
  }

  if (features.length < 10) return result;

  // Run KMeans clustering
  const { clusters } = kMeansClustering(features, 3, 50);

  // Map clusters to regimes based on ma_slope
  const clusterStats: { cluster: number, avgSlope: number }[] = [];
  for (let c = 0; c < 3; c++) {
    const indices = validIndices.filter((_, idx) => clusters[idx] === c);
    const avgSlope = indices.reduce((a, idx) => a + maSlope[idx], 0) / indices.length;
    clusterStats.push({ cluster: c, avgSlope });
  }

  // Sort by ma_slope: lowest = Range, middle = HighVol, highest = Trend
  clusterStats.sort((a, b) => a.avgSlope - b.avgSlope);
  const regimeMap: Record<number, MarketRegime> = {
    [clusterStats[0].cluster]: 'Range',
    [clusterStats[1].cluster]: 'HighVol',
    [clusterStats[2].cluster]: 'Trend'
  };

  // Assign regimes and generate signals
  for (let idx = 0; idx < validIndices.length; idx++) {
    const i = validIndices[idx];
    const cluster = clusters[idx];
    const regime = regimeMap[cluster];

    // Generate signal based on regime
    let signal = 0;
    if (regime === 'Trend') {
      // Trend-following: buy if slope positive, sell if negative
      if (maSlope[i] > 0 && rsi[i] > 50) signal = 1;
      else if (maSlope[i] < 0 && rsi[i] < 50) signal = -1;
    } else if (regime === 'Range') {
      // Mean reversion: buy if oversold, sell if overbought
      if (rsi[i] < 35) signal = 1;
      else if (rsi[i] > 65) signal = -1;
    } else if (regime === 'HighVol') {
      // High volatility: be cautious, use tight criteria
      if (rsi[i] < 25 && maSlope[i] > 0) signal = 1;
      else if (rsi[i] > 75 && maSlope[i] < 0) signal = -1;
    }

    result[i] = {
      regime,
      returnStd: returnStd[i],
      maSlope: maSlope[i],
      rsi: rsi[i],
      volumeStd: volumeStd[i],
      signal
    };
  }

  return result;
}

function generateSignalBoof30(candles: Candle[], tradeDirection = 'both'): SignalResult {
  const closes = candles.map(c => c.close);
  const n = closes.length;

  if (n < 35) {
    return { signal: 'none', price: closes[n - 1], trend: 0, ema: closes[n - 1], adx: 50, reason: 'Insufficient data for Boof 3.0' };
  }

  const boofResults = calcBoof30(candles, 14);
  const i = n - 2; // last completed bar
  const current = boofResults[i];
  const curClose = closes[i];

  if (!current) {
    return { signal: 'none', price: curClose, trend: 0, ema: curClose, adx: 50, reason: 'Boof 3.0 calculation error' };
  }

  // Track position state
  let inLong = false;
  for (let j = 20; j <= i; j++) {
    if (boofResults[j].signal === 1 && !inLong) inLong = true;
    else if (boofResults[j].signal === -1 && inLong) inLong = false;
  }

  let signal: 'buy' | 'sell' | 'none' = 'none';
  let reason = `regime=${current.regime}, rsi=${current.rsi?.toFixed(1)}, slope=${current.maSlope?.toFixed(4)}, ret_std=${current.returnStd?.toFixed(4)}, inLong=${inLong}`;

  // Generate signal based on regime and conditions
  if (!inLong && current.signal === 1) {
    signal = 'buy';
    reason = `Boof 3.0 BUY [${current.regime}]. ${reason}`;
  } else if (inLong && current.signal === -1) {
    signal = 'sell';
    reason = `Boof 3.0 SELL [${current.regime}]. ${reason}`;
  } else {
    reason = `Boof 3.0 NONE [${current.regime}]. ${reason}`;
  }

  // Apply trade direction filter
  if (tradeDirection === 'long' && signal === 'sell') signal = 'none';
  if (tradeDirection === 'short' && signal === 'buy') signal = 'none';

  return {
    signal,
    price: curClose,
    trend: current.maSlope > 0 ? 1 : -1,
    ema: closes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20,
    adx: current.rsi,
    reason
  };
}

// ─────────────────────────────────────────────
// FETCH CANDLES (Alpaca Data - Live)
// ─────────────────────────────────────────────

interface Candle { time: number; open: number; high: number; low: number; close: number; }

async function fetchCandles(symbol: string, interval = '1h', bars = 150, userId?: string): Promise<Candle[]> {
  // Check if it's a crypto or futures symbol (both use Yahoo Finance)
  const isCrypto = symbol.includes('-USD') || symbol.includes('/USD');
  const isFutures = symbol.includes('=F');
  const useYahoo = isCrypto || isFutures;
  
  // Fix renamed/delisted Yahoo tickers
  const tickerFixMap: Record<string, string> = {
    'MATIC-USD': 'POL-USD',  // MATIC renamed to POL
  };
  
  if (useYahoo) {
    // Fetch REAL candle data from Yahoo Finance
    try {
      const yahooSymbol = tickerFixMap[symbol.toUpperCase()] || symbol;
      
      // Map interval to Yahoo Finance format
      const yahooIntervalMap: Record<string, string> = {
        '1m': '1m', '2m': '2m', '5m': '5m', '15m': '15m', '30m': '30m',
        '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1wk'
      };
      const yahooInterval = yahooIntervalMap[interval] || '1h';
      
      // Yahoo Finance requires range based on interval
      const rangeMap: Record<string, string> = {
        '1m': '1d', '2m': '5d', '5m': '5d', '15m': '5d', '30m': '1mo',
        '1h': '1mo', '4h': '3mo', '1d': '1y', '1wk': '5y'
      };
      const range = rangeMap[yahooInterval] || '1mo';
      
      const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${yahooInterval}&range=${range}`;
      console.log(`[AutoBot] Fetching Yahoo Finance candles for ${yahooSymbol} (${yahooInterval}, ${range})`);
      
      const yahooRes = await fetch(yahooUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      
      if (yahooRes.ok) {
        const data = await yahooRes.json();
        const result = data?.chart?.result?.[0];
        const timestamps = result?.timestamp;
        const quote = result?.indicators?.quote?.[0];
        
        if (timestamps && quote && timestamps.length > 0) {
          const candles: Candle[] = [];
          for (let i = 0; i < timestamps.length; i++) {
            const o = quote.open?.[i];
            const h = quote.high?.[i];
            const l = quote.low?.[i];
            const c = quote.close?.[i];
            if (o != null && h != null && l != null && c != null) {
              candles.push({
                time: timestamps[i] * 1000,
                open: o, high: h, low: l, close: c
              });
            }
          }
          
          // Return last N bars
          const trimmed = candles.slice(-bars);
          if (trimmed.length > 0) {
            console.log(`[AutoBot] Yahoo Finance ${symbol}: ${trimmed.length} real candles, latest close=$${trimmed[trimmed.length-1]?.close?.toFixed(2)}`);
            return trimmed;
          }
        }
      }
      
      // If Yahoo fails or returns empty data, skip symbol gracefully
      console.warn(`[AutoBot] Yahoo Finance: no data for ${symbol}, skipping`);
      throw new Error(`No candle data available for ${symbol}`);
      
    } catch (err) {
      console.error(`[AutoBot] Yahoo candle fetch error for ${symbol}:`, err);
      throw err;
    }
  }
  
  // Use Alpaca data API for stocks only
  const alpacaUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/alpaca-data`;
  
  const res = await fetch(alpacaUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
    },
    body: JSON.stringify({
      user_id: userId || 'anonymous',
      symbol: symbol,
      interval: interval,
      bars: bars,
      type: 'candles'
    })
  });
  
  if (!res.ok) {
    const error = await res.text();
    console.error(`[AutoBot] Alpaca data error for ${symbol}: ${error}`);
    throw new Error(`Alpaca data failed for ${symbol}: ${error}. Check your Alpaca credentials.`);
  }
  
  const data = await res.json();
  
  if (!data.candles || data.candles.length < 10) {
    throw new Error(`Insufficient Alpaca data for ${symbol} (got ${data.candles?.length || 0} bars)`);
  }
  
  const candles: Candle[] = data.candles.map((c: any) => ({
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));
  
  console.log(`[AutoBot] Fetched ${candles.length} candles for ${symbol} from Alpaca`);
  
  if (candles.length < 60) {
    throw new Error(`Not enough data for ${symbol} (got ${candles.length} candles)`);
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
  const tradeDirection = settings.tradeDirection || 'both';

  // Calculate EMA50
  const emaArr = calcEMA(closes, 50);

  // Calculate Supertrend components
  const atrPeriod = 10;
  const stMultiplier = 3;
  const hl2 = highs.map((h, i) => (h + lows[i]) / 2);
  const atr = calcATR(highs, lows, closes, atrPeriod);

  // Calculate Supertrend upper and lower bands
  const stUpper: number[] = new Array(n).fill(NaN);
  const stLower: number[] = new Array(n).fill(NaN);
  const supertrend: number[] = new Array(n).fill(0);

  for (let i = atrPeriod; i < n; i++) {
    stUpper[i] = hl2[i] + stMultiplier * atr[i];
    stLower[i] = hl2[i] - stMultiplier * atr[i];

    // Initialize Supertrend
    if (i === atrPeriod) {
      supertrend[i] = closes[i - 1] <= stUpper[i - 1] ? stUpper[i] : stLower[i];
    } else {
      // Update Supertrend
      if (closes[i - 1] <= stUpper[i - 1]) {
        supertrend[i] = stUpper[i];
      } else {
        supertrend[i] = stLower[i];
      }
    }
  }

  // Calculate ADX (14-period)
  const { adx } = calcDMI(highs, lows, closes, 14);

  // Current bar (last completed)
  const i = n - 2;
  const curClose = closes[i];
  const curEma = emaArr[i];
  const curSupertrend = supertrend[i];
  const curAdx = adx[i];

  const adxThreshold = 25;

  // Signal logic matching Python: close > EMA50, close > Supertrend, ADX > 25
  const longOK = curClose > curEma && curClose > curSupertrend && curAdx > adxThreshold;
  const shortOK = curClose < curEma && curClose < curSupertrend && curAdx > adxThreshold;

  // Replay state to track position
  let inLong = false;
  for (let j = 50; j < i; j++) {
    const longCond = closes[j] > emaArr[j] && closes[j] > supertrend[j] && adx[j] > adxThreshold;
    const shortCond = closes[j] < emaArr[j] && closes[j] < supertrend[j] && adx[j] > adxThreshold;
    if (longCond && !inLong) inLong = true;
    else if (shortCond && inLong) inLong = false;
  }

  let signal: 'buy' | 'sell' | 'none' = 'none';
  let reason = `close=${curClose.toFixed(2)}, ema50=${curEma?.toFixed(2)}, supertrend=${curSupertrend?.toFixed(2)}, adx=${curAdx?.toFixed(1)}, inLong=${inLong}`;

  if (!inLong && longOK) {
    signal = 'buy';
    reason = `Boof 1.0 BUY. ${reason}`;
  } else if (inLong && shortOK) {
    signal = 'sell';
    reason = `Boof 1.0 SELL. ${reason}`;
  }

  // Apply trade direction filter
  if (tradeDirection === 'long' && signal === 'sell') signal = 'none';
  if (tradeDirection === 'short' && signal === 'buy') signal = 'none';

  return {
    signal,
    price: curClose,
    trend: curClose > curEma ? 1 : -1,
    ema: curEma,
    adx: curAdx,
    reason
  };
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

    const { data: bot } = await supabaseGET.from('stock_bots').select('paper_balance, user_id').eq('id', botId).single();
    const cash = Number(bot?.paper_balance ?? 100000);

    // Fetch open (filled, no pnl) trades
    const { data: openTrades } = await supabaseGET.from('stock_trades').select('*').eq('bot_id', botId).eq('status', 'filled').is('pnl', null);
    let openValue = 0;
    if (openTrades && openTrades.length > 0) {
      for (const t of openTrades) {
        try {
          const candles = await fetchCandles(t.symbol, '1h', 5, bot?.user_id as string);
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

    // Top 20 Futures (liquid, trade overnight)
    const SCAN_FUTURES = [
      'ES=F',    // E-mini S&P 500
      'NQ=F',    // E-mini NASDAQ
      'YM=F',    // E-mini Dow
      'CL=F',    // Crude Oil WTI
      'GC=F',    // Gold
      'SI=F',    // Silver
      'ZN=F',    // 10-Year T-Note
      'ZB=F',    // 30-Year T-Bond
      'ZF=F',    // 5-Year T-Note
      '6E=F',    // Euro FX
      '6J=F',    // Japanese Yen
      '6B=F',    // British Pound
      '6C=F',    // Canadian Dollar
      '6A=F',    // Australian Dollar
      'HG=F',    // Copper
      'NG=F',    // Natural Gas
      'ZW=F',    // Wheat
      'ZC=F',    // Corn
      'ZS=F',    // Soybeans
      'ZL=F',    // Soybean Oil
    ];
    const SCAN_ALL = [...SCAN_STOCKS, ...SCAN_CRYPTO, ...SCAN_FUTURES];

    // ── Per-symbol processing helper ─────────────────────────────────────────
    async function processSymbol(bot: Record<string,unknown>, sym: string, settings: BotSettings): Promise<object> {
      try {
        const candles = await fetchCandles(sym, settings.interval, 150, bot.user_id as string);
        if (candles.length < 60) return { bot_id: bot.id, symbol: sym, status: 'skipped', reason: 'Not enough candle data' };

        // Check database for REAL open trade on this symbol
        const { data: realOpenTrade } = await supabase.from('trades')
          .select('id, action').eq('bot_id', bot.id as string).eq('symbol', sym)
          .eq('source', 'auto-bot').eq('status', 'filled').is('pnl', null)
          .limit(1).maybeSingle();
        const hasRealPosition = !!realOpenTrade;
        
        // Cooldown: don't re-enter if a trade was recently closed on this symbol
        const cooldownMinutes = Math.max(Number(settings.interval?.replace(/[^\d]/g, '')) || 5, 5);
        const cooldownAgo = new Date(Date.now() - cooldownMinutes * 60 * 1000).toISOString();
        const { data: recentlyClosed } = await supabase.from('trades')
          .select('id').eq('bot_id', bot.id as string).eq('symbol', sym)
          .eq('source', 'auto-bot').eq('status', 'closed')
          .gte('closed_at', cooldownAgo)
          .limit(1).maybeSingle();
        if (recentlyClosed && !hasRealPosition) {
          return { bot_id: bot.id, symbol: sym, status: 'skipped', reason: `Cooldown: trade closed within ${cooldownMinutes}m` };
        }

        const overrideSettings = { ...settings, symbol: sym };
        const botSignal = (bot.bot_signal as string) || 'supertrend';
        const tradeDirection = settings.tradeDirection || 'both';
        let signalResult: SignalResult;
        if (botSignal === 'rsi_macd') {
          signalResult = generateSignalRSIMACD(candles, tradeDirection);
        } else if (botSignal === 'boof20') {
          signalResult = generateSignalBoof20(candles, tradeDirection, 0.0, 0.0);
        } else if (botSignal === 'boof30') {
          signalResult = generateSignalBoof30(candles, tradeDirection);
        } else {
          signalResult = generateSignal(candles, overrideSettings);
        }
        let { signal, price, trend, ema, adx, reason } = signalResult;
        
        // Correct the signal using REAL database position state
        // The signal generators simulate inLong from historical candles, which may not match reality
        const simulatedInLong = reason.includes('inLong=true');
        
        if (hasRealPosition && !simulatedInLong) {
          // We HAVE a real position but simulation says we don't — treat as inLong
          // Only allow SELL signals, block new BUYs
          if (signal === 'buy') {
            return { bot_id: bot.id, symbol: sym, status: 'skipped', reason: `Already have real open ${realOpenTrade.action} position` };
          }
        }
        
        if (!hasRealPosition && simulatedInLong && signal === 'none') {
          // No real position but simulation thinks we're in one
          // Re-run signal check ignoring inLong state: use raw indicator values
          const closes = candles.map(c => c.close);
          const curClose = closes[closes.length - 2] ?? closes[closes.length - 1];
          
          if (botSignal === 'boof20') {
            const match = reason.match(/predicted_return=([-\d.]+)/);
            const predReturn = match ? parseFloat(match[1]) : 0;
            // Only buy if predicted return is meaningfully positive (>0.5%)
            if (predReturn > 0.005 && (tradeDirection === 'both' || tradeDirection === 'long')) {
              signal = 'buy';
              reason = `Boof 2.0 BUY (no real position, pred_ret=${predReturn.toFixed(4)}). ${reason}`;
            }
          } else if (botSignal === 'supertrend' || botSignal === 'boof10') {
            // For SuperTrend: check if current bar meets entry conditions
            const match = reason.match(/adx=([\d.]+)/);
            const curAdx = match ? parseFloat(match[1]) : 0;
            const emaMatch = reason.match(/ema50=([\d.]+)/);
            const stMatch = reason.match(/supertrend=([\d.]+)/);
            const curEma = emaMatch ? parseFloat(emaMatch[1]) : 0;
            const curSt = stMatch ? parseFloat(stMatch[1]) : 0;
            if (curAdx > 25 && curClose > curEma && curClose > curSt && (tradeDirection === 'both' || tradeDirection === 'long')) {
              signal = 'buy';
              reason = `Boof 1.0 BUY (no real position, adx=${curAdx.toFixed(1)}). ${reason}`;
            }
          }
          if (signal !== 'none') {
            console.log(`[AutoBot] ${sym} OVERRIDE: no real position → ${signal}`);
          }
        }
        
        console.log(`[AutoBot] ${sym} → ${signal} | ${reason}`);

        if (signal === 'buy'  && settings.tradeDirection === 'short') return { bot_id: bot.id, symbol: sym, status: 'skipped', reason: 'Direction: short only' };
        if (signal === 'sell' && settings.tradeDirection === 'long')  return { bot_id: bot.id, symbol: sym, status: 'skipped', reason: 'Direction: long only' };

        if (signal === 'none') {
          await supabase.from('stock_bot_logs').insert({ bot_id: bot.id, user_id: bot.user_id, symbol: sym, signal: 'none', price, trend, ema, adx, reason, created_at: new Date().toISOString() });
          return { bot_id: bot.id, symbol: sym, status: 'no_signal', reason };
        }

        // Trend Filter: Check higher timeframe trend
        const trendFilter = bot.trend_filter as string || 'none';
        if (trendFilter !== 'none') {
          try {
            const higherTfCandles = await fetchCandles(sym, trendFilter, 100, bot.user_id as string);
            if (higherTfCandles.length >= 50) {
              const higherTfCloses = higherTfCandles.map(c => c.close);
              const higherTfEma = calcEMA(higherTfCloses, 20);
              const currentPrice = higherTfCloses[higherTfCloses.length - 1];
              const higherTfEmaVal = higherTfEma[higherTfEma.length - 1];
              
              // Higher timeframe trend: price above EMA = uptrend, below = downtrend
              const higherTfTrend = currentPrice > higherTfEmaVal ? 'up' : 'down';
              
              // Filter signal: Only trade if aligned with higher timeframe
              if (signal === 'buy' && higherTfTrend === 'down') {
                console.log(`[AutoBot] ${sym} BUY blocked - ${trendFilter} trend is DOWN (price ${currentPrice.toFixed(2)} < EMA ${higherTfEmaVal.toFixed(2)})`);
                return { bot_id: bot.id, symbol: sym, status: 'skipped', reason: `BUY blocked: ${trendFilter} trend is DOWN` };
              }
              if (signal === 'sell' && higherTfTrend === 'up') {
                console.log(`[AutoBot] ${sym} SELL blocked - ${trendFilter} trend is UP (price ${currentPrice.toFixed(2)} > EMA ${higherTfEmaVal.toFixed(2)})`);
                return { bot_id: bot.id, symbol: sym, status: 'skipped', reason: `SELL blocked: ${trendFilter} trend is UP` };
              }
              console.log(`[AutoBot] ${sym} ${signal} approved - ${trendFilter} trend aligned (${higherTfTrend})`);
            }
          } catch (e) {
            console.log(`[AutoBot] ${sym} trend filter error: ${e}`);
          }
        }

        // Check for duplicate trade within 1 minute (race condition prevention)
        const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
        const { data: recentTrade } = await supabase.from('trades')
          .select('id, action').eq('bot_id', bot.id as string).eq('symbol', sym)
          .eq('source', 'auto-bot').gte('created_at', oneMinuteAgo)
          .limit(1).maybeSingle();
        if (recentTrade) {
          return { bot_id: bot.id, symbol: sym, status: 'skipped', reason: `Duplicate ${recentTrade.action} trade within 1 minute` };
        }

        // Check for existing open position on this symbol for this bot
        const { data: openTrade } = await supabase.from('trades')
          .select('*').eq('bot_id', bot.id as string).eq('symbol', sym)
          .eq('source', 'auto-bot').eq('status', 'filled').is('pnl', null)
          .order('created_at', { ascending: false }).limit(1).maybeSingle();

        if (openTrade) {
          if (openTrade.action === signal) {
            // Same direction already open - skip
            return { bot_id: bot.id, symbol: sym, status: 'skipped', reason: `Already in ${signal} position` };
          }
          // Opposite signal - close the open trade with P&L
          const entryPrice = Number(openTrade.entry_price || openTrade.price);
          const qty = Number(openTrade.quantity);
          const pnl = openTrade.action === 'buy'
            ? (price - entryPrice) * qty
            : (entryPrice - price) * qty;
          await supabase.from('trades').update({
            status: 'closed',
            exit_price: price,
            pnl: pnl,
            closed_at: new Date().toISOString(),
          }).eq('id', openTrade.id);
          console.log(`[AutoBot] Closed ${openTrade.action} on ${sym} | P&L: $${pnl.toFixed(2)}`);
        }

        // Check for pending limit orders from previous runs - convert to market if signal still valid
        const { data: pendingLimit } = await supabase.from('trades')
          .select('*').eq('bot_id', bot.id as string).eq('symbol', sym)
          .eq('source', 'auto-bot').eq('status', 'pending').eq('order_type', 'limit')
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        
        if (pendingLimit) {
          const limitPrice = Number(pendingLimit.price);
          const entryPrice = Number(pendingLimit.entry_price);
          const isBuy = pendingLimit.action === 'buy';
          const filled = isBuy ? price <= limitPrice : price >= limitPrice;
          
          // Max drawdown protection: Don't buy if stock dropped too much from original signal
          const maxDrawdownPct = Number(bot.limit_drawdown_pct) || 2.0; // Use bot setting or default 2%
          const drawdown = isBuy 
            ? ((entryPrice - price) / entryPrice) * 100  // How much it dropped
            : ((price - entryPrice) / entryPrice) * 100; // How much it rose (for shorts)
          
          if (drawdown > maxDrawdownPct) {
            // Stock moved too far against us - cancel limit order
            await supabase.from('trades').update({ 
              status: 'cancelled',
              reason: `Cancelled: ${drawdown.toFixed(2)}% drawdown exceeded ${maxDrawdownPct}% max`
            }).eq('id', pendingLimit.id);
            console.log(`[AutoBot] Cancelled limit for ${sym} - ${drawdown.toFixed(2)}% drawdown, signal price ${entryPrice}, current ${price}`);
            return { bot_id: bot.id, symbol: sym, status: 'cancelled', reason: 'Max drawdown exceeded' };
          }
          
          // Check time limit
          const limitTimeMin = Number(bot.limit_time_min) || 2;
          const orderAgeMs = Date.now() - new Date(pendingLimit.created_at).getTime();
          const orderAgeMin = orderAgeMs / (1000 * 60);
          const timeLimitExceeded = orderAgeMin >= limitTimeMin;
          
          if (filled) {
            // Limit order would have filled - update to filled status
            await supabase.from('trades').update({
              status: 'filled',
              filled_at: new Date().toISOString(),
            }).eq('id', pendingLimit.id);
            console.log(`[AutoBot] Limit order filled for ${sym} at ~${limitPrice}`);
            return { bot_id: bot.id, symbol: sym, status: 'filled', signal, price: limitPrice, quantity: pendingLimit.quantity };
          } else if (signal === pendingLimit.action && timeLimitExceeded) {
            // Time limit exceeded - convert to market order
            await supabase.from('trades').update({
              order_type: 'market',
              price: price,
              entry_price: price,
              status: 'filled',
              filled_at: new Date().toISOString(),
            }).eq('id', pendingLimit.id);
            console.log(`[AutoBot] Time limit (${limitTimeMin}min) exceeded - converted limit to market for ${sym} at ${price}`);
            return { bot_id: bot.id, symbol: sym, status: 'filled', signal, price, quantity: pendingLimit.quantity };
          } else if (signal !== pendingLimit.action) {
            // Signal reversed - cancel the limit order
            await supabase.from('trades').update({ status: 'cancelled' }).eq('id', pendingLimit.id);
            console.log(`[AutoBot] Cancelled limit order for ${sym} - signal reversed`);
          } else {
            // Still waiting - signal valid but limit not hit and time not exceeded
            console.log(`[AutoBot] Limit order pending for ${sym} at ${limitPrice} (current ${price}, ${orderAgeMin.toFixed(1)}min/${limitTimeMin}min)`);
            return { bot_id: bot.id, symbol: sym, status: 'pending', reason: `Limit pending ${orderAgeMin.toFixed(1)}min/${limitTimeMin}min` };
          }
        }

        // Double-check no open position (race condition prevention)
        const { data: stillOpen } = await supabase.from('trades')
          .select('id').eq('bot_id', bot.id as string).eq('symbol', sym)
          .eq('source', 'auto-bot').eq('status', 'filled').is('pnl', null)
          .limit(1);
        if (stillOpen && stillOpen.length > 0) {
          return { bot_id: bot.id, symbol: sym, status: 'skipped', reason: 'Position already opened by parallel process' };
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
          const useLimitOrders = bot.use_limit_orders || false;
          const limitOffsetPct = bot.limit_offset_pct || 0.5;
          
          if (useLimitOrders && signal === 'buy') {
            // Place limit order at better price
            const limitPrice = price * (1 - Number(limitOffsetPct) / 100);
            
            // Insert as pending limit order
            await supabase.from('trades').insert({
              user_id: bot.user_id,
              bot_id: bot.id,
              symbol: sym,
              action: signal,
              direction: 'Long',
              quantity: quantity,
              price: limitPrice,
              entry_price: price,  // Store original signal price for drawdown calc
              order_type: 'limit',
              broker: 'alpaca',
              source: 'auto-bot',
              status: 'pending',
              created_at: new Date().toISOString(),
            });
            
            console.log(`[AutoBot] Alpaca limit order placed: ${sym} at $${limitPrice.toFixed(2)} (current $${price.toFixed(2)}, offset -${limitOffsetPct}%)`);
            return { bot_id: bot.id, symbol: sym, status: 'pending', signal, price: limitPrice, quantity, order_type: 'limit' };
          } else {
            // Market order
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
          }
        } else {
          // Paper trading: check if we should use limit orders
          const useLimitOrders = bot.use_limit_orders || false;
          const limitOffsetPct = bot.limit_offset_pct || 0.5; // Default 0.5% better price
          
          if (useLimitOrders && signal === 'buy') {
            // Place limit order at better price (below current for buys)
            const limitPrice = price * (1 - Number(limitOffsetPct) / 100);
            
            // Insert as pending limit order
            await supabase.from('trades').insert({
              user_id: bot.user_id,
              bot_id: bot.id,
              symbol: sym,
              action: signal,
              direction: 'Long',
              quantity: quantity,
              price: limitPrice,
              entry_price: limitPrice,
              order_type: 'limit',
              broker: 'paper',
              source: 'auto-bot',
              status: 'pending',
              created_at: new Date().toISOString(),
            });
            
            console.log(`[AutoBot] Paper limit order placed: ${sym} at $${limitPrice.toFixed(2)} (current $${price.toFixed(2)}, offset -${limitOffsetPct}%)`);
            return { bot_id: bot.id, symbol: sym, status: 'pending', signal, price: limitPrice, quantity, order_type: 'limit' };
          } else {
            // Market order (existing behavior)
            const tradeValue = quantity * price;
            const { data: botRow } = await supabase.from('stock_bots').select('paper_balance').eq('id', bot.id as string).single();
            const currentBalance = Number(botRow?.paper_balance ?? 100000);
            const newBalance = signal === 'buy'
              ? currentBalance - tradeValue
              : currentBalance + tradeValue;
            await supabase.from('stock_bots').update({ paper_balance: Math.max(0, newBalance) }).eq('id', bot.id as string);
          }
        }

        // Insert trade into main trades table (visible on trades page)
        const { data: trade } = await supabase.from('trades').insert({
          user_id: bot.user_id,
          bot_id: bot.id,
          symbol: sym,
          action: signal,
          direction: signal === 'buy' ? 'Long' : 'Short',
          quantity: quantity,
          price: price,
          entry_price: price,
          order_type: 'market',
          broker: bot.broker || 'paper',
          source: 'auto-bot',
          status: tradeStatus === 'filled' ? 'filled' : 'pending',
          filled_at: tradeStatus === 'filled' ? new Date().toISOString() : null,
          created_at: new Date().toISOString(),
        }).select().single();

        await supabase.from('stock_bot_logs').insert({ bot_id: bot.id, user_id: bot.user_id, symbol: sym, signal, price, trend, ema, adx, reason, trade_id: trade?.id || null, created_at: new Date().toISOString() });

        // Trigger options bot ONLY after stock order is FILLED (not pending)
        // This ensures options don't trade unless stock actually fills
        if (tradeStatus === 'filled' && trade?.id) {
          try {
            // Get enabled options bots and their scan lists (with interval for matching)
            const { data: optsBots } = await supabase.from('options_bots')
              .select('id, bot_scan_mode, bot_symbol, bot_interval')
              .eq('user_id', bot.user_id)
              .eq('enabled', true)
              .eq('auto_submit', true);
            
            // Check if any options bot scans this symbol AND has matching interval
            const stockInterval = bot.bot_interval || '1h';
            const scansSymbol = optsBots?.some(ob => {
              // Only sync if intervals match (e.g., 5min stock → 5min options)
              const optsInterval = ob.bot_interval || '1h';
              if (optsInterval !== stockInterval) {
                console.log(`[AutoBot] Skipping options bot "${ob.id}" - interval mismatch (stock=${stockInterval}, options=${optsInterval})`);
                return false;
              }
              if (ob.bot_scan_mode === 'single') return ob.bot_symbol === sym;
              if (ob.bot_scan_mode === 'scan_stocks') {
                const SCAN_STOCKS = ['AAPL','MSFT','AMZN','NVDA','TSLA','GOOG','GOOGL','META','NFLX','BRK-B','JPM','BAC','WFC','V','MA','PG','KO','PFE','UNH','HD','INTC','CSCO','ADBE','CRM','ORCL','AMD','QCOM','TXN','IBM','AVGO','XOM','CVX','BA','CAT','MMM','GE','HON','LMT','NOC','DE','C','GS','MS','AXP','BLK','SCHW','BK','SPGI','ICE','MRK','ABBV','AMGN','BMY','LLY','GILD','JNJ','REGN','VRTX','BIIB','WMT','COST','TGT','LOW','MCD','SBUX','NKE','BKNG','SNAP','UBER','LYFT','SPOT','ZM','DOCU','PINS','ROKU','SHOP','CVS','TMO','MDT','ISRG','F','GM','SNOW','CRWD','NET','DDOG','MDB','OKTA','SPLK','FSLR','ENPH','SEDG','DKNG','CHPT','LCID','RIVN','HOOD','SOFI','AI','PLTR','ASML','MU','LRCX','KLAC','AMAT','MRVL','NXPI','CDNS','SNPS','ANET','FTNT','PANW','GME','AMC','BBBY','EXPR','KOSS','NAKD','SNDL','TLRY','ACB','CGC','QQQ','SPY','VOO','IVV','VTI','VUG','QQQM','SCHG','XLK','VGT','SMH','TQQQ'];
                return SCAN_STOCKS.includes(sym);
              }
              if (ob.bot_scan_mode === 'scan_etfs') return ['QQQ','SPY','VOO','IVV','VTI','VUG','QQQM','SCHG','XLK','VGT','SMH','TQQQ'].includes(sym);
              if (ob.bot_scan_mode === 'scan_top10') return ['SMCI','TSLA','NVDA','COIN','PLTR','AMD','MRNA','MSTY','ENPH','VKTX','CCL'].includes(sym);
              return false;
            });
            
            if (scansSymbol) {
              const optionsBotUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/options-bot`;
              fetch(optionsBotUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
                },
                body: JSON.stringify({
                  user_id: bot.user_id,
                  symbol: sym,
                  signal: signal,
                  trigger_source: 'auto-bot-sync',
                  price: price,
                  stock_trade_id: trade.id, // Pass stock trade ID for tracking
                  stock_trade_status: tradeStatus, // 'filled' or 'pending'
                }),
              }).catch(() => {}); // Fire and forget, don't wait
              console.log(`[AutoBot] Triggered options-bot for ${sym} ${signal} (stock ${tradeStatus}, symbol in scan list)`);
            } else {
              console.log(`[AutoBot] Skipped options trigger - ${sym} not in any options bot scan list`);
            }
          } catch (_) { /* ignore trigger errors */ }
        } else {
          console.log(`[AutoBot] Skipped options trigger - stock order failed or no trade ID`);
        }

        return { bot_id: bot.id, status: tradeStatus, signal, symbol: sym, price, quantity, order_id: orderId, reason, broker_error: brokerError };
      } catch (err) {
        return { bot_id: bot.id, symbol: sym, status: 'error', error: String(err) };
      }
    }

    // ── Main loop ────────────────────────────────────────────────────────────
    const results: object[] = [];
    const now = new Date();
    
    // Check market hours (crypto/futures trade 24/7, stocks only 9:30 AM - 4:00 PM ET)
    const etNow = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const hour = etNow.getHours();
    const minute = etNow.getMinutes();
    const day = etNow.getDay();
    const isWeekday = day >= 1 && day <= 5;
    const isStockMarketHours = isWeekday && (hour > 9 || (hour === 9 && minute >= 30)) && hour < 16;

    for (const bot of bots) {
      // Check if bot should run based on run_interval_min
      const runIntervalMin = (bot.run_interval_min as number) ?? 15;
      const lastRunAt = bot.last_run_at ? new Date(bot.last_run_at as string) : null;
      const minutesSinceLastRun = lastRunAt ? (now.getTime() - lastRunAt.getTime()) / (1000 * 60) : Infinity;
      
      if (minutesSinceLastRun < runIntervalMin) {
        console.log(`[AutoBot] Skipping "${bot.name}" - ran ${minutesSinceLastRun.toFixed(1)}m ago, interval=${runIntervalMin}m`);
        continue;
      }
      
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

      // New multi-select scan markets
      const scanStocks = bot.scan_stocks || false;
      const scanCrypto = bot.scan_crypto || false;
      const scanFutures = bot.scan_futures || false;
      
      // Check if bot is trading stocks after hours
      if (scanStocks && !isStockMarketHours) {
        console.log(`[AutoBot] Skipping "${bot.name}" - stock markets closed (${etNow.toLocaleTimeString('en-US', {timeZone: 'America/New_York'})} ET)`);
        continue;
      }
      
      console.log(`[AutoBot] Running "${bot.name}" | stocks=${scanStocks}, crypto=${scanCrypto}, futures=${scanFutures} | ${settings.interval} | interval=${runIntervalMin}m`);

      try {
        if (scanStocks) {
          for (const sym of SCAN_STOCKS) {
            const result = await processSymbol(bot, sym, settings);
            results.push(result);
          }
        }
        if (scanCrypto) {
          for (const sym of SCAN_CRYPTO) {
            const result = await processSymbol(bot, sym, settings);
            results.push(result);
          }
        }
        if (scanFutures) {
          for (const sym of SCAN_FUTURES) {
            const result = await processSymbol(bot, sym, settings);
            results.push(result);
          }
        }
        
        // Update last_run_at after successful processing
        await supabase.from('stock_bots').update({ last_run_at: now.toISOString() }).eq('id', bot.id);
        
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
