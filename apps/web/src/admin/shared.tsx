import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import type { AdminMeDto, AuditDto } from '@contract/api.ts';
import type { Permission } from '@contract/constants.ts';
import { api, download } from '../api.ts';
import { dateTime } from '../format.ts';
import { Button, Field, Sheet, errorMessage, useToast } from '../ui/kit.tsx';

export const AdminContext = createContext<AdminMeDto | null>(null);

export function useAdmin() {
  const me = useContext(AdminContext);
  if (!me) throw new Error('AdminContext не инициализирован');
  const permissions = new Set<Permission>(me.staff.effectivePermissions);
  // Скрытие кнопок — только удобство: каждое действие проверяется на сервере.
  return { ...me, can: (p: Permission) => permissions.has(p) };
}

/** Действие сотрудника: POST/PUT/PATCH, уведомление о результате и обновление данных админки. */
export function useAction<TBody = unknown, TResult = unknown>(
  path: string | ((body: TBody) => string),
  options: { method?: 'POST' | 'PUT' | 'PATCH'; success?: string; onDone?: (result: TResult) => void } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: TBody) =>
      api<TResult>(typeof path === 'function' ? path(body) : path, options.method ?? 'POST', body),
    onSuccess: (result) => {
      if (options.success) toast(options.success);
      options.onDone?.(result);
      return qc.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (err) => {
      toast(errorMessage(err), true);
      // Данные могли измениться другим сотрудником — показываем актуальное состояние.
      void qc.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

export function PageHead({
  title,
  children,
  back,
}: {
  title: string;
  children?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <div className="admin-head">
      <div>
        {back}
        <h1 className="display">{title}</h1>
      </div>
      <div className="row wrap">{children}</div>
    </div>
  );
}

export function Pager({
  page,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager">
      <span>
        Всего: {total}
        {pages > 1 && ` · страница ${page} из ${pages}`}
      </span>
      {pages > 1 && (
        <div className="row">
          <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            Назад
          </Button>
          <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
            Вперёд
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Период ───────────────────────────────────────────────────────────────────

export interface Period {
  from: string;
  to: string;
}
const day = (d: Date) => d.toISOString().slice(0, 10);
export const lastDays = (n: number): Period => ({
  from: day(new Date(Date.now() - (n - 1) * 86_400_000)),
  to: day(new Date()),
});

export function PeriodFilter({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const presets = [7, 30, 90];
  return (
    <div className="filters" style={{ marginBottom: 0 }}>
      {presets.map((n) => {
        const p = lastDays(n);
        return (
          <button
            key={n}
            className="chip"
            aria-pressed={p.from === value.from && p.to === value.to}
            onClick={() => onChange(p)}
          >
            {n} дней
          </button>
        );
      })}
      <input
        className="input"
        type="date"
        value={value.from}
        max={value.to}
        aria-label="Начало периода"
        onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })}
      />
      <input
        className="input"
        type="date"
        value={value.to}
        min={value.from}
        aria-label="Конец периода"
        onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })}
      />
    </div>
  );
}

// ── Диалог с причиной ────────────────────────────────────────────────────────

export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  danger,
  loading,
  onClose,
  onConfirm,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  danger?: boolean;
  loading?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  children?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div className="stack" style={{ marginTop: 12 }}>
        {description && <p className="muted">{description}</p>}
        <Field label="Причина" hint="Сохранится в журнале аудита">
          <textarea
            className="input"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
        </Field>
        {children}
        <div className="row">
          <Button className="grow" onClick={onClose}>
            Отмена
          </Button>
          <Button
            className="grow"
            variant={danger ? 'danger' : 'solid'}
            loading={loading}
            disabled={reason.trim().length < 3}
            onClick={() => onConfirm(reason.trim())}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

const ACTION_LABELS: Record<string, string> = {
  'order.create': 'Создал заявку за клиента',
  'order.status': 'Сменил статус заказа',
  'order.price': 'Изменил стоимость',
  'order.assign': 'Назначил ответственного',
  'order.cancel': 'Отменил заказ',
  'payment.confirm': 'Подтвердил оплату',
  'bonus.redeem': 'Подтвердил использование бонуса',
  'bonus.release': 'Вернул бонус из резерва',
  'bonus.reserve': 'Привязал бонус к заказу',
  'bonus.activate': 'Активировал бонус',
  'bonus.return': 'Вернул бонус клиенту',
  'bonus.grant_manual': 'Выдал бонус вручную',
  'broadcast.create': 'Запустил рассылку',
  'broadcast.cancel': 'Остановил рассылку',
  'bonus.cancel': 'Аннулировал бонус',
  'bonus.correct': 'Скорректировал состояние бонуса',
  'client.status': 'Изменил статус клиента',
  'client.grant_spins': 'Начислил вращения',
  'spin.grant': 'Начислил вращение за заказ',
  'roulette.update': 'Изменил настройки рулетки',
  'settings.update': 'Изменил настройки',
  'staff.create': 'Добавил сотрудника',
  'staff.update': 'Изменил сотрудника',
  'staff.create_owner_cli': 'Создан владелец (CLI)',
};
export const actionLabel = (action: string) => ACTION_LABELS[action] ?? action;

export function AuditList({ items }: { items: AuditDto[] }) {
  if (items.length === 0) return <p className="muted small">Действий пока нет.</p>;
  return (
    <ul className="log">
      {items.map((a) => (
        <li key={a.id}>
          <time>{dateTime(a.createdAt)}</time>
          <div>
            <b>{a.actor}</b> · {actionLabel(a.action)}
            <details>
              <summary className="muted small" style={{ cursor: 'pointer' }}>
                Подробности
              </summary>
              <code className="json">{JSON.stringify(a.details, null, 2)}</code>
            </details>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ExportButton({ table, query = '' }: { table: string; query?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      icon="download"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await download(`/api/admin/export/${table}.csv${query}`, `${table}-${day(new Date())}.csv`);
        } catch (err) {
          toast(errorMessage(err), true);
        } finally {
          setBusy(false);
        }
      }}
    >
      CSV
    </Button>
  );
}

export const clientLink = (c: { username: string | null; telegramId: number }) =>
  c.username ? `https://t.me/${c.username}` : `tg://user?id=${c.telegramId}`;
