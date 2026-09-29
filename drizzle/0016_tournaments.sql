CREATE TYPE "public"."entry_status" AS ENUM('pending_payment', 'submitted', 'confirmed', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."fixture_status" AS ENUM('scheduled', 'completed', 'walkover', 'bye');--> statement-breakpoint
CREATE TYPE "public"."tournament_format" AS ENUM('knockout', 'league', 'round_robin', 'groups_knockout');--> statement-breakpoint
CREATE TYPE "public"."tournament_status" AS ENUM('draft', 'open', 'closed', 'in_progress', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "tournament_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid,
	"status" "entry_status" NOT NULL,
	"method" "payment_method",
	"txn_reference" text,
	"seed" smallint,
	"group_no" smallint,
	"roster_unlocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tournament_fixtures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"round" smallint NOT NULL,
	"slot" smallint NOT NULL,
	"group_no" smallint,
	"entry_a" uuid,
	"entry_b" uuid,
	"score_a" smallint,
	"score_b" smallint,
	"winner_entry_id" uuid,
	"status" "fixture_status" DEFAULT 'scheduled' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"rated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tournaments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sport_id" uuid NOT NULL,
	"name" text NOT NULL,
	"format" "tournament_format" NOT NULL,
	"team_entry" boolean DEFAULT false NOT NULL,
	"entry_fee" bigint DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"prize" text,
	"venue" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"registration_deadline" timestamp with time zone NOT NULL,
	"max_entries" smallint NOT NULL,
	"group_size" smallint DEFAULT 4 NOT NULL,
	"eligibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pay_to" text,
	"programme" text,
	"status" "tournament_status" DEFAULT 'open' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_entries" ADD CONSTRAINT "tournament_entries_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_fixtures" ADD CONSTRAINT "tournament_fixtures_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_fixtures" ADD CONSTRAINT "tournament_fixtures_entry_a_tournament_entries_id_fk" FOREIGN KEY ("entry_a") REFERENCES "public"."tournament_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_fixtures" ADD CONSTRAINT "tournament_fixtures_entry_b_tournament_entries_id_fk" FOREIGN KEY ("entry_b") REFERENCES "public"."tournament_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_fixtures" ADD CONSTRAINT "tournament_fixtures_winner_entry_id_tournament_entries_id_fk" FOREIGN KEY ("winner_entry_id") REFERENCES "public"."tournament_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_sport_id_sports_id_fk" FOREIGN KEY ("sport_id") REFERENCES "public"."sports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tournament_entries_player_uq" ON "tournament_entries" USING btree ("tournament_id","user_id") WHERE team_id is null and status <> 'withdrawn' and status <> 'rejected';--> statement-breakpoint
CREATE UNIQUE INDEX "tournament_entries_team_uq" ON "tournament_entries" USING btree ("tournament_id","team_id") WHERE team_id is not null and status <> 'withdrawn' and status <> 'rejected';--> statement-breakpoint
CREATE UNIQUE INDEX "tournament_entries_txn_uq" ON "tournament_entries" USING btree ("tournament_id","txn_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "tournament_fixtures_slot_uq" ON "tournament_fixtures" USING btree ("tournament_id","stage","round","group_no","slot");