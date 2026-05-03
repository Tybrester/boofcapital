-- Check if auto-bot-1min was created
SELECT * FROM cron.job WHERE jobname = 'auto-bot-1min';

-- Check ALL cron jobs again
SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobname;

-- Check recent runs to see if it's executing
SELECT 
    jobid,
    jobname,
    status,
    start_time,
    end_time
FROM cron.job_run_details
ORDER BY start_time DESC
LIMIT 10;
