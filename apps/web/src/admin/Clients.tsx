import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { AdminClientCard, AdminClientRow, Paginated, PrizeDto } from '@contract/api.ts';
import { api, qs } from '../api.ts';
import { dateTime, shortDate } from '../format.ts';
import { Icon } from '../ui/icons.tsx';
import { Badge, Button, ErrorState, Field, Skeleton, State } from '../ui/kit.tsx';
import { BonusSheet, BonusesTable } from './Bonuses.tsx';
import {
  AuditList,
  ExportButton,
  PageHead,
  Pager,
  ReasonDialog,
  clientLink,
  useAction,
  useAdmin,
} from './shared.tsx';

const SORTS = [
  ['createdAt', 'Регистрация'],
  ['lastActiveAt', 'Активность'],
] as const;

export function Clients() {
  const { can } = useAdmin();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filters = {
    q: params.get('q') ?? '',
    status: params.get('status') ?? '',
    hasBonus: params.get('hasBonus') ?? '',
    sort: params.get('sort') ?? 'createdAt',
    dir: params.get('dir') ?? 'desc',
  };
  const page = Number(params.get('page') ?? 1);
  const [search, setSearch] = useState(filters.q);
  const set = (patch: Record<string, string | number>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries({ page: '', ...patch }))
      v === '' ? next.delete(k) : next.set(k, String(v));
    setParams(next, { replace: true });
  };
  // Поиск применяется с небольшой задержкой, чтобы не дёргать сервер на каждую букву.
  useEffect(() => {
    const t = setTimeout(() => search !== filters.q && set({ q: search }), 350);
    return () => clearTimeout(t);
  });
  const sortBy = (key: string) =>
    set({ sort: key, dir: filters.sort === key && filters.dir === 'desc' ? 'asc' : 'desc' });
  const arrow = (key: string) => (filters.sort === key ? (filters.dir === 'desc' ? ' ↓' : ' ↑') : '');

  const query = qs({ ...filters, page });
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ['admin', 'clients', query],
    queryFn: () => api<Paginated<AdminClientRow>>(`/api/admin/clients${query}`),
    placeholderData: (prev) => prev,
  });

  return (
    <>
      <PageHead title="Клиенты">
        {can('reports.export') && <ExportButton table="clients" query={qs(filters)} />}
      </PageHead>
      <div className="filters">
        <input
          className="input search"
          placeholder="Имя, username или Telegram ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="input" value={filters.status} onChange={(e) => set({ status: e.target.value })}>
          <option value="">Все клиенты</option>
          <option value="ACTIVE">Активные</option>
          <option value="BLOCKED">Заблокированные</option>
        </select>
        <select
          className="input"
          value={filters.hasBonus}
          onChange={(e) => set({ hasBonus: e.target.value })}
        >
          <option value="">С бонусом и без</option>
          <option value="yes">Есть активный бонус</option>
          <option value="no">Нет бонуса</option>
        </select>
      </div>
      {isPending ? (
        <Skeleton height={360} />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.items.length === 0 ? (
        <State icon="users" title="Клиентов не найдено">
          {filters.q || filters.status || filters.hasBonus
            ? 'Попробуйте изменить запрос.'
            : 'Клиенты появятся после первого входа в приложение.'}
        </State>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>
                    <button onClick={() => sortBy('displayName')}>Клиент{arrow('displayName')}</button>
                  </th>
                  <th>Telegram ID</th>
                  {SORTS.map(([key, label]) => (
                    <th key={key}>
                      <button onClick={() => sortBy(key)}>
                        {label}
                        {arrow(key)}
                      </button>
                    </th>
                  ))}
                  <th className="num">Активный бонус</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => navigate(`/admin/clients/${c.id}`)}>
                    <td>
                      <b>{c.displayName}</b>
                      {c.username && <div className="muted small">@{c.username}</div>}
                    </td>
                    <td className="mono muted">{c.telegramId}</td>
                    <td className="muted">{shortDate(c.createdAt)}</td>
                    <td className="muted">{dateTime(c.lastActiveAt)}</td>
                    <td className="num">{c.activeBonuses ? 'есть' : '—'}</td>
                    <td>
                      <Badge tone={c.accountStatus === 'ACTIVE' ? 'tone-ok' : 'tone-danger'}>
                        {c.accountStatus === 'ACTIVE' ? 'Активен' : 'Заблокирован'}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            page={data.page}
            total={data.total}
            pageSize={data.pageSize}
            onPage={(p) => set({ page: p })}
          />
        </>
      )}
    </>
  );
}

type Tab = 'bonuses' | 'activity' | 'audit';
type Dialog = 'block' | 'grant' | null;

export function ClientCard() {
  const { id } = useParams();
  const { can } = useAdmin();
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ['admin', 'client', id],
    queryFn: () => api<AdminClientCard>(`/api/admin/clients/${id}`),
  });
  const [tab, setTab] = useState<Tab>('bonuses');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [openedBonus, setOpenedBonus] = useState<string | null>(null);
  const close = () => setDialog(null);

  const prizes = useQuery({
    queryKey: ['admin', 'prizes'],
    queryFn: () => api<{ items: PrizeDto[] }>('/api/admin/prizes'),
    enabled: dialog === 'grant',
  });
  const [prizeId, setPrizeId] = useState('');

  const setStatus = useAction<{ status: string; reason: string }>(`/api/admin/clients/${id}/status`, {
    success: 'Статус клиента изменён',
    onDone: close,
  });
  // Сервер сам откажет, если у клиента уже есть вращение или действующий бонус.
  const grantSpin = useAction<{ userId: string }>('/api/admin/spins/grant', {
    success: 'Вращение начислено',
  });
  const grantBonus = useAction<{ userId: string; prizeId: string; reason: string }>(
    '/api/admin/bonuses/grant',
    { success: 'Бонус выдан', onDone: close },
  );

  if (isPending) return <Skeleton height={420} />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const { client } = data;
  const blocked = client.accountStatus === 'BLOCKED';
  const used = data.bonuses.filter((b) => b.status === 'REDEEMED').length;

  const tabs: [Tab, string, number][] = [
    ['bonuses', 'Бонусы', data.bonuses.length],
    ['activity', 'Активность', data.activity.length],
    ['audit', 'Действия сотрудников', data.audit.length],
  ];

  return (
    <>
      <PageHead
        title={client.displayName}
        back={
          <Link to="/admin/clients" className="crumb">
            <Icon name="back" size={14} /> Клиенты
          </Link>
        }
      >
        <a className="btn secondary sm" href={clientLink(client)} target="_blank" rel="noopener noreferrer">
          <Icon name="chat" size={16} /> Написать
        </a>
        {can('bonuses.grant') && (
          <Button size="sm" icon="gift" onClick={() => setDialog('grant')}>
            Выдать бонус
          </Button>
        )}
        {can('spins.grant') && (
          <Button
            size="sm"
            icon="wheel"
            loading={grantSpin.isPending}
            onClick={() => {
              if (
                window.confirm(`Клиент «${client.displayName}» сделал заказ — начислить ему одно вращение?`)
              ) {
                grantSpin.mutate({ userId: client.id });
              }
            }}
          >
            Начислить вращение
          </Button>
        )}
        {can('clients.manage') && (
          <Button size="sm" variant={blocked ? 'secondary' : 'danger'} onClick={() => setDialog('block')}>
            {blocked ? 'Разблокировать' : 'Заблокировать'}
          </Button>
        )}
      </PageHead>

      <div className="kpis" style={{ marginBottom: 20 }}>
        <div className="kpi">
          <span>Telegram</span>
          <b style={{ fontSize: 16 }}>{client.username ? `@${client.username}` : 'без username'}</b>
          <small className="mono">ID {client.telegramId}</small>
        </div>
        <div className="kpi">
          <span>Зарегистрирован</span>
          <b style={{ fontSize: 16 }}>{shortDate(client.createdAt)}</b>
          <small>Активность: {dateTime(client.lastActiveAt)}</small>
        </div>
        <div className="kpi">
          <span>Активный бонус</span>
          <b>{client.activeBonuses ? 'есть' : 'нет'}</b>
          <small>доступно вращений: {client.spinAttempts}</small>
        </div>
        <div className="kpi">
          <span>Использовано бонусов</span>
          <b>{used}</b>
        </div>
        <div className="kpi">
          <span>Статус</span>
          <b style={{ fontSize: 16 }}>{blocked ? 'Заблокирован' : 'Активен'}</b>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {tabs.map(([key, label, n]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
            {label} <span className="muted">{n}</span>
          </button>
        ))}
      </div>

      {tab === 'bonuses' &&
        (data.bonuses.length ? (
          <BonusesTable items={data.bonuses} onOpen={setOpenedBonus} hideClient />
        ) : (
          <State icon="gift" title="Бонусов нет" />
        ))}
      {tab === 'activity' && (
        <div className="panel">
          {data.activity.length ? (
            <ul className="log">
              {data.activity.map((a) => (
                <li key={a.id}>
                  <time>{dateTime(a.createdAt)}</time>
                  <div>{a.title}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Активности пока нет.</p>
          )}
        </div>
      )}
      {tab === 'audit' && (
        <div className="panel">
          <AuditList items={data.audit} />
        </div>
      )}

      <BonusSheet id={openedBonus} onClose={() => setOpenedBonus(null)} />

      <ReasonDialog
        open={dialog === 'block'}
        title={blocked ? 'Разблокировать клиента' : 'Заблокировать клиента'}
        description={
          blocked
            ? 'Клиент снова сможет крутить рулетку и применять бонусы.'
            : 'Клиент не сможет крутить рулетку и применять бонусы. Его данные и история сохранятся.'
        }
        confirmLabel={blocked ? 'Разблокировать' : 'Заблокировать'}
        danger={!blocked}
        loading={setStatus.isPending}
        onClose={close}
        onConfirm={(reason) => setStatus.mutate({ status: blocked ? 'ACTIVE' : 'BLOCKED', reason })}
      />
      <ReasonDialog
        open={dialog === 'grant'}
        title="Выдать бонус вручную"
        description="Бонус выдаётся, только если у клиента нет активного бонуса или бонуса, ожидающего активации."
        confirmLabel="Выдать бонус"
        loading={grantBonus.isPending}
        onClose={close}
        onConfirm={(reason) => prizeId && grantBonus.mutate({ userId: client.id, prizeId, reason })}
      >
        <Field label="Приз" hint={prizes.error ? 'Не удалось загрузить список призов' : undefined}>
          <select className="input" value={prizeId} onChange={(e) => setPrizeId(e.target.value)}>
            <option value="">Выберите приз</option>
            {prizes.data?.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      </ReasonDialog>
    </>
  );
}
