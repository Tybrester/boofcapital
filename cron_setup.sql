SELECT cron.schedule(
  'auto-bot-hourly',
  '0 * * * *',
  $$SELECT net.http_post(url:='https://isanhutzyctcjygjhzbn.supabase.co/functions/v1/auto-bot',headers:='{"Content-Type":"application/json"}'::jsonb,body:='{}'::jsonb)$$
);
