import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const userId = url.searchParams.get('user_id');
    const systemId = url.searchParams.get('system_id');

    if (!userId || !systemId) {
      return new Response(JSON.stringify({ error: 'Missing user_id or system_id' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Validate system belongs to user and is enabled
    const { data: system, error: sysErr } = await supabase
      .from('systems')
      .select('*')
      .eq('id', systemId)
      .eq('user_id', userId)
      .single();

    if (sysErr || !system) {
      return new Response(JSON.stringify({ error: 'System not found or unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!system.enabled) {
      return new Response(JSON.stringify({ error: 'System is disabled' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Parse TradingView payload — accept common field name variants
    const body = await req.json();
    const action    = (body.action || body.side || body.signal || body.direction_action || 'buy').toLowerCase();
    const symbol    = (body.symbol || body.ticker || body.instrument || body.asset || '').toUpperCase();
    const quantity  = parseFloat(body.quantity || body.qty || body.size || body.contracts || body.amount || 1);
    const orderType = body.order_type || body.orderType || body.type || 'market';
    const broker    = system.broker || body.broker || body.account || 'paper';

    // Fetch live price — accept common aliases
    let price = parseFloat(body.price || body.close || body.entry_price || body.last || 0) || null;
    if (!price) {
      try {
        let ticker = symbol.includes(':') ? symbol.split(':')[1] : symbol;
        if (ticker.endsWith('USDT')) ticker = ticker.replace('USDT', '-USD');
        const priceRes = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1m&range=1d`
        );
        const priceJson = await priceRes.json();
        price = priceJson?.chart?.result?.[0]?.meta?.regularMarketPrice || null;
      } catch (_) { price = null; }
    }

    // Handle paper trading with balance check
    const isPaperBroker = broker === 'paper' || broker === 'booftrade paper' || broker === 'EasyTrade Paper';
    let tradeStatus = 'open';
    let failureReason = null;
    let finalPrice = price;
    
    if (isPaperBroker && system.auto_submit && price) {
      const cost = price * quantity;
      const { data: acct } = await supabase.from('paper_accounts').select('*').eq('user_id', userId).maybeSingle();
      const currentBalance = acct?.balance ?? 100000;
      
      // Check sufficient balance for buy orders BEFORE creating trade
      if (action === 'buy' && cost > currentBalance) {
        // Go straight to failed - don't even try to fill
        tradeStatus = 'failed';
        failureReason = `Insufficient funds: trade cost $${cost.toFixed(2)} exceeds balance $${currentBalance.toFixed(2)}`;
      } else {
        // Sufficient balance - fill immediately
        tradeStatus = 'filled';
        if (acct) {
          const newBalance = action === 'buy' ? acct.balance - cost : acct.balance + cost;
          await supabase.from('paper_accounts').update({ balance: newBalance, updated_at: new Date().toISOString() }).eq('user_id', userId);
        } else {
          await supabase.from('paper_accounts').insert({ user_id: userId, balance: action === 'buy' ? 100000 - cost : 100000 + cost });
        }
      }
    }

    // Insert trade record with final status
    const { data: trade, error: tradeErr } = await supabase.from('trades').insert({
      user_id: userId,
      system_id: systemId,
      symbol,
      action,
      quantity,
      price: finalPrice,
      order_type: orderType,
      broker,
      status: tradeStatus,
      failure_reason: failureReason,
      payload: body,
      created_at: new Date().toISOString(),
    }).select().single();

    if (tradeErr) {
      return new Response(JSON.stringify({ error: tradeErr.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Handle tastytrade — place real order via direct API
    if (broker === 'tastytrade' && system.auto_submit) {
      try {
        const { data: credRow } = await supabase
          .from('broker_credentials')
          .select('credentials')
          .eq('user_id', userId)
          .eq('broker', 'tastytrade')
          .maybeSingle();

        if (credRow?.credentials) {
          const { username, password } = credRow.credentials;

          // 1. Authenticate — use remember-token if available to skip device challenge
          const { remember_token } = credRow.credentials;
          const sessionRes = await fetch('https://api.tastytrade.com/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              remember_token
                ? { login: username, password, 'remember-me': true, 'remember-token': remember_token }
                : { login: username, password, 'remember-me': true }
            )
          });
          const sessionJson = await sessionRes.json();
          const sessionToken = sessionJson?.data?.['session-token'];
          if (!sessionToken) throw new Error('tastytrade auth failed');

          // 2. Get first account number
          const acctRes = await fetch('https://api.tastytrade.com/customers/me/accounts', {
            headers: { Authorization: sessionToken }
          });
          const acctJson = await acctRes.json();
          const accountNumber = acctJson?.data?.items?.[0]?.account?.['account-number'];
          if (!accountNumber) throw new Error('No tastytrade account found');

          // 3. Place order
          const orderAction = action === 'buy' ? 'Buy to Open' : 'Sell to Close';
          const orderRes = await fetch(`https://api.tastytrade.com/accounts/${accountNumber}/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: sessionToken },
            body: JSON.stringify({
              'order-type': orderType === 'limit' ? 'Limit' : 'Market',
              'time-in-force': 'Day',
              legs: [{
                'instrument-type': 'Equity',
                symbol,
                quantity,
                action: orderAction
              }]
            })
          });
          const orderJson = await orderRes.json();
          const orderId = orderJson?.data?.order?.id;

          await supabase.from('trades').update({
            status: 'filled',
            broker_order_id: orderId || null
          }).eq('id', trade.id);

          // 4. Destroy session
          await fetch('https://api.tastytrade.com/sessions', {
            method: 'DELETE',
            headers: { Authorization: sessionToken }
          });
        }
      } catch (tastyErr) {
        // Log error on trade but don't fail the webhook
        await supabase.from('trades').update({ status: 'open', broker_error: String(tastyErr) }).eq('id', trade.id);
      }
    }

    return new Response(JSON.stringify({ success: true, trade_id: trade.id, symbol, action, price, quantity, status: tradeStatus }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
