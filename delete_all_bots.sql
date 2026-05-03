-- Delete all trades first (foreign key constraints)
DELETE FROM stock_trades 
WHERE user_id = 'd0bb84ba-f968-446c-9792-9bcff8849e37';

DELETE FROM options_trades 
WHERE user_id = 'd0bb84ba-f968-446c-9792-9bcff8849e37';

-- Delete all options bots
DELETE FROM options_bots 
WHERE user_id = 'd0bb84ba-f968-446c-9792-9bcff8849e37';

-- Delete all stock bots
DELETE FROM stock_bots 
WHERE user_id = 'd0bb84ba-f968-446c-9792-9bcff8849e37';
