-- Check ALL options bot trades for today
SELECT 
    bot_id,
    symbol,
    signal,
    status,
    created_at,
    updated_at
FROM options_trades
WHERE created_at >= CURRENT_DATE
ORDER BY created_at DESC;

-- Check how many trades per bot today
SELECT 
    bot_id,
    COUNT(*) as trade_count,
    COUNT(CASE WHEN status = 'open' THEN 1 END) as open_count,
    COUNT(CASE WHEN status = 'closed' THEN 1 END) as closed_count
FROM options_trades
WHERE created_at >= CURRENT_DATE
GROUP BY bot_id;

-- Check recent bot activity (last 24 hours)
SELECT 
    id,
    name,
    enabled,
    auto_submit,
    bot_scan_mode,
    bot_interval,
    last_run_at,
    created_at
FROM options_bots
WHERE last_run_at >= NOW() - INTERVAL '24 hours'
ORDER BY last_run_at DESC;
