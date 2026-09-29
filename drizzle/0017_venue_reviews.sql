CREATE TABLE "venue_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"stars" smallint NOT NULL,
	"comment" text,
	"reply" text,
	"replied_by" uuid,
	"replied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "venue_reviews_stars_ck" CHECK ("venue_reviews"."stars" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "venue_reviews" ADD CONSTRAINT "venue_reviews_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_reviews" ADD CONSTRAINT "venue_reviews_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_reviews" ADD CONSTRAINT "venue_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_reviews" ADD CONSTRAINT "venue_reviews_replied_by_users_id_fk" FOREIGN KEY ("replied_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "venue_reviews_booking_uq" ON "venue_reviews" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "venue_reviews_branch_idx" ON "venue_reviews" USING btree ("branch_id","created_at");