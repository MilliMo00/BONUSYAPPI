CREATE SEQUENCE "public"."order_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 10001 CACHE 1;--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"actor_role" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bonus_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bonus_id" uuid NOT NULL,
	"previous_status" text,
	"new_status" text NOT NULL,
	"actor_type" text NOT NULL,
	"changed_by" uuid,
	"reason" text,
	"order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bonuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"prize_id" uuid,
	"source" text NOT NULL,
	"source_order_id" uuid,
	"reserved_order_id" uuid,
	"redeemed_order_id" uuid,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"type" text NOT NULL,
	"value" numeric(12, 2),
	"minimum_order_amount" numeric(12, 2),
	"maximum_discount_amount" numeric(12, 2),
	"rules" jsonb NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"discount_amount" numeric(12, 2),
	"redeemed_by_staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"redeemed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "bonuses_status_check" CHECK (status IN ('ACTIVE', 'RESERVED', 'REDEEMED', 'EXPIRED', 'CANCELLED')),
	CONSTRAINT "bonuses_type_check" CHECK (type IN ('PERCENT_DISCOUNT', 'FIXED_DISCOUNT', 'PRIVILEGE')),
	CONSTRAINT "bonuses_reserved_link_check" CHECK (status <> 'RESERVED' OR reserved_order_id IS NOT NULL),
	CONSTRAINT "bonuses_redeemed_link_check" CHECK (status <> 'REDEEMED' OR (redeemed_order_id IS NOT NULL AND redeemed_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_type" text NOT NULL,
	"recipient_id" text NOT NULL,
	"notification_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"dedupe_key" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "notifications_dedupeKey_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "notifications_status_check" CHECK (status IN ('PENDING', 'SENT', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "order_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"previous_status" text,
	"new_status" text NOT NULL,
	"actor_type" text NOT NULL,
	"changed_by" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" text NOT NULL,
	"user_id" uuid NOT NULL,
	"service_type" text NOT NULL,
	"description" text NOT NULL,
	"wishes" text,
	"reference_url" text,
	"desired_deadline" text,
	"contact" text,
	"status" text DEFAULT 'NEW' NOT NULL,
	"payment_status" text DEFAULT 'UNPAID' NOT NULL,
	"assigned_staff_id" uuid,
	"created_by_staff_id" uuid,
	"subtotal" numeric(12, 2),
	"discount_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_amount" numeric(12, 2),
	"currency" text NOT NULL,
	"cancel_reason" text,
	"request_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "orders_orderNumber_unique" UNIQUE("order_number"),
	CONSTRAINT "orders_status_check" CHECK (status IN ('NEW', 'PRICING', 'AWAITING_PAYMENT', 'PAID', 'IN_PROGRESS', 'REVIEW', 'COMPLETED', 'CANCELLED')),
	CONSTRAINT "orders_payment_status_check" CHECK (payment_status IN ('UNPAID', 'PAID', 'REFUNDED')),
	CONSTRAINT "orders_amounts_check" CHECK ((subtotal IS NULL OR subtotal >= 0) AND discount_amount >= 0 AND (total_amount IS NULL OR total_amount >= 0))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"payment_reference" text,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	CONSTRAINT "payments_status_check" CHECK (status IN ('CONFIRMED', 'REFUNDED')),
	CONSTRAINT "payments_amount_check" CHECK (amount >= 0)
);
--> statement-breakpoint
CREATE TABLE "prizes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"type" text NOT NULL,
	"value" numeric(12, 2),
	"probability" numeric(5, 2) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"validity_days" integer,
	"minimum_order_amount" numeric(12, 2),
	"maximum_discount_amount" numeric(12, 2),
	"rules" jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prizes_type_check" CHECK (type IN ('PERCENT_DISCOUNT', 'FIXED_DISCOUNT', 'PRIVILEGE')),
	CONSTRAINT "prizes_probability_check" CHECK (probability >= 0 AND probability <= 100)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spin_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_order_id" uuid,
	"granted_by_staff_id" uuid,
	"reason" text,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"bonus_id" uuid NOT NULL,
	"prize_id" uuid NOT NULL,
	"result" jsonb NOT NULL,
	"request_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spins_grantId_unique" UNIQUE("grant_id")
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_id" bigint NOT NULL,
	"username" text,
	"display_name" text NOT NULL,
	"role" text NOT NULL,
	"permissions" jsonb DEFAULT '{"grant":[],"revoke":[]}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_telegramId_unique" UNIQUE("telegram_id"),
	CONSTRAINT "staff_role_check" CHECK (role IN ('OWNER', 'TEAM_LEAD', 'MANAGER', 'FINANCE', 'TECH_ADMIN'))
);
--> statement-breakpoint
CREATE TABLE "user_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_id" bigint NOT NULL,
	"username" text,
	"display_name" text NOT NULL,
	"language_code" text,
	"account_status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_telegramId_unique" UNIQUE("telegram_id"),
	CONSTRAINT "users_account_status_check" CHECK (account_status IN ('ACTIVE', 'BLOCKED'))
);
--> statement-breakpoint
ALTER TABLE "bonus_history" ADD CONSTRAINT "bonus_history_bonus_id_bonuses_id_fk" FOREIGN KEY ("bonus_id") REFERENCES "public"."bonuses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonus_history" ADD CONSTRAINT "bonus_history_changed_by_staff_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonus_history" ADD CONSTRAINT "bonus_history_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonuses" ADD CONSTRAINT "bonuses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonuses" ADD CONSTRAINT "bonuses_prize_id_prizes_id_fk" FOREIGN KEY ("prize_id") REFERENCES "public"."prizes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonuses" ADD CONSTRAINT "bonuses_source_order_id_orders_id_fk" FOREIGN KEY ("source_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonuses" ADD CONSTRAINT "bonuses_reserved_order_id_orders_id_fk" FOREIGN KEY ("reserved_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonuses" ADD CONSTRAINT "bonuses_redeemed_order_id_orders_id_fk" FOREIGN KEY ("redeemed_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonuses" ADD CONSTRAINT "bonuses_redeemed_by_staff_id_staff_id_fk" FOREIGN KEY ("redeemed_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_changed_by_staff_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_assigned_staff_id_staff_id_fk" FOREIGN KEY ("assigned_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_staff_id_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_confirmed_by_staff_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spin_grants" ADD CONSTRAINT "spin_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spin_grants" ADD CONSTRAINT "spin_grants_source_order_id_orders_id_fk" FOREIGN KEY ("source_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spin_grants" ADD CONSTRAINT "spin_grants_granted_by_staff_id_staff_id_fk" FOREIGN KEY ("granted_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spins" ADD CONSTRAINT "spins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spins" ADD CONSTRAINT "spins_grant_id_spin_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."spin_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spins" ADD CONSTRAINT "spins_bonus_id_bonuses_id_fk" FOREIGN KEY ("bonus_id") REFERENCES "public"."bonuses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spins" ADD CONSTRAINT "spins_prize_id_prizes_id_fk" FOREIGN KEY ("prize_id") REFERENCES "public"."prizes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_activity" ADD CONSTRAINT "user_activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "bonus_history_bonus_idx" ON "bonus_history" USING btree ("bonus_id","created_at");--> statement-breakpoint
CREATE INDEX "bonus_history_status_idx" ON "bonus_history" USING btree ("new_status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bonuses_one_open_per_user_uidx" ON "bonuses" USING btree ("user_id") WHERE status IN ('ACTIVE', 'RESERVED');--> statement-breakpoint
CREATE UNIQUE INDEX "bonuses_reserved_order_uidx" ON "bonuses" USING btree ("reserved_order_id") WHERE reserved_order_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bonuses_redeemed_order_uidx" ON "bonuses" USING btree ("redeemed_order_id") WHERE redeemed_order_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "bonuses_user_idx" ON "bonuses" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "bonuses_status_idx" ON "bonuses" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "notifications_pending_idx" ON "notifications" USING btree ("next_attempt_at") WHERE status = 'PENDING';--> statement-breakpoint
CREATE INDEX "order_status_history_order_idx" ON "order_status_history" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_user_request_uidx" ON "orders" USING btree ("user_id","request_id");--> statement-breakpoint
CREATE INDEX "orders_user_idx" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_created_at_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_confirmed_per_order_uidx" ON "payments" USING btree ("order_id") WHERE status = 'CONFIRMED';--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spin_grants_order_uidx" ON "spin_grants" USING btree ("source_order_id") WHERE source_order_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "spin_grants_user_idx" ON "spin_grants" USING btree ("user_id","consumed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "spins_user_request_uidx" ON "spins" USING btree ("user_id","request_id");--> statement-breakpoint
CREATE INDEX "spins_created_at_idx" ON "spins" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "user_activity_user_idx" ON "user_activity" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");