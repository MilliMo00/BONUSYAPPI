import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { BonusDto } from '@contract/api.ts';
import { api } from '../api.ts';
import { date, money } from '../format.ts';
import { t } from '../i18n.ts';
import { Button, ErrorState, Sheet, Skeleton, State } from '../ui/kit.tsx';
import { BonusTicket } from './BonusTicket.tsx';
import { useApplyBonus, useHome } from './hooks.ts';

function terms(b: BonusDto, currency: string): string[] {
  const list: string[] = [t(b.firstOrder ? 'term.firstOrder' : 'term.oneOrder')];
  if (b.rules.terms) list.push(b.rules.terms);
  if (b.minOrderAmount) list.push(t('term.min', { amount: money(b.minOrderAmount, currency) }));
  if (b.maxDiscountAmount) list.push(t('term.max', { amount: money(b.maxDiscountAmount, currency) }));
  if (b.rules.allowedServices.length)
    list.push(t('term.services', { list: b.rules.allowedServices.join(', ') }));
  if (!b.rules.stackable && b.type !== 'PRIVILEGE') list.push(t('term.noStack'));
  list.push(t('term.howApply'), t('term.usedAfter'));
  return list;
}

export function Bonuses() {
  const navigate = useNavigate();
  const home = useHome();
  const { apply, busy } = useApplyBonus();
  // Язык в ключе запроса: при смене языка названия бонусов перезагружаются.
  const locale = home.data?.me.locale;
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ['bonuses', locale],
    queryFn: () => api<{ items: BonusDto[] }>('/api/bonuses'),
  });
  const [opened, setOpened] = useState<BonusDto | null>(null);
  const currency = home.data?.settings.currency ?? 'USD';

  if (isPending) {
    return (
      <div className="page">
        <Skeleton height={40} width={220} />
        <Skeleton height={230} />
        <Skeleton height={150} />
      </div>
    );
  }
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const open = data.items.filter((b) => b.status === 'ACTIVE' || b.status === 'RESERVED');
  const history = data.items.filter((b) => !open.includes(b));

  return (
    <div className="page page-enter">
      <h1 className="display page-title">{t('bonuses.title')}</h1>

      {data.items.length === 0 && (
        <State
          icon="gift"
          title={t('bonuses.emptyTitle')}
          action={
            <Button variant="primary" size="sm" onClick={() => navigate('/roulette')}>
              {t('bonuses.toRoulette')}
            </Button>
          }
        >
          {t('bonuses.emptyText')}
        </State>
      )}

      {open.map((b) => (
        <BonusTicket key={b.id} bonus={b} currency={currency}>
          <div className="hint">
            {t(
              b.status !== 'ACTIVE'
                ? 'bonus.pendingHint'
                : b.firstOrder
                  ? 'bonus.firstOrder'
                  : 'bonus.nextOrder',
            )}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <Button variant="solid" className="grow" icon="chat" loading={busy} onClick={() => void apply(b)}>
              {t(b.status === 'ACTIVE' ? 'bonus.apply' : 'common.writeManager')}
            </Button>
            <Button variant="solid" className="dim" onClick={() => setOpened(b)}>
              {t('bonuses.terms')}
            </Button>
          </div>
        </BonusTicket>
      ))}

      {history.length > 0 && (
        <>
          <div className="section-title">
            <h2>{t('bonuses.history')}</h2>
          </div>
          {history.map((b) => (
            <button
              key={b.id}
              className="card tap"
              onClick={() => setOpened(b)}
              style={{ padding: 0, border: 0, background: 'none' }}
            >
              <BonusTicket bonus={b} currency={currency} copyable={false} />
            </button>
          ))}
        </>
      )}

      <Sheet open={opened !== null} onClose={() => setOpened(null)} title={opened?.name}>
        {opened && (
          <div className="stack" style={{ marginTop: 12 }}>
            {opened.description && <p className="muted">{opened.description}</p>}
            <dl className="kv">
              <dt>{t('bonus.number')}</dt>
              <dd className="mono">{opened.code}</dd>
              <dt>{t('bonuses.received')}</dt>
              <dd>
                {date(opened.createdAt)} ·{' '}
                {t(opened.source === 'SPIN' ? 'bonuses.srcSpin' : 'bonuses.srcManual')}
              </dd>
              <dt>{t('bonuses.validity')}</dt>
              <dd>
                {opened.expiresAt
                  ? t('bonuses.until', { date: date(opened.expiresAt) })
                  : t('bonuses.noExpiry')}
              </dd>
              {opened.status === 'RESERVED' && opened.appliedAt && (
                <>
                  <dt>{t('bonuses.sentToManager')}</dt>
                  <dd>{date(opened.appliedAt)}</dd>
                </>
              )}
              {opened.redeemedAt && (
                <>
                  <dt>{t('bonuses.used')}</dt>
                  <dd>{date(opened.redeemedAt)}</dd>
                </>
              )}
            </dl>
            <div className="card flat" style={{ padding: 14 }}>
              <div className="tiny" style={{ marginBottom: 8 }}>
                {t('bonuses.termsTitle')}
              </div>
              <ul className="muted small" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
                {terms(opened, currency).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            <Button block onClick={() => setOpened(null)}>
              {t('bonuses.ok')}
            </Button>
          </div>
        )}
      </Sheet>
    </div>
  );
}
