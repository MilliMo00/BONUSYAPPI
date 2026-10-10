import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { BonusDto, RouletteState, SpinResult } from '@contract/api.ts';
import { ApiFailure, api } from '../api.ts';
import { bonusValue, date } from '../format.ts';
import { plural, t } from '../i18n.ts';
import { haptic } from '../telegram.ts';
import { Icon } from '../ui/icons.tsx';
import { Button, ErrorState, Sheet, Skeleton, State, errorMessage, useToast } from '../ui/kit.tsx';
import { expiryText } from './BonusTicket.tsx';
import { Confetti } from './Confetti.tsx';
import { availabilityText } from './Home.tsx';
import { useApplyBonus, useHome, uuid } from './hooks.ts';
import { WHEEL_COLORS, Wheel } from './Wheel.tsx';
import type { WheelHandle } from './Wheel.tsx';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Запрос вращения. При обрыве связи повторяется с тем же requestId:
 * сервер вернёт уже определённый результат и не выдаст второй приз.
 */
async function requestSpin(requestId: string): Promise<SpinResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api<SpinResult>('/api/roulette/spin', 'POST', { requestId });
    } catch (err) {
      if (!(err instanceof ApiFailure && err.isNetwork) || attempt >= 2) throw err;
      await wait(900);
    }
  }
}

export function Roulette() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const home = useHome();
  const { apply, busy: applying } = useApplyBonus();
  // Язык в ключе запроса: названия призов на колесе приходят уже переведёнными.
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ['roulette', home.data?.me.locale],
    queryFn: () => api<RouletteState>('/api/roulette'),
  });
  const wheel = useRef<WheelHandle>(null);
  const [spinning, setSpinning] = useState(false);
  const [won, setWon] = useState<BonusDto | null>(null);

  if (isPending) {
    return (
      <div className="page">
        <Skeleton height={40} width={200} />
        <Skeleton height={340} />
        <Skeleton height={52} />
      </div>
    );
  }
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const { segments, availability } = data;
  const currency = home.data?.settings.currency ?? 'USD';

  async function onSpin() {
    if (spinning) return;
    setSpinning(true);
    haptic.impact('medium');
    const requestId = uuid();
    wheel.current?.start();
    try {
      // Колесо разгоняется минимум секунду, даже если сервер ответил мгновенно.
      const [result] = await Promise.all([requestSpin(requestId), wait(1000)]);
      const index = segments.findIndex((s) => s.prizeId === result.prizeId);
      if (index >= 0) await wheel.current?.stopAt(index);
      else await wheel.current?.abort(); // набор призов изменился, пока экран был открыт — показываем фактический результат
      haptic.notify('success');
      setWon(result.bonus);
    } catch (err) {
      await wheel.current?.abort();
      haptic.notify('error');
      toast(errorMessage(err), true);
    } finally {
      setSpinning(false);
      void qc.invalidateQueries();
    }
  }

  if (segments.length < 2) {
    return (
      <div className="page page-enter">
        <h1 className="display page-title">{t('roulette.title')}</h1>
        <State icon="wheel" title={t('roulette.soonTitle')}>
          {t('roulette.soonText')}
        </State>
      </div>
    );
  }

  const locked = !availability.canSpin && !spinning && !won;

  return (
    <div className="page page-enter">
      <h1 className="display page-title">{t('roulette.title')}</h1>

      <Wheel
        ref={wheel}
        segments={segments}
        state={spinning ? 'spinning' : locked ? 'locked' : 'idle'}
        hub="SPIN"
      />

      {availability.canSpin || spinning ? (
        <>
          <div className="attempts">
            <Icon name="wheel" size={16} />
            <span>
              {t('roulette.available')} <b>{availability.attempts}</b> {plural(availability.attempts, 'spin')}
            </span>
          </div>
          {availability.attemptsExpireAt && !spinning && (
            <p className="muted small" style={{ textAlign: 'center', marginTop: -8 }}>
              {t('roulette.spinUntil', { date: date(availability.attemptsExpireAt) })}
            </p>
          )}
          <Button variant="primary" block loading={spinning} onClick={() => void onSpin()}>
            {spinning ? t('roulette.spinning') : t('roulette.spin')}
          </Button>
        </>
      ) : (
        <div className="note warn">
          <Icon name="lock" size={20} />
          <div className="stack tight">
            <span>{availabilityText(availability, home.data?.settings.spinGrantTrigger)}</span>
            {availability.reason === 'ACTIVE_BONUS' && (
              <Button
                size="sm"
                variant="solid"
                onClick={() => navigate('/bonuses')}
                style={{ alignSelf: 'flex-start' }}
              >
                {t('roulette.myBonus')}
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="card">
        <div className="tiny" style={{ marginBottom: 4 }}>
          {t('roulette.prizes')}
        </div>
        <ul className="prize-list">
          {segments.map((s, i) => (
            <li key={s.prizeId}>
              <span
                className="swatch"
                style={{
                  background: WHEEL_COLORS[i % WHEEL_COLORS.length]![0],
                  outline: '1px solid var(--line-strong)',
                }}
              />
              <span className="grow">{s.name}</span>
            </li>
          ))}
        </ul>
        <p className="muted small" style={{ marginTop: 10 }}>
          {t('roulette.oneBonus')}
        </p>
      </div>

      {won && <Confetti />}
      <Sheet open={won !== null} onClose={() => setWon(null)}>
        {won && (
          <div className="win">
            <span className="kicker">{t('win.kicker')}</span>
            <div className="big">{bonusValue(won, currency)}</div>
            <h2 className="display">{won.name}</h2>
            <p className="muted">
              <b>{t(won.firstOrder ? 'bonus.firstOrder' : 'bonus.nextOrder')}</b> {expiryText(won)}.
              <br />
              {t('bonus.number')}: <b className="mono">{won.code}</b>
            </p>
            <Button
              variant="primary"
              block
              icon="chat"
              loading={applying}
              onClick={() => void apply(won).then(() => setWon(null))}
            >
              {t('bonus.apply')}
            </Button>
            <Button variant="ghost" block onClick={() => navigate('/bonuses')}>
              {t('win.toBonuses')}
            </Button>
          </div>
        )}
      </Sheet>
    </div>
  );
}
