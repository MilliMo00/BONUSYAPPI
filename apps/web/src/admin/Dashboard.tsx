import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { DashboardDto, SpinLookupDto } from '@contract/api.ts';
import { api, qs } from '../api.ts';
import { dateTime } from '../format.ts';
import { Button, ErrorState, Skeleton, errorMessage, useToast } from '../ui/kit.tsx';
import { PageHead, PeriodFilter, lastDays, useAction, useAdmin } from './shared.tsx';

export function Kpi({
  label,
  value,
  hint,
  accent,
  to,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  accent?: boolean;
  to?: string;
}) {
  const body = (
    <>
      <span>{label}</span>
      <b>{value}</b>
      {hint && <small>{hint}</small>}
    </>
  );
  return to ? (
    <Link to={to} className={`kpi ${accent ? 'accent' : ''}`}>
      {body}
    </Link>
  ) : (
    <div className={`kpi ${accent ? 'accent' : ''}`}>{body}</div>
  );
}

/** Начисление вращения за заказ: найти клиента по @username или Telegram ID и выдать одно вращение. */
export function GrantSpin() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<SpinLookupDto | null>(null);
  const [searching, setSearching] = useState(false);
  const grant = useAction<{ userId: string }, SpinLookupDto>('/api/admin/spins/grant', {
    success: 'Вращение начислено — клиент получил уведомление',
    onDone: (next) => {
      setFound(next);
      setQ('');
    },
  });

  async function search() {
    if (!q.trim()) return;
    setSearching(true);
    setFound(null);
    try {
      setFound(await api<SpinLookupDto>(`/api/admin/spins/lookup${qs({ q: q.trim() })}`));
    } catch (err) {
      toast(errorMessage(err), true);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="lookup" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <div className="grow" style={{ minWidth: 200 }}>
          <b>Начислить вращение за заказ</b>
          <div className="muted small">Введите @username или Telegram ID клиента, который сделал заказ</div>
        </div>
        <input
          className="input"
          style={{ textTransform: 'none', letterSpacing: 0, fontFamily: 'inherit' }}
          value={q}
          placeholder="@username или ID"
          maxLength={64}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button type="submit" variant="solid" icon="search" loading={searching} disabled={!q.trim()}>
          Найти
        </Button>
      </form>
      {found && (
        <div
          className={`verdict ${found.canGrant ? 'tone-ok' : found.attempts > 0 ? 'tone-info' : 'tone-warn'}`}
        >
          <div className="grow">
            {found.client.displayName}{' '}
            <span className="muted" style={{ fontWeight: 500 }}>
              {found.client.username ? `@${found.client.username} · ` : 'без username · '}ID{' '}
              {found.client.telegramId}
            </span>
            <small>
              {found.canGrant
                ? 'Вращений и действующего бонуса нет — можно начислить.'
                : found.attempts > 0
                  ? `У клиента есть вращение, действует до ${dateTime(found.attemptsExpireAt)}.`
                  : found.openBonus
                    ? `Действующий бонус «${found.openBonus.name}» ${found.openBonus.code} — сначала активируйте его или дождитесь, пока сгорит.`
                    : found.reason}
            </small>
          </div>
          {found.canGrant && (
            <Button
              variant="primary"
              icon="wheel"
              loading={grant.isPending}
              onClick={() => grant.mutate({ userId: found.client.id })}
            >
              Начислить вращение
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function Dashboard() {
  const { can } = useAdmin();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [period, setPeriod] = useState(lastDays(30));
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ['admin', 'dashboard', period],
    queryFn: () => api<DashboardDto>(`/api/admin/dashboard${qs({ ...period })}`),
    // Заявки на активацию приходят в любой момент — дашборд обновляется сам.
    refetchInterval: 20_000,
  });
  const bonusLink = (status: string) => (can('bonuses.view') ? `/admin/bonuses?status=${status}` : undefined);

  return (
    <>
      <PageHead title="Дашборд">
        <PeriodFilter value={period} onChange={setPeriod} />
      </PageHead>
      {can('bonuses.view') && (
        <form
          className="lookup"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) navigate(`/admin/bonuses${qs({ q: code.trim() })}`);
          }}
        >
          <div className="grow" style={{ minWidth: 200 }}>
            <b>Проверить бонус</b>
            <div className="muted small">
              Введите номер из сообщения клиента — увидите аккаунт владельца, статус и кнопку активации
            </div>
          </div>
          <input
            className="input"
            value={code}
            placeholder="YB-XXXXXX"
            maxLength={12}
            onChange={(e) => setCode(e.target.value)}
          />
          <Button type="submit" variant="solid" icon="search" disabled={!code.trim()}>
            Найти
          </Button>
        </form>
      )}
      {can('spins.grant') && <GrantSpin />}
      {isPending ? (
        <div className="kpis">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={96} />
          ))}
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <>
          <div className="group-title">Бонусы</div>
          <div className="kpis">
            <Kpi
              label="Ожидают активации"
              value={data.bonusesReserved}
              accent={data.bonusesReserved > 0}
              hint="клиент нажал «Применить бонус»"
              to={bonusLink('RESERVED')}
            />
            <Kpi
              label="Активные"
              value={data.bonusesActive}
              hint="выиграны, ещё не применены"
              to={bonusLink('ACTIVE')}
            />
            <Kpi
              label="Использовано"
              value={data.bonusesRedeemed}
              hint="за период"
              to={bonusLink('REDEEMED')}
            />
          </div>

          <div className="group-title">Клиенты</div>
          <div className="kpis">
            <Kpi
              label="Клиентов всего"
              value={data.clientsTotal}
              to={can('clients.view') ? '/admin/clients' : undefined}
            />
            <Kpi label="Новых клиентов" value={data.clientsNew} hint="за период" />
          </div>
        </>
      )}
    </>
  );
}
