-- Constraints Drizzle cannot express. See docs/SPEC.md sections 6 and 14.

-- A booking must end after it starts.
ALTER TABLE bookings ADD CONSTRAINT bookings_time_order_chk CHECK (end_at > start_at);
--> statement-breakpoint
-- Money is never negative on bookings and shares.
ALTER TABLE bookings ADD CONSTRAINT bookings_money_chk CHECK (total >= 0 AND advance_due >= 0 AND advance_due <= total);
--> statement-breakpoint
ALTER TABLE booking_shares ADD CONSTRAINT booking_shares_money_chk CHECK (amount >= 0 AND advance_amount >= 0 AND advance_amount <= amount);
--> statement-breakpoint
-- THE double-booking guarantee: no two active bookings (including holds, manual bookings
-- and maintenance blocks) may overlap on the same court. '[)' means a slot ending at 10:00
-- does not clash with one starting at 10:00.
ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (court_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&)
  WHERE (status IN ('held', 'pending_payment', 'confirmed'));
--> statement-breakpoint
-- A transaction reference can only be used once per payment method (stops reusing one payment for two bookings).
CREATE UNIQUE INDEX booking_shares_txn_uq ON booking_shares (method, txn_reference) WHERE txn_reference IS NOT NULL;
--> statement-breakpoint
-- Distance queries for venue search and Find Players.
CREATE INDEX branches_location_gix ON branches USING gist (location);
--> statement-breakpoint
CREATE INDEX matches_location_gix ON matches USING gist (location);
--> statement-breakpoint
-- Audit log is append-only.
CREATE FUNCTION audit_log_block_changes() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_changes();
