ALTER TABLE "bonuses" DROP CONSTRAINT "bonuses_reserved_link_check";--> statement-breakpoint
ALTER TABLE "bonuses" DROP CONSTRAINT "bonuses_redeemed_link_check";--> statement-breakpoint
ALTER TABLE "bonuses" ADD COLUMN "applied_at" timestamp with time zone;