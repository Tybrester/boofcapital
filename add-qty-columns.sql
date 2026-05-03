-- Add close_order_id and broker columns to options_trades table (for Alpaca live trading)
ALTER TABLE options_trades 
ADD COLUMN IF NOT EXISTS close_order_id VARCHAR(255),
ADD COLUMN IF NOT EXISTS broker VARCHAR(50) DEFAULT 'paper',
ADD COLUMN IF NOT EXISTS broker_error TEXT;

-- Verify the columns were added
SELECT column_name, data_type, column_default 
FROM information_schema.columns 
WHERE table_name = 'options_trades' 
AND column_name IN ('close_order_id', 'broker', 'broker_error', 'order_id');
