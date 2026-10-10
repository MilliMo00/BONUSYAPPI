ALTER TABLE "spin_grants" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
-- Уже начисленные и ещё не использованные вращения получают неделю с момента обновления.
UPDATE "spin_grants" SET "expires_at" = now() + interval '7 days' WHERE "consumed_at" IS NULL AND "expires_at" IS NULL;
