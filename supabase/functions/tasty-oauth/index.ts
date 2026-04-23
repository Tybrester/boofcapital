const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// TODO: Replace with your tastytrade OAuth credentials after developer approval
const TASTY_CLIENT_ID = Deno.env.get('TASTY_CLIENT_ID') || '';
const TASTY_CLIENT_SECRET = Deno.env.get('TASTY_CLIENT_SECRET') || '';
const TASTY_REDIRECT_URI = Deno.env.get('TASTY_REDIRECT_URI') || 'https://your-app.com/tasty-callback.html';
const TASTY_OAUTH_URL = 'https://api.tastytrade.com/oauth/authorize'; // Verify actual endpoint
const TASTY_TOKEN_URL = 'https://api.tastytrade.com/oauth/token'; // Verify actual endpoint

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  // Step 1: Generate OAuth login URL
  if (action === 'login') {
    const userId = url.searchParams.get('user_id');
    if (!userId) {
      return new Response(JSON.stringify({ error: 'user_id required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Store state in Supabase for verification
    const state = crypto.randomUUID();
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    await supabase.from('oauth_states').insert({ state, user_id: userId, created_at: new Date().toISOString() });

    const loginUrl = `${TASTY_OAUTH_URL}?client_id=${TASTY_CLIENT_ID}&redirect_uri=${encodeURIComponent(TASTY_REDIRECT_URI)}&response_type=code&state=${state}`;

    return new Response(JSON.stringify({ login_url: loginUrl }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Step 2: Exchange code for tokens (called from callback page)
  if (action === 'callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code || !state) {
      return new Response(JSON.stringify({ error: 'code and state required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    try {
      // Exchange code for tokens
      const tokenRes = await fetch(TASTY_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: TASTY_REDIRECT_URI,
          client_id: TASTY_CLIENT_ID,
          client_secret: TASTY_CLIENT_SECRET
        })
      });

      const tokens = await tokenRes.json();
      if (tokens.error) throw new Error(tokens.error_description || tokens.error);

      // Store tokens in Supabase
      const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
      
      // Get user_id from state
      const { data: stateData } = await supabase.from('oauth_states').select('user_id').eq('state', state).single();
      if (!stateData) throw new Error('Invalid state');

      await supabase.from('broker_credentials').upsert({
        user_id: stateData.user_id,
        broker: 'tastytrade',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,broker' });

      // Clean up state
      await supabase.from('oauth_states').delete().eq('state', state);

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }

  return new Response(JSON.stringify({ error: 'Invalid action' }), {
    status: 400,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
});

// Supabase client helper
function createClient(url: string, key: string) {
  return {
    from: (table: string) => ({
      insert: async (data: any) => {
        await fetch(`${url}/rest/v1/${table}`, {
          method: 'POST',
          headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify(data)
        });
        return { data: null, error: null };
      },
      select: (cols: string) => ({
        eq: (col: string, val: string) => ({
          single: async () => {
            const r = await fetch(`${url}/rest/v1/${table}?${col}=eq.${val}&select=${cols}`, {
              headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
            });
            return { data: await r.json(), error: null };
          }
        }),
        delete: async () => {
          await fetch(`${url}/rest/v1/${table}?${col}=eq.${val}`, {
            method: 'DELETE',
            headers: { 'apikey': key, 'Authorization': `Bearer ${key}` }
          });
          return { data: null, error: null };
        }
      }),
      upsert: async (data: any, opts?: any) => {
        await fetch(`${url}/rest/v1/${table}`, {
          method: 'POST',
          headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify(data)
        });
        return { data: null, error: null };
      }
    })
  };
}
