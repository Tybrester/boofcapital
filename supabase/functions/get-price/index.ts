const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const cache: Record<string, { price: number; ts: number }> = {};

const futuresMap: Record<string, string> = {
  'CL1!': 'CL=F', 'ES1!': 'ES=F', 'NQ1!': 'NQ=F', 'GC1!': 'GC=F',
  'SI1!': 'SI=F', 'NG1!': 'NG=F', 'ZB1!': 'ZB=F', 'ZN1!': 'ZN=F',
  'YM1!': 'YM=F', 'RTY1!': 'RTY=F', 'MES1!': 'MES=F', 'MNQ1!': 'MNQ=F',
};

function normalizeSymbol(symbol: string): string {
  let s = symbol.includes(':') ? symbol.split(':')[1] : symbol;
  if (futuresMap[s]) return futuresMap[s];
  if (s.endsWith('!')) s = s.replace('!', '=F');
  if (s.endsWith('USDT')) s = s.replace('USDT', '-USD');
  return s;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const symbol = url.searchParams.get('symbol');
    if (!symbol) return new Response(JSON.stringify({ price: null }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

    const ticker = normalizeSymbol(symbol);
    const noCache = url.searchParams.get('nocache') === 'true';

    // Return cached price if within 5 seconds (unless nocache requested)
    const cached = cache[ticker];
    if (!noCache && cached && Date.now() - cached.ts < 5000) {
      return new Response(JSON.stringify({ price: cached.price, ticker, cached: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // URL encode ticker for Yahoo Finance (handle = in futures symbols)
    const encodedTicker = encodeURIComponent(ticker);
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodedTicker}?interval=1m&range=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const json = await res.json();
    const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice || null;
    if (price) cache[ticker] = { price, ts: Date.now() };

    return new Response(JSON.stringify({ price, ticker }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ price: null, error: String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
