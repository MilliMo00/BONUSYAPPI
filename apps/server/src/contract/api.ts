// Типы ответов API. Даты приходят строками ISO 8601, денежные суммы — десятичными строками ("1500.00").
import type {
  AccountStatus,
  Locale,
  BonusStatus,
  OrderStatus,
  PaymentStatus,
  Permission,
  PermissionOverrides,
  PrizeType,
  Role,
  RoundingRule,
  SpinGrantTrigger,
  SpinUnavailableReason,
} from './constants.ts';

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export interface PublicConfig {
  brandName: string;
  botUsername: string | null;
}

export interface AppSettings {
  brandName: string;
  currency: string;
  /** null — бонусы бессрочные */
  bonusValidityDays: number | null;
  welcomeSpins: number;
  spinGrantTrigger: SpinGrantTrigger;
  spinCooldownHours: number;
  /** Сколько дней действует начисленное вращение; потом оно сгорает */
  spinValidityDays: number;
  expiryReminderEnabled: boolean;
  expiryReminderDaysBefore: number;
  /** Ссылка на менеджера вида https://t.me/username; пустая строка — не настроено */
  managerContactUrl: string;
  /** ID рабочего чата; пустая строка — уведомления уходят сотрудникам лично */
  teamChatId: string;
  services: string[];
  statusLabels: Record<OrderStatus, string>;
}

/** Перевод текстов приза. Русский текст хранится в основных полях; здесь — остальные языки. */
export interface PrizeText {
  name: string;
  description: string;
  terms: string;
}
export type PrizeTranslations = Partial<Record<Exclude<Locale, 'ru'>, PrizeText>>;

export interface PrizeRules {
  rounding: RoundingRule;
  /** Пустой список — приз действует на любые услуги */
  allowedServices: string[];
  stackable: boolean;
  terms: string;
}

export interface BonusDto {
  id: string;
  /** Уникальный номер бонуса вида YB-7KQ4MX */
  code: string;
  /** Бонус с приветственного вращения: действует на первый заказ клиента, остальные — на следующий */
  firstOrder: boolean;
  name: string;
  description: string;
  type: PrizeType;
  value: string | null;
  status: BonusStatus;
  createdAt: string;
  expiresAt: string | null;
  /** Когда клиент нажал «Применить бонус» и бонус ушёл сотрудникам на активацию */
  appliedAt: string | null;
  redeemedAt: string | null;
  discountAmount: string | null;
  minOrderAmount: string | null;
  maxDiscountAmount: string | null;
  rules: PrizeRules;
  source: 'SPIN' | 'MANUAL';
  sourceOrder: { id: string; orderNumber: string } | null;
  reservedOrder: { id: string; orderNumber: string } | null;
  redeemedOrder: { id: string; orderNumber: string } | null;
}

export interface OrderDto {
  id: string;
  orderNumber: string;
  serviceType: string;
  description: string;
  wishes: string | null;
  referenceUrl: string | null;
  desiredDeadline: string | null;
  contact: string | null;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  subtotal: string | null;
  discountAmount: string;
  totalAmount: string | null;
  currency: string;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  bonus: Pick<BonusDto, 'id' | 'name' | 'type' | 'value' | 'status'> | null;
}

export interface SpinAvailability {
  canSpin: boolean;
  attempts: number;
  /** Когда сгорит ближайшее неиспользованное вращение */
  attemptsExpireAt: string | null;
  reason: SpinUnavailableReason | null;
  message: string | null;
  nextAvailableAt: string | null;
}

export interface WheelSegment {
  prizeId: string;
  name: string;
  type: PrizeType;
  value: string | null;
}

export interface RouletteState {
  segments: WheelSegment[];
  availability: SpinAvailability;
}

export interface SpinResult {
  spinId: string;
  prizeId: string;
  bonus: BonusDto;
  replayed: boolean;
}

export interface ActivityDto {
  id: string;
  type: string;
  title: string;
  createdAt: string;
}

export interface MeDto {
  id: string;
  telegramId: number;
  username: string | null;
  displayName: string;
  /** Язык интерфейса: выбранный клиентом либо определённый по настройкам Telegram */
  locale: Locale;
  /** Клиент сам выбрал язык (иначе он определён по настройкам Telegram) */
  localeChosen: boolean;
  /** Бот может писать клиенту: тот нажимал /start или разрешил сообщения из приложения */
  botStarted: boolean;
  createdAt: string;
  ordersCount: number;
  redeemedBonusesCount: number;
  isStaff: boolean;
}

export interface HomeDto {
  me: MeDto;
  activeBonus: BonusDto | null;
  activeBonusesCount: number;
  availability: SpinAvailability;
  lastOrder: OrderDto | null;
  settings: Pick<
    AppSettings,
    'brandName' | 'managerContactUrl' | 'services' | 'statusLabels' | 'currency' | 'spinGrantTrigger'
  >;
}

export interface CreateOrderInput {
  requestId: string;
  serviceType: string;
  description: string;
  wishes?: string;
  referenceUrl?: string;
  desiredDeadline?: string;
  contact?: string;
  useBonus: boolean;
}

// ── Админ-панель ─────────────────────────────────────────────────────────────

export interface StaffDto {
  id: string;
  telegramId: number;
  username: string | null;
  displayName: string;
  role: Role;
  permissions: PermissionOverrides;
  effectivePermissions: Permission[];
  isActive: boolean;
  createdAt: string;
}

export interface AdminMeDto {
  staff: StaffDto;
  settings: AppSettings;
  botUsername: string | null;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminClientRow {
  id: string;
  telegramId: number;
  username: string | null;
  displayName: string;
  createdAt: string;
  lastActiveAt: string;
  accountStatus: AccountStatus;
  ordersCount: number;
  ordersTotal: string | null;
  activeBonuses: number;
}

export interface HistoryEntry {
  id: string;
  previousStatus: string | null;
  newStatus: string;
  actor: string;
  reason: string | null;
  orderNumber?: string | null;
  createdAt: string;
}

export interface PaymentDto {
  id: string;
  orderId: string;
  orderNumber?: string;
  amount: string;
  currency: string;
  status: 'CONFIRMED' | 'REFUNDED';
  paymentReference: string | null;
  notes: string | null;
  confirmedBy: string | null;
  confirmedAt: string;
}

export interface AuditDto {
  id: string;
  actor: string;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  details: unknown;
  createdAt: string;
}

export interface AdminOrderRow extends OrderDto {
  client: { id: string; telegramId: number; username: string | null; displayName: string };
  assignedStaff: { id: string; displayName: string } | null;
}

export interface AdminOrderCard extends AdminOrderRow {
  cancelReason: string | null;
  statusHistory: HistoryEntry[];
  payments: PaymentDto[];
  audit: AuditDto[];
  bonusDetails: AdminBonusRow | null;
  /** Активный бонус клиента, который можно привязать к этому заказу */
  attachableBonus: Pick<BonusDto, 'id' | 'name'> | null;
  /** Применима ли скидка зарезервированного бонуса к текущей стоимости, и почему нет */
  discountNote: string | null;
}

export interface AdminBonusRow extends BonusDto {
  client: { id: string; telegramId: number; username: string | null; displayName: string };
  redeemedBy: string | null;
}

export interface AdminBonusCard extends AdminBonusRow {
  history: HistoryEntry[];
}

export interface AdminClientCard {
  client: AdminClientRow & { spinAttempts: number };
  orders: AdminOrderRow[];
  bonuses: AdminBonusRow[];
  payments: PaymentDto[];
  activity: ActivityDto[];
  audit: AuditDto[];
}

export interface PrizeDto {
  id: string;
  name: string;
  description: string;
  type: PrizeType;
  value: string | null;
  /** Процент, до двух знаков: "35.00" */
  probability: string;
  isActive: boolean;
  /** null — срок по умолчанию из настроек, 0 — бессрочно */
  validityDays: number | null;
  minOrderAmount: string | null;
  maxDiscountAmount: string | null;
  rules: PrizeRules;
  translations: PrizeTranslations;
  sortOrder: number;
}

export type PrizeInput = Omit<PrizeDto, 'id'> & { id?: string };

export interface DashboardDto {
  period: { from: string; to: string };
  clientsTotal: number;
  clientsNew: number;
  ordersTotal: number;
  ordersInPeriod: number;
  ordersNew: number;
  ordersInProgress: number;
  ordersAwaitingPayment: number;
  repeatOrders: number;
  bonusesActive: number;
  bonusesReserved: number;
  bonusesRedeemed: number;
  /** null — у сотрудника нет права finance.view */
  finance: { discounts: string; subtotal: string; total: string; currency: string } | null;
}

export interface StatsDto {
  period: { from: string; to: string };
  spins: number;
  distribution: { name: string; count: number }[];
  bonusesIssued: number;
  bonusesRedeemed: number;
  bonusesExpired: number;
  /** Доля выигранных за период бонусов, которые клиент применил к заявке; null — нет данных */
  winToOrderConversion: number | null;
  avgHoursToRedeem: number | null;
  repeatClientsShare: number | null;
  finance: {
    discounts: string;
    revenueWithBonus: string;
    avgCheckWithBonus: string | null;
    avgCheckWithoutBonus: string | null;
    currency: string;
  } | null;
}

// ── Рассылки ─────────────────────────────────────────────────────────────────

export interface BroadcastButton {
  text: string;
  /** Ссылка https:// или t.me; null — кнопка открывает мини-приложение */
  url: string | null;
}

export interface BroadcastInput {
  /** Текст в HTML-разметке Telegram: b, i, u, s, a, code, pre, blockquote, tg-spoiler */
  text: string;
  mediaKind: 'photo' | 'voice' | null;
  mediaFileId: string | null;
  buttons: BroadcastButton[];
  /** null — всем подписчикам; иначе только выбравшим этот язык */
  locale: Locale | null;
}

export interface BroadcastDto extends BroadcastInput {
  id: string;
  status: 'SENDING' | 'DONE' | 'CANCELLED';
  total: number;
  sent: number;
  failed: number;
  createdBy: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface BroadcastAudience {
  total: number;
  byLocale: Record<Locale | 'none', number>;
}

/** Клиент, найденный по @username или Telegram ID, и можно ли начислить ему вращение. */
export interface SpinLookupDto {
  client: { id: string; telegramId: number; username: string | null; displayName: string };
  /** Неиспользованные действующие вращения */
  attempts: number;
  attemptsExpireAt: string | null;
  openBonus: Pick<BonusDto, 'id' | 'code' | 'name' | 'status' | 'expiresAt'> | null;
  canGrant: boolean;
  /** Почему начислить нельзя */
  reason: string | null;
}
