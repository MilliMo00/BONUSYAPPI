import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { StatsDto } from '@contract/api.ts';
import { api, qs } from '../api.ts';
import { ErrorState, Skeleton, State } from '../ui/kit.tsx';
import { Kpi } from './Dashboard.tsx';
import { ExportButton, PageHead, PeriodFilter, lastDays, useAdmin } from './shared.tsx';

const percent = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1).replace('.0', '')}%`);

function duration(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} мин`;
  if (hours < 48) return `${hours.toFixed(1).replace('.0', '')} ч`;
  return `${(hours / 24).toFixed(1).replace('.0', '')} дн`;
}

export function Stats() {
  const { can } = useAdmin();
  const [period, setPeriod] = useState(lastDays(30));
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ['admin', 'stats', period],
    queryFn: () => api<StatsDto>(`/api/admin/stats${qs({ ...period })}`),
  });
  const max = Math.max(1, ...(data?.distribution.map((d) => d.count) ?? []));

  return (
    <>
      <PageHead title="Статистика">
        <PeriodFilter value={period} onChange={setPeriod} />
      </PageHead>
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
          <div className="kpis">
            <Kpi label="Вращений" value={data.spins} />
            <Kpi label="Выдано бонусов" value={data.bonusesIssued} />
            <Kpi label="Использовано" value={data.bonusesRedeemed} hint="активировано сотрудниками" />
            <Kpi label="Истекло" value={data.bonusesExpired} />
            <Kpi
              label="Выигрыш → применение"
              value={percent(data.winToOrderConversion)}
              hint="доля бонусов периода, которые клиент применил"
            />
            <Kpi
              label="Время до использования"
              value={duration(data.avgHoursToRedeem)}
              hint="в среднем от выигрыша до активации"
            />
          </div>

          <div className="group-title">Распределение выигрышей</div>
          <div className="panel">
            {data.distribution.length === 0 ? (
              <State icon="wheel" title="Вращений за период не было" />
            ) : (
              <div className="bars">
                {data.distribution.map((d) => (
                  <div className="bar" key={d.name}>
                    <span className="truncate">{d.name}</span>
                    <div className="track">
                      <div className="fill" style={{ width: `${(d.count / max) * 100}%` }} />
                    </div>
                    <span className="mono muted" style={{ textAlign: 'right' }}>
                      {d.count} · {percent(d.count / data.spins)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {can('reports.export') && (
            <>
              <div className="group-title">Выгрузка таблиц</div>
              <div className="panel">
                <div className="row wrap">
                  {(
                    [
                      ['clients', 'Клиенты'],
                      ['bonuses', 'Бонусы'],
                      ['spins', 'Вращения за период'],
                    ] as const
                  ).map(([table, label]) => (
                    <div className="row" key={table}>
                      <span>{label}</span>
                      <ExportButton table={table} query={table === 'spins' ? qs({ ...period }) : ''} />
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
