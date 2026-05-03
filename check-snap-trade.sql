-- Check your SNAP trade details
SELECT 
    id,
    symbol,
    action,
    price as entry_price,
    quantity,
    status,
    created_at,
    pnl as realized_pnl
FROM trades
WHERE symbol = 'SNAP' 
  AND status = 'filled'
  AND created_at >= CURRENT_DATE - INTERVAL '1 day'
ORDER BY created_at DESC
LIMIT 5;

-- Check if quantity is stored correctly
SELECT 
    id,
    symbol,
    quantity,
    typeof(quantity) as qty_type,
    bot_quantity
FROM trades
WHERE symbol = 'SNAP'
  AND created_at >= CURRENT_DATE - INTERVAL '1 day';
