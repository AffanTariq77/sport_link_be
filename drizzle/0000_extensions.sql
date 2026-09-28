-- Extensions needed before the schema: PostGIS for locations, btree_gist for the booking exclusion constraint.
CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
