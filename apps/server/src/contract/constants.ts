// Общие константы домена. Файл импортируется и сервером, и веб-клиентом,
// поэтому здесь не должно быть зависимостей от Node.js или браузера.

/** Языки интерфейса и сообщений бота. Русский — язык по умолчанию и язык админ-панели. */
export const LOCALES = ['ru', 'en', 'uk'] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_LABELS: Record<Locale, string> = { ru: 'Русский', en: 'English', uk: 'Українська' };

/** Язык по коду из Telegram, когда клиент ещё не выбрал его сам. */
export function guessLocale(languageCode: string | null | undefined): Locale {
  const code = (languageCode ?? '').toLowerCase();
  if (code.startsWith('uk')) return 'uk';
  if (code.startsWith('ru') || code.startsWith('be') || code.startsWith('kk')) return 'ru';
  return code ? 'en' : 'ru';
}

export const ORDER_STATUSES = [
  'NEW',
  'PRICING',
  'AWAITING_PAYMENT',
  'PAID',
  'IN_PROGRESS',
  'REVIEW',
  'COMPLETED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const DEFAULT_ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  NEW: 'Новая заявка',
  PRICING: 'Ожидает согласования стоимости',
  AWAITING_PAYMENT: 'Ожидает оплаты',
  PAID: 'Оплачен',
  IN_PROGRESS: 'В работе',
  REVIEW: 'На проверке',
  COMPLETED: 'Выполнен',
  CANCELLED: 'Отменён',
};

/**
 * Допустимые переходы статусов заказа.
 * PAID выставляется только операцией подтверждения оплаты, CANCELLED — только операцией отмены;
 * через обычную смену статуса сотрудник попасть в них не может (см. MANUAL_ORDER_TRANSITIONS).
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  NEW: ['PRICING', 'AWAITING_PAYMENT', 'CANCELLED'],
  PRICING: ['AWAITING_PAYMENT', 'CANCELLED'],
  AWAITING_PAYMENT: ['PRICING', 'PAID', 'CANCELLED'],
  PAID: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['REVIEW', 'COMPLETED', 'CANCELLED'],
  REVIEW: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

const OPERATION_ONLY_STATUSES: readonly OrderStatus[] = ['PAID', 'CANCELLED'];

export function manualTransitions(from: OrderStatus): OrderStatus[] {
  return ORDER_TRANSITIONS[from].filter((s) => !OPERATION_ONLY_STATUSES.includes(s));
}

export const PAYMENT_STATUSES = ['UNPAID', 'PAID', 'REFUNDED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  UNPAID: 'Не оплачен',
  PAID: 'Оплата подтверждена',
  REFUNDED: 'Возврат',
};

export const BONUS_STATUSES = ['ACTIVE', 'RESERVED', 'REDEEMED', 'EXPIRED', 'CANCELLED'] as const;
export type BonusStatus = (typeof BONUS_STATUSES)[number];
export const BONUS_STATUS_LABELS: Record<BonusStatus, string> = {
  ACTIVE: 'Активен',
  RESERVED: 'Ожидает активации',
  REDEEMED: 'Использован',
  EXPIRED: 'Истёк',
  CANCELLED: 'Аннулирован',
};

export const PRIZE_TYPES = ['PERCENT_DISCOUNT', 'FIXED_DISCOUNT', 'PRIVILEGE'] as const;
export type PrizeType = (typeof PRIZE_TYPES)[number];
export const PRIZE_TYPE_LABELS: Record<PrizeType, string> = {
  PERCENT_DISCOUNT: 'Скидка в процентах',
  FIXED_DISCOUNT: 'Фиксированная скидка',
  PRIVILEGE: 'Привилегия (без суммы)',
};

/** Округление суммы скидки: до целой единицы валюты вниз / к ближайшему, либо до копеек. */
export const ROUNDING_RULES = ['FLOOR_UNIT', 'ROUND_UNIT', 'CENT'] as const;
export type RoundingRule = (typeof ROUNDING_RULES)[number];
export const ROUNDING_LABELS: Record<RoundingRule, string> = {
  FLOOR_UNIT: 'Вниз до целого',
  ROUND_UNIT: 'К ближайшему целому',
  CENT: 'До копеек',
};

export const SPIN_GRANT_TRIGGERS = ['BONUS_ACTIVATED', 'ORDER_PAID', 'ORDER_COMPLETED', 'NONE'] as const;
export type SpinGrantTrigger = (typeof SPIN_GRANT_TRIGGERS)[number];
export const SPIN_GRANT_TRIGGER_LABELS: Record<SpinGrantTrigger, string> = {
  BONUS_ACTIVATED: 'Автоматически после активации бонуса',
  ORDER_PAID: 'После подтверждения оплаты заказа',
  ORDER_COMPLETED: 'После выполнения заказа',
  NONE: 'Только вручную — сотрудник начисляет после заказа',
};

export const ACCOUNT_STATUSES = ['ACTIVE', 'BLOCKED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

// ── Роли и права ─────────────────────────────────────────────────────────────

export const ROLES = ['OWNER', 'TEAM_LEAD', 'MANAGER', 'FINANCE', 'TECH_ADMIN'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS: Record<Role, string> = {
  OWNER: 'Владелец',
  TEAM_LEAD: 'Тимлид',
  MANAGER: 'Менеджер',
  FINANCE: 'Финансы',
  TECH_ADMIN: 'Тех. администратор',
};

export const PERMISSIONS = [
  'clients.view',
  'clients.manage',
  'spins.grant',
  'orders.view',
  'orders.create',
  'orders.update_status',
  'orders.assign',
  'orders.set_price',
  'orders.cancel',
  'payments.confirm',
  'bonuses.view',
  'bonuses.redeem',
  'bonuses.release',
  'bonuses.grant',
  'bonuses.cancel',
  'bonuses.correct',
  'finance.view',
  'stats.view',
  'reports.export',
  'roulette.manage',
  'broadcast.send',
  'settings.manage',
  'staff.manage',
  'audit.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  'clients.view': 'Просмотр клиентов',
  'clients.manage': 'Блокировка клиентов',
  'spins.grant': 'Начисление вращений клиентам',
  'orders.view': 'Просмотр заказов',
  'orders.create': 'Создание заявок',
  'orders.update_status': 'Изменение рабочих статусов',
  'orders.assign': 'Назначение ответственных',
  'orders.set_price': 'Установка стоимости',
  'orders.cancel': 'Отмена заказов',
  'payments.confirm': 'Подтверждение оплаты',
  'bonuses.view': 'Просмотр бонусов',
  'bonuses.redeem': 'Активация бонуса (списание)',
  'bonuses.release': 'Возврат бонуса клиенту',
  'bonuses.grant': 'Ручная выдача бонуса',
  'bonuses.cancel': 'Аннулирование бонуса',
  'bonuses.correct': 'Корректировка состояния бонуса',
  'finance.view': 'Финансовые показатели',
  'stats.view': 'Статистика',
  'reports.export': 'Экспорт CSV',
  'roulette.manage': 'Настройки рулетки',
  'broadcast.send': 'Рассылка подписчикам бота',
  'settings.manage': 'Настройки системы и интеграций',
  'staff.manage': 'Управление сотрудниками',
  'audit.view': 'Журнал аудита',
};

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  OWNER: PERMISSIONS,
  TEAM_LEAD: [
    'clients.view',
    'orders.view',
    'orders.create',
    'orders.update_status',
    'orders.assign',
    'orders.set_price',
    'orders.cancel',
    'bonuses.view',
    'bonuses.redeem',
    'bonuses.release',
    'spins.grant',
    'stats.view',
  ],
  MANAGER: [
    'clients.view',
    'orders.view',
    'orders.create',
    'orders.update_status',
    'orders.set_price',
    'bonuses.view',
  ],
  FINANCE: [
    'clients.view',
    'orders.view',
    'bonuses.view',
    'payments.confirm',
    'finance.view',
    'stats.view',
    'reports.export',
  ],
  // Технический доступ: настройка системы без клиентских финансовых операций.
  TECH_ADMIN: ['settings.manage', 'audit.view'],
};

export interface PermissionOverrides {
  grant: Permission[];
  revoke: Permission[];
}

export function effectivePermissions(
  role: Role,
  overrides?: Partial<PermissionOverrides> | null,
): Permission[] {
  const set = new Set<Permission>(ROLE_PERMISSIONS[role]);
  for (const p of overrides?.grant ?? []) set.add(p);
  for (const p of overrides?.revoke ?? []) set.delete(p);
  return PERMISSIONS.filter((p) => set.has(p));
}

export const SPIN_UNAVAILABLE_REASONS = [
  'ACTIVE_BONUS',
  'NO_ATTEMPTS',
  'COOLDOWN',
  'NOT_CONFIGURED',
  'BLOCKED',
] as const;
export type SpinUnavailableReason = (typeof SPIN_UNAVAILABLE_REASONS)[number];
