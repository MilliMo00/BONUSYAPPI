import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { AuditDto, Paginated } from '@contract/api.ts';
import { ROLE_LABELS } from '@contract/constants.ts';
import type { Role } from '@contract/constants.ts';
import { api, qs } from '../api.ts';
import { dateTime } from '../format.ts';
import { ErrorState, Skeleton, State } from '../ui/kit.tsx';
import { PageHead, Pager, actionLabel } from './shared.tsx';

const GROUPS = [
  ['', 'Все действия'],
  ['order', 'Заказы'],
  ['payment', 'Оплаты'],
  ['bonus', 'Бонусы'],
  ['roulette', 'Рулетка'],
  ['client', 'Клиенты'],
  ['staff', 'Сотрудники'],
  ['settings', 'Настройки'],
] as const;

export function Audit() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ['admin', 'audit', action, page],
    queryFn: () => api<Paginated<AuditDto>>(`/api/admin/audit${qs({ action, page })}`),
  });

  return (
    <>
      <PageHead title="Журнал аудита" />
      <div className="filters">
        <select
          className="input"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setPage(1);
          }}
        >
          {GROUPS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {isPending ? (
        <Skeleton height={320} />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.items.length === 0 ? (
        <State icon="list" title="Записей нет" />
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Кто</th>
                  <th>Действие</th>
                  <th>Подробности</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((a) => (
                  <tr key={a.id}>
                    <td className="muted">{dateTime(a.createdAt)}</td>
                    <td>
                      <b>{a.actor}</b>
                      {a.actorRole && (
                        <div className="muted small">{ROLE_LABELS[a.actorRole as Role] ?? a.actorRole}</div>
                      )}
                    </td>
                    <td>{actionLabel(a.action)}</td>
                    <td className="wrap">
                      <details>
                        <summary className="muted small" style={{ cursor: 'pointer' }}>
                          Показать
                        </summary>
                        <code className="json">{JSON.stringify(a.details, null, 2)}</code>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} total={data.total} pageSize={data.pageSize} onPage={setPage} />
        </>
      )}
    </>
  );
}
