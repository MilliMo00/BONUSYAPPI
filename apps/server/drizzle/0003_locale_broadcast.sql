CREATE TABLE "broadcast_recipients" (
	"broadcast_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone,
	CONSTRAINT "broadcast_recipients_broadcast_id_user_id_pk" PRIMARY KEY("broadcast_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by_staff_id" uuid,
	"text" text NOT NULL,
	"media_kind" text,
	"media_file_id" text,
	"buttons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"locale" text,
	"status" text DEFAULT 'SENDING' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bonuses" ADD COLUMN "translations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "prizes" ADD COLUMN "translations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bot_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bot_blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_created_by_staff_id_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broadcast_recipients_pending_idx" ON "broadcast_recipients" USING btree ("broadcast_id") WHERE status = 'PENDING';--> statement-breakpoint
-- Клиенты, зарегистрированные до появления рассылок, пришли через бота: считаем, что /start они нажимали.
UPDATE "users" SET "bot_started_at" = "created_at" WHERE "bot_started_at" IS NULL;
