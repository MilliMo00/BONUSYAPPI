import { Link, useNavigate } from 'react-router-dom';
import type { SpinAvailability } from '@contract/api.ts';
import type { SpinGrantTrigger } from '@contract/constants.ts';
import { date } from '../format.ts';
import { plural, t } from '../i18n.ts';
import { openTelegramLink } from '../telegram.ts';
import { Icon } from '../ui/icons.tsx';
import { Button, ErrorState, Skeleton } from '../ui/kit.tsx';
import { BonusTicket } from './BonusTicket.tsx';
import { useApplyBonus, useHome } from './hooks.ts';

/** Объяснение, почему рулетка недоступна, на языке клиента. */
export function availabilityText(a: SpinAvailability, trigger: SpinGrantTrigger | undefined): string {
  if (a.reason === 'NO_ATTEMPTS') {
    return t(
      trigger === 'BONUS_ACTIVATED'
        ? 'avail.NO_ATTEMPTS.BONUS_ACTIVATED'
        : trigger === 'NONE'
          ? 'avail.NO_ATTEMPTS.NONE'
          : 'avail.NO_ATTEMPTS.ORDER',
    );
  }
  return a.reason ? t(`avail.${a.reason}`) : '';
}

export function MiniWheel() {
  const colors = ['#00d4ff', '#3a0f75', '#ffd700', '#1e1038', '#7b2fbe', '#ff6b00'];
  return (
    <svg className="mini-wheel" viewBox="0 0 100 100" aria-hidden="true">
      {colors.map((c, i) => (
        <path
          key={i}
          d="M50 50 L50 2 A48 48 0 0 1 91.57 26 Z"
          fill={c}
          transform={`rotate(${i * 60} 50 50)`}
        />
      ))}
      <circle cx="50" cy="50" r="9" fill="var(--surface)" />
    </svg>
  );
}

export function Home() {
  const { data, error, isPending, refetch } = useHome();
  const navigate = useNavigate();
  const { apply, busy } = useApplyBonus();

  if (isPending) {
    return (
      <div className="page">
        <Skeleton height={64} />
        <Skeleton height={72} />
        <Skeleton height={210} />
        <Skeleton height={150} />
      </div>
    );
  }
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const { me, activeBonus, availability, settings } = data;
  const firstName = me.displayName.split(' ')[0] ?? '';

  return (
    <div className="page page-enter">
      <header className="hello">
        <div>
          <div className="brand">{settings.brandName}</div>
          <h1 className="display">{t('home.hello', { name: firstName })}</h1>
        </div>
        <Link to="/profile" className="avatar" aria-label={t('profile.aria')}>
          {firstName[0]?.toUpperCase()}
        </Link>
      </header>

      <div className="stats">
        <div className="stat">
          <b>{data.activeBonusesCount}</b>
          <span>{plural(data.activeBonusesCount, 'activeBonus')}</span>
        </div>
        <div className="stat">
          <b>{me.redeemedBonusesCount}</b>
          <span>{plural(me.redeemedBonusesCount, 'usedBonus')}</span>
        </div>
      </div>

      {activeBonus ? (
        <BonusTicket bonus={activeBonus} currency={settings.currency}>
          <div className="hint">
            {t(
              activeBonus.status !== 'ACTIVE'
                ? 'bonus.pendingHint'
                : activeBonus.firstOrder
                  ? 'bonus.firstOrder'
                  : 'bonus.nextOrder',
            )}
          </div>
          <div style={{ marginTop: 12 }}>
            <Button variant="solid" block icon="chat" loading={busy} onClick={() => void apply(activeBonus)}>
              {t(activeBonus.status === 'ACTIVE' ? 'bonus.apply' : 'common.writeManager')}
            </Button>
          </div>
        </BonusTicket>
      ) : availability.canSpin ? (
        <div className="promo">
          <MiniWheel />
          <span className="tiny">{t('home.spinAvailable')}</span>
          <h3 className="display">{t('home.tryLuck')}</h3>
          <p className="muted small">{t('home.promoText')}</p>
          {availability.attemptsExpireAt && (
            <p className="small" style={{ color: 'var(--gold)', maxWidth: '74%' }}>
              {t('roulette.spinUntil', { date: date(availability.attemptsExpireAt) })}
            </p>
          )}
          <Button variant="primary" icon="wheel" onClick={() => navigate('/roulette')}>
            {t('roulette.spin')}
          </Button>
        </div>
      ) : (
        <div className="note">
          <Icon name="wheel" size={20} />
          <span>{availabilityText(availability, settings.spinGrantTrigger)}</span>
        </div>
      )}

      <div className="card stack">
        <div className="tiny">{t('home.how')}</div>
        <ol className="steps">
          {([1, 2, 3] as const).map((n) => (
            <li key={n}>
              <span>
                <b>{t(`home.step${n}.title`)}</b>
                {t(`home.step${n}.text`)}
              </span>
            </li>
          ))}
        </ol>
      </div>

      {settings.managerContactUrl ? (
        <Button
          variant="ghost"
          icon="chat"
          block
          onClick={() => openTelegramLink(settings.managerContactUrl)}
        >
          {t('common.writeManager')}
        </Button>
      ) : null}
    </div>
  );
}
