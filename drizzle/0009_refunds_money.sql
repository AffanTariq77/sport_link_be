-- Refunds are never negative (money checks live here because Drizzle cannot express them).
ALTER TABLE refunds ADD CONSTRAINT refunds_money_chk CHECK (amount >= 0);
