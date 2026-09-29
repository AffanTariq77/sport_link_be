CREATE TYPE "public"."find_request_status" AS ENUM('open', 'matched', 'closed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."find_response_status" AS ENUM('notified', 'accepted', 'declined', 'selected', 'not_selected', 'removed');--> statement-breakpoint
CREATE TABLE "find_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_id" uuid NOT NULL,
	"sport_id" uuid NOT NULL,
	"players_needed" smallint NOT NULL,
	"radius_km" smallint NOT NULL,
	"location" geography(Point, 4326) NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "find_request_status" DEFAULT 'open' NOT NULL,
	"match_id" uuid,
	"last_batch_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "find_responses" (
	"request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "find_response_status" DEFAULT 'notified' NOT NULL,
	"distance_m" integer NOT NULL,
	"notified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	CONSTRAINT "find_responses_request_id_user_id_pk" PRIMARY KEY("request_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "player_availability" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"location" geography(Point, 4326),
	"located_at" timestamp with time zone,
	"alert_mode" text DEFAULT 'available' NOT NULL,
	"available" boolean DEFAULT false NOT NULL,
	"quiet_hours_ok" boolean DEFAULT false NOT NULL,
	"sport_slugs" text[] DEFAULT '{}' NOT NULL,
	"guardian_allows_adults" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "find_requests" ADD CONSTRAINT "find_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "find_requests" ADD CONSTRAINT "find_requests_sport_id_sports_id_fk" FOREIGN KEY ("sport_id") REFERENCES "public"."sports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "find_requests" ADD CONSTRAINT "find_requests_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "find_responses" ADD CONSTRAINT "find_responses_request_id_find_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."find_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "find_responses" ADD CONSTRAINT "find_responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_availability" ADD CONSTRAINT "player_availability_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "find_requests_status_idx" ON "find_requests" USING btree ("status","window_end");--> statement-breakpoint
CREATE INDEX "find_responses_user_idx" ON "find_responses" USING btree ("user_id","notified_at");--> statement-breakpoint
CREATE INDEX player_availability_location_gix ON player_availability USING gist (location);
