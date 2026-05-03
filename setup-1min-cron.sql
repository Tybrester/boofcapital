-- Create a 1-minute cron job for auto-bot stock scanning
-- Run this in Supabase SQL Editor

-- First, remove any existing auto-bot cron jobs (optional - only if you want to replace)
-- SELECT cron.unschedule('auto-bot-1min');

-- Create the 1-minute cron job
SELECT cron.schedule(
    'auto-bot-1min',      -- job name
    '* * * * *',          -- every 1 minute
    $$
    SELECT net.http_post(
        url := 'https://your-project-ref.supabase.co/functions/v1/auto-bot',
        headers := jsonb_build_object(
            'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'SUPABASE_SERVICE_ROLE_KEY'),
            'Content-Type', 'application/json'
        ),
        body := '{}'::jsonb
    ) AS request_id;
    $$
);

-- Verify it was created
SELECT * FROM cron.job;

-- Check job runs
SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;
