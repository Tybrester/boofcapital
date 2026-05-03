const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const cache: Record<string, { price: number; bid: number; ask: number; last: number; ts: number }> = {};

// Tradier API - free sandbox or $15/month for real-time
const TRADIER_BASE_URL = 'https://sandbox.tradier.com/v1'; // Use prod URL for live: https://api.tradier.com/v1

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const symbol = url.searchParams.get('symbol'); // e.g. "SPY241231C00580000"
    if (!symbol) return new Response(JSON.stringify({ price: null }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

    const noCache = url.searchParams.get('nocache') === 'true';
    const cached = cache[symbol];
    
    // Return cached if within 15 seconds (for 1-min checks)
    if (!noCache && cached && Date.now() - cached.ts < 15000) {
      return new Response(JSON.stringify({ ...cached, cached: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const tradierToken = Deno.env.get('TRADIER_ACCESS_TOKEN');
    
    if (!tradierToken) {
      // Fallback: estimate from underlying (Black-Scholes approximation)
      return new Response(JSON.stringify({ 
        price: null, 
        error: 'TRADIER_ACCESS_TOKEN not set - real option prices unavailable',
        fallback: 'black_scholes'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Fetch real option quote from Tradier
    const res = await fetch(`${TRADIER_BASE_URL}/markets/quotes?symbols=${encodeURIComponent(symbol)}&greeks=false`, {
      headers: {
        'Authorization': `Bearer ${tradierToken}`,
        'Accept': 'application/json'
      }
    });

    if (!res.ok) {
      throw new Error(`Tradier API error: ${res.status}`);
    }

    const data = await res.json();
    const quote = data?.quotes?.quote;
    
    if (!quote || !quote.last) {
      return new Response(JSON.stringify({ price: null, error: 'No quote available' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const result = {
      price: quote.last,
      bid: quote.bid || quote.last,
      ask: quote.ask || quote.last,
      last: quote.last,
      change: quote.change,
      change_percent: quote.change_percentage,
      volume: quote.volume,
      open_interest: quote.open_interest,
      ts: Date.now()
    };

    cache[symbol] = result;

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ price: null, error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
