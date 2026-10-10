-- Уникальный номер бонуса. Колонка добавляется в три шага, чтобы уже выданные бонусы получили номера.
ALTER TABLE "bonuses" ADD COLUMN "code" text;--> statement-breakpoint
UPDATE "bonuses" SET "code" = 'YB-' || translate(upper(substr(md5("id"::text), 1, 6)), '01', 'XZ') WHERE "code" IS NULL;--> statement-breakpoint
ALTER TABLE "bonuses" ALTER COLUMN "code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bonuses" ADD CONSTRAINT "bonuses_code_unique" UNIQUE("code");
