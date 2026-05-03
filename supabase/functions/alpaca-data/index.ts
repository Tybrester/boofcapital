import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { user_id, symbol, interval = '1h', bars = 150, type = 'candles' } = await req.json();
    
    if (!user_id || !symbol) {
      return new Response(JSON.stringify({ error: 'user_id and symbol are required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Fetch Alpaca credentials
    const { data: creds } = await supabase
      .from('broker_credentials')
      .select('credentials')
      .eq('user_id', user_id)
      .eq('broker', 'alpaca')
      .maybeSingle();

    if (!creds?.credentials?.apiKey || !creds?.credentials?.secretKey) {
      return new Response(JSON.stringify({ error: 'Alpaca credentials not found' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { apiKey, secretKey } = creds.credentials;
    const alpacaSymbol = symbol.toUpperCase();

    // Map intervals to Alpaca format
    const alpacaTimeframe: Record<string, string> = {
      '1m': '1Min', '5m': '5Min', '15m': '15Min', '30m': '30Min',
      '1h': '1Hour', '4h': '4Hour', '1d': '1Day'
    };
    const timeframe = alpacaTimeframe[interval] || '1Hour';

    if (type === 'price') {
      // Get latest quote/snapshot
      const url = `https://data.alpaca.markets/v2/stocks/${alpacaSymbol}/snapshot`;
      const res = await fetch(url, {
        headers: {
          'APCA-API-KEY-ID': apiKey,
          'APCA-API-SECRET-KEY': secretKey,
        }
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Alpaca API error: ${res.status} - ${text}`);
      }

      const data = await res.json();
      const price = data?.latestTrade?.p || data?.quote?.ap || data?.quote?.bp || null;

      return new Response(JSON.stringify({ 
        symbol: alpacaSymbol, 
        price,
        timestamp: data?.latestTrade?.t,
        source: 'alpaca'
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }});

    } else {
      // Get historical bars (candles)
      // Calculate start date based on bars needed
      const end = new Date().toISOString();
      const start = new Date(Date.now() - (bars * 24 * 60 * 60 * 1000)).toISOString(); // Conservative: request more days
      
      const url = `https://data.alpaca.markets/v2/stocks/${alpacaSymbol}/bars?timeframe=${timeframe}&start=${start}&end=${end}&limit=${bars}`;
      
      const res = await fetch(url, {
        headers: {
          'APCA-API-KEY-ID': apiKey,
          'APCA-API-SECRET-KEY': secretKey,
        }
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Alpaca API error: ${res.status} - ${text}`);
      }

      const data = await res.json();
      const barsData = data?.bars || [];

      const candles: Candle[] = barsData.map((b: any) => ({
        time: new Date(b.t).getTime(),
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v
      }));

      return new Response(JSON.stringify({ 
        symbol: alpacaSymbol, 
        candles,
        count: candles.length,
        source: 'alpaca'
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
    }

  } catch (err) {
    console.error('[AlpacaData] Error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
