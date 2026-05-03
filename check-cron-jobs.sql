-- Check all your cron jobs
SELECT 
    jobid,
    jobname,
    schedule,
    active
FROM cron.job
ORDER BY jobname;

-- Check recent runs for auto-bot jobs
SELECT 
    jobname,
    status,
    start_time,
    end_time,
    EXTRACT(EPOCH FROM (end_time - start_time)) as duration_seconds
FROM cron.job_run_details
WHERE jobname LIKE '%auto-bot%' OR jobname LIKE '%stock%' OR jobname LIKE '%options%'
ORDER BY start_time DESC
LIMIT 20;
