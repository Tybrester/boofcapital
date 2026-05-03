import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { user_id, symbol, side, qty, notional, limit_price, order_type } = await req.json();
    if (!user_id || !symbol || !side) {
      return new Response(JSON.stringify({ error: 'user_id, symbol, side are required' }), {
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

    if (!creds) {
      return new Response(JSON.stringify({ error: 'No Alpaca credentials found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { api_key, secret_key, env } = creds.credentials;
    const baseUrl = env === 'live'
      ? 'https://api.alpaca.markets'
      : 'https://paper-api.alpaca.markets';

    // Build order — use notional (dollar amount) if no qty specified
    const isLimit = order_type === 'limit' && limit_price;
    const orderBody: Record<string, unknown> = {
      symbol: symbol.toUpperCase(),
      side,           // 'buy' or 'sell'
      type: isLimit ? 'limit' : 'market',
      time_in_force: 'day',
    };

    if (isLimit) {
      orderBody.limit_price = String(limit_price);
    }

    if (qty) {
      orderBody.qty = String(qty);
    } else if (notional) {
      orderBody.notional = String(notional);
    } else {
      return new Response(JSON.stringify({ error: 'qty or notional required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

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
      return new Response(JSON.stringify({ error: order.message || 'Alpaca order failed', detail: order }), {
        status: res.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ success: true, order_id: order.id, status: order.status, order }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
