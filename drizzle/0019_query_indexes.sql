CREATE INDEX "booking_shares_booking_idx" ON "booking_shares" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "booking_shares_status_idx" ON "booking_shares" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bookings_created_by_idx" ON "bookings" USING btree ("created_by","start_at");--> statement-breakpoint
CREATE INDEX "bookings_series_idx" ON "bookings" USING btree ("recurring_series_id");--> statement-breakpoint
CREATE INDEX "match_players_user_idx" ON "match_players" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "matches_status_start_idx" ON "matches" USING btree ("status","start_at");--> statement-breakpoint
CREATE INDEX "matches_host_idx" ON "matches" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "refunds_user_idx" ON "refunds" USING btree ("user_id");