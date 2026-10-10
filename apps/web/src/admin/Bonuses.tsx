import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AdminBonusCard, AdminBonusRow, Paginated } from '@contract/api.ts';
import { BONUS_STATUSES, BONUS_STATUS_LABELS, PRIZE_TYPES, PRIZE_TYPE_LABELS } from '@contract/constants.ts';
import type { BonusStatus } from '@contract/constants.ts';
import { api, qs } from '../api.ts';
import { BONUS_TONE, bonusValue, dateTime, money, shortDate } from '../format.ts';
import { Icon } from '../ui/icons.tsx';
import { Badge, Button, ErrorState, Field, Sheet, Skeleton, State } from '../ui/kit.tsx';
import { ExportButton, PageHead, Pager, ReasonDialog, clientLink, useAction, useAdmin } from './shared.tsx';

export function BonusesTable({
  items,
  onOpen,
  hideClient,
}: {
  items: AdminBonusRow[];
  onOpen: (id: string) => void;
  hideClient?: boolean;
}) {
  const { settings } = useAdmin();
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Номер</th>
            {!hideClient && <th>Клиент</th>}
            <th>Приз</th>
            <th>Статус</th>
            <th>Получен</th>
            <th>Применён</th>
            <th>Истекает</th>
            <th>Активировал</th>
          </tr>
        </thead>
        <tbody>
          {items.map((b) => (
            <tr key={b.id} className="clickable" onClick={() => onOpen(b.id)}>
              <td>
                <span className="code-tag">{b.code}</span>
              </td>
              {!hideClient && (
                <td>
                  {b.client.displayName}
                  {b.client.username && <div className="muted small">@{b.client.username}</div>}
                </td>
              )}
              <td>
                <b>{b.name}</b> <span className="muted">{bonusValue(b, settings.currency)}</span>
              </td>
              <td>
                <Badge tone={BONUS_TONE[b.status]}>{BONUS_STATUS_LABELS[b.status]}</Badge>
              </td>
              <td className="muted">{shortDate(b.createdAt)}</td>
              <td className="muted">{b.appliedAt ? dateTime(b.appliedAt) : '—'}</td>
              <td className="muted">{b.expiresAt ? shortDate(b.expiresAt) : 'бессрочно'}</td>
              <td className="muted">{b.redeemedBy ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Короткий ответ на вопрос сотрудника: можно ли принять этот бонус прямо сейчас. */
function BonusVerdict({ bonus }: { bonus: AdminBonusCard }) {
  const expired = bonus.expiresAt !== null && new Date(bonus.expiresAt) <= new Date();
  const who = `${bonus.client.displayName}${bonus.client.username ? ` (@${bonus.client.username})` : ''}`;
  const check = `Принадлежит клиенту ${who}. Сверьте, что пишет именно этот аккаунт.`;
  const [tone, icon, title, hint] =
    bonus.status === 'RESERVED'
      ? (['tone-warn', 'clock', 'Клиент применил бонус — ждёт активации', check] as const)
      : bonus.status === 'ACTIVE' && !expired
        ? (['tone-ok', 'check', 'Бонус действителен', check] as const)
        : bonus.status === 'ACTIVE'
          ? (['tone-danger', 'alert', 'Срок действия истёк', 'Активировать бонус нельзя.'] as const)
          : bonus.status === 'REDEEMED'
            ? ([
                'tone-danger',
                'alert',
                'Бонус уже использован',
                `Активирован ${dateTime(bonus.redeemedAt)}${bonus.redeemedBy ? ` · ${bonus.redeemedBy}` : ''}. Повторно принять нельзя.`,
              ] as const)
            : ([
                'tone-danger',
                'alert',
                bonus.status === 'EXPIRED' ? 'Бонус истёк' : 'Бонус аннулирован',
                'Принять его нельзя.',
              ] as const);
  return (
    <div className={`verdict ${tone}`}>
      <Icon name={icon} size={24} />
      <div>
        {title}
        <small>{hint}</small>
      </div>
    </div>
  );
}

/** Карточка бонуса: проверка, активация, возврат клиенту и история. */
export function BonusSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { settings, can } = useAdmin();
  const {
    data: bonus,
    error,
    isPending,
  } = useQuery({
    queryKey: ['admin', 'bonus', id],
    queryFn: () => api<AdminBonusCard>(`/api/admin/bonuses/${id}`),
    enabled: id !== null,
  });
  const [dialog, setDialog] = useState<'cancel' | 'correct' | null>(null);
  const [extendDays, setExtendDays] = useState('');
  const done = () => setDialog(null);
  const activate = useAction<object>(`/api/admin/bonuses/${id}/activate`, {
    success: 'Бонус активирован и списан',
  });
  // После заказа с бонусом клиенту начисляют новое вращение — отдельным действием.
  const grantSpin = useAction<{ userId: string }>('/api/admin/spins/grant', {
    success: 'Вращение начислено',
  });
  const giveBack = useAction<object>(`/api/admin/bonuses/${id}/return`, {
    success: 'Бонус возвращён клиенту',
  });
  const cancel = useAction<{ reason: string }>(`/api/admin/bonuses/${id}/cancel`, {
    success: 'Бонус аннулирован',
    onDone: done,
  });
  const correct = useAction<{ reason: string; extendDays: number | null }>(
    `/api/admin/bonuses/${id}/correct`,
    {
      success: 'Бонус возвращён в активное состояние',
      onDone: done,
    },
  );

  const closed = bonus && (['REDEEMED', 'EXPIRED', 'CANCELLED'] as BonusStatus[]).includes(bonus.status);
  const expired = bonus?.expiresAt ? new Date(bonus.expiresAt) <= new Date() : false;
  const canActivate = bonus && (bonus.status === 'RESERVED' || (bonus.status === 'ACTIVE' && !expired));

  return (
    <>
      <Sheet open={id !== null && dialog === null} onClose={onClose} title={bonus?.name ?? 'Бонус'} wide>
        {isPending ? (
          <Skeleton height={260} />
        ) : error ? (
          <ErrorState error={error} />
        ) : (
          <div className="stack" style={{ marginTop: 12 }}>
            <div className="row wrap">
              <Badge tone={BONUS_TONE[bonus.status]}>{BONUS_STATUS_LABELS[bonus.status]}</Badge>
              <span className="muted small">{PRIZE_TYPE_LABELS[bonus.type]}</span>
              {bonus.firstOrder && (
                <Badge tone="tone-accent" plain>
                  Приветственный — на первый заказ
                </Badge>
              )}
            </div>
            <BonusVerdict bonus={bonus} />

            {canActivate &&
              (can('bonuses.redeem') ? (
                <div className="stack tight">
                  <Button
                    variant="primary"
                    block
                    icon="check"
                    loading={activate.isPending}
                    onClick={() => activate.mutate({})}
                  >
                    Активировать бонус
                  </Button>
                  <p className="muted small">
                    Нажимайте, когда клиент оформляет заказ с этим бонусом. Бонус станет использованным. После
                    заказа начислите клиенту новое вращение — кнопка появится здесь же.
                  </p>
                </div>
              ) : (
                <p className="muted small">Активировать бонус может владелец или тимлид.</p>
              ))}

            <dl className="kv left">
              <dt>Номер бонуса</dt>
              <dd>
                <span className="code-tag">{bonus.code}</span>
              </dd>
              <dt>Клиент</dt>
              <dd>
                <Link to={`/admin/clients/${bonus.client.id}`} onClick={onClose}>
                  <b>{bonus.client.displayName}</b>
                </Link>{' '}
                <span className="muted">
                  {bonus.client.username ? `@${bonus.client.username} · ` : 'без username · '}ID{' '}
                  {bonus.client.telegramId}
                </span>
              </dd>
              <dt>Ценность</dt>
              <dd>{bonusValue(bonus, settings.currency)}</dd>
              <dt>Получен</dt>
              <dd>
                {dateTime(bonus.createdAt)} · {bonus.source === 'SPIN' ? 'рулетка' : 'выдан вручную'}
              </dd>
              {bonus.appliedAt && (
                <>
                  <dt>Применён клиентом</dt>
                  <dd>{dateTime(bonus.appliedAt)}</dd>
                </>
              )}
              <dt>Истекает</dt>
              <dd>{bonus.expiresAt ? dateTime(bonus.expiresAt) : 'бессрочно'}</dd>
              {bonus.redeemedAt && (
                <>
                  <dt>Активирован</dt>
                  <dd>
                    {dateTime(bonus.redeemedAt)} · {bonus.redeemedBy ?? '—'}
                  </dd>
                </>
              )}
              {bonus.minOrderAmount && (
                <>
                  <dt>Мин. сумма заказа</dt>
                  <dd>{money(bonus.minOrderAmount, settings.currency)}</dd>
                </>
              )}
              {bonus.maxDiscountAmount && (
                <>
                  <dt>Макс. скидка</dt>
                  <dd>{money(bonus.maxDiscountAmount, settings.currency)}</dd>
                </>
              )}
            </dl>

            <div className="tiny">История</div>
            <ul className="log">
              {bonus.history.map((h) => (
                <li key={h.id}>
                  <time>{dateTime(h.createdAt)}</time>
                  <div>
                    {h.previousStatus ? `${BONUS_STATUS_LABELS[h.previousStatus as BonusStatus]} → ` : ''}
                    <b>{BONUS_STATUS_LABELS[h.newStatus as BonusStatus]}</b>
                    <span className="muted"> · {h.actor}</span>
                    {h.reason && <div className="muted small">{h.reason}</div>}
                  </div>
                </li>
              ))}
            </ul>

            <div className="row wrap">
              <Link to={`/admin/clients/${bonus.client.id}`} onClick={onClose} className="btn secondary sm">
                Открыть клиента
              </Link>
              <a
                className="btn secondary sm"
                href={clientLink(bonus.client)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="chat" size={16} /> Написать
              </a>
              {bonus.status === 'RESERVED' && can('bonuses.release') && (
                <Button size="sm" loading={giveBack.isPending} onClick={() => giveBack.mutate({})}>
                  Вернуть клиенту
                </Button>
              )}
              {bonus.status === 'ACTIVE' && can('bonuses.cancel') && (
                <Button size="sm" variant="danger" onClick={() => setDialog('cancel')}>
                  Аннулировать
                </Button>
              )}
              {bonus.status === 'REDEEMED' && can('spins.grant') && (
                <Button
                  size="sm"
                  variant="solid"
                  icon="wheel"
                  loading={grantSpin.isPending}
                  onClick={() => grantSpin.mutate({ userId: bonus.client.id })}
                >
                  Начислить вращение
                </Button>
              )}
              {closed && can('bonuses.correct') && (
                <Button size="sm" onClick={() => setDialog('correct')}>
                  Вернуть в активные
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={onClose}>
                Закрыть
              </Button>
            </div>
          </div>
        )}
      </Sheet>

      <ReasonDialog
        open={dialog === 'cancel'}
        title="Аннулировать бонус"
        description="Клиент больше не сможет применить этот бонус. Запись останется в истории."
        confirmLabel="Аннулировать"
        danger
        loading={cancel.isPending}
        onClose={done}
        onConfirm={(reason) => cancel.mutate({ reason })}
      />
      <ReasonDialog
        open={dialog === 'correct'}
        title="Вернуть бонус в активные"
        description="Контролируемая корректировка: операция записывается в журнал. Используйте, если бонус активировали по ошибке или заказ не состоялся."
        confirmLabel="Вернуть бонус"
        loading={correct.isPending}
        onClose={done}
        onConfirm={(reason) => correct.mutate({ reason, extendDays: extendDays ? Number(extendDays) : null })}
      >
        <Field label="Продлить срок действия, дней" optional hint="Обязательно, если срок бонуса уже истёк">
          <input
            className="input"
            inputMode="numeric"
            value={extendDays}
            onChange={(e) => setExtendDays(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
      </ReasonDialog>
    </>
  );
}

export function Bonuses() {
  const { can } = useAdmin();
  const [params, setParams] = useSearchParams();
  const filters = {
    q: params.get('q') ?? '',
    status: params.get('status') ?? '',
    type: params.get('type') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
  };
  const page = Number(params.get('page') ?? 1);
  const [search, setSearch] = useState(filters.q);
  const [opened, setOpened] = useState<string | null>(null);
  const set = (patch: Record<string, string | number>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries({ page: '', ...patch }))
      v === '' ? next.delete(k) : next.set(k, String(v));
    setParams(next, { replace: true });
  };
  useEffect(() => {
    const t = setTimeout(() => search !== filters.q && set({ q: search }), 350);
    return () => clearTimeout(t);
  });

  const query = qs({ ...filters, page });
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ['admin', 'bonuses', query],
    queryFn: () => api<Paginated<AdminBonusRow>>(`/api/admin/bonuses${query}`),
    placeholderData: (prev) => prev,
    // Клиенты применяют бонусы в любой момент — список обновляется сам.
    refetchInterval: 20_000,
  });

  // Поиск по номеру дал ровно один бонус — сразу показываем его карточку.
  const single =
    data?.items.length === 1 && /^\s*(yb[-\s]?)?[0-9a-z]{6}\s*$/i.test(filters.q) ? data.items[0]!.id : null;
  const autoOpened = useRef<string | null>(null);
  useEffect(() => {
    if (single && autoOpened.current !== single) {
      autoOpened.current = single;
      setOpened(single);
    }
  }, [single]);

  return (
    <>
      <PageHead title="Бонусы">
        {can('reports.export') && <ExportButton table="bonuses" query={qs(filters)} />}
      </PageHead>
      <div className="filters">
        <input
          className="input search"
          placeholder="Номер бонуса, клиент или приз"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="input" value={filters.status} onChange={(e) => set({ status: e.target.value })}>
          <option value="">Все статусы</option>
          {BONUS_STATUSES.map((s) => (
            <option key={s} value={s}>
              {BONUS_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select className="input" value={filters.type} onChange={(e) => set({ type: e.target.value })}>
          <option value="">Все типы</option>
          {PRIZE_TYPES.map((t) => (
            <option key={t} value={t}>
              {PRIZE_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <input
          className="input"
          type="date"
          value={filters.from}
          aria-label="Получен с"
          onChange={(e) => set({ from: e.target.value })}
        />
        <input
          className="input"
          type="date"
          value={filters.to}
          aria-label="Получен по"
          onChange={(e) => set({ to: e.target.value })}
        />
      </div>
      {isPending ? (
        <Skeleton height={360} />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.items.length === 0 ? (
        <State icon="gift" title="Бонусов не найдено">
          {Object.values(filters).some(Boolean)
            ? 'Попробуйте изменить фильтры.'
            : 'Бонусы появятся после первых вращений рулетки.'}
        </State>
      ) : (
        <>
          <BonusesTable items={data.items} onOpen={setOpened} />
          <Pager
            page={data.page}
            total={data.total}
            pageSize={data.pageSize}
            onPage={(p) => set({ page: p })}
          />
        </>
      )}
      <BonusSheet id={opened} onClose={() => setOpened(null)} />
    </>
  );
}
