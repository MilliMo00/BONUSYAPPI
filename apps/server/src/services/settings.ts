import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppSettings } from '../contract/api.ts';
import { DEFAULT_ORDER_STATUS_LABELS, ORDER_STATUSES, SPIN_GRANT_TRIGGERS } from '../contract/constants.ts';
import type { OrderStatus } from '../contract/constants.ts';
import type { Config } from '../config.ts';
import type { Db, Executor } from '../db/client.ts';
import { settings } from '../db/schema.ts';
import { parse } from '../lib/errors.ts';
import { audit, requirePermission } from './common.ts';
import type { Actor } from './common.ts';

const KEY = 'app';

const label = z.string().trim().min(1).max(60);
const statusLabels = z.object(
  Object.fromEntries(ORDER_STATUSES.map((s) => [s, label])) as Record<OrderStatus, typeof label>,
);

export const settingsSchema = z.object({
  brandName: z.string().trim().min(1).max(40),
  currency: z.string().trim().length(3).toUpperCase(),
  bonusValidityDays: z.number().int().min(1).max(3650).nullable(),
  welcomeSpins: z.number().int().min(0).max(10),
  spinGrantTrigger: z.enum(SPIN_GRANT_TRIGGERS),
  spinValidityDays: z.number().int().min(1).max(365),
  spinCooldownHours: z
    .number()
    .int()
    .min(0)
    .max(24 * 365),
  expiryReminderEnabled: z.boolean(),
  expiryReminderDaysBefore: z.number().int().min(1).max(30),
  managerContactUrl: z
    .string()
    .trim()
    .max(200)
    .refine(
      (v) => v === '' || /^https:\/\/t\.me\/[\w+/-]+$/.test(v),
      'Ссылка должна иметь вид https://t.me/username',
    ),
  teamChatId: z
    .string()
    .trim()
    .refine((v) => v === '' || /^-?\d{5,20}$/.test(v), 'ID чата — число, например -1001234567890'),
  services: z.array(z.string().trim().min(1).max(60)).min(1).max(30),
  statusLabels,
});

export function defaultSettings(config: Config): AppSettings {
  return {
    brandName: 'YAPPI',
    currency: config.DEFAULT_CURRENCY,
    bonusValidityDays: 14,
    welcomeSpins: 1,
    spinGrantTrigger: 'NONE',
    spinCooldownHours: 0,
    spinValidityDays: 7,
    expiryReminderEnabled: true,
    expiryReminderDaysBefore: 3,
    managerContactUrl: '',
    teamChatId: '',
    services: ['Баннер', 'Логотип', 'Оформление соцсетей', 'Презентация', 'Сайт или лендинг', 'Другое'],
    statusLabels: { ...DEFAULT_ORDER_STATUS_LABELS },
  };
}

export async function getSettings(db: Executor, config: Config): Promise<AppSettings> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
  const defaults = defaultSettings(config);
  const stored = (row?.value ?? {}) as Partial<AppSettings>;
  return { ...defaults, ...stored, statusLabels: { ...defaults.statusLabels, ...stored.statusLabels } };
}

export async function updateSettings(
  db: Db,
  config: Config,
  actor: Actor,
  input: unknown,
): Promise<AppSettings> {
  requirePermission(actor, 'settings.manage');
  const next = parse(settingsSchema, input);
  return db.transaction(async (tx) => {
    const before = await getSettings(tx, config);
    await tx
      .insert(settings)
      .values({ key: KEY, value: next })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } });
    const changed = Object.fromEntries(
      (Object.keys(next) as (keyof AppSettings)[])
        .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]))
        .map((k) => [k, { from: before[k], to: next[k] }]),
    );
    await audit(tx, actor, 'settings.update', 'settings', null, { changed });
    return next;
  });
}
