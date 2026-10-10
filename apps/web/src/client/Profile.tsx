import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { ActivityDto } from '@contract/api.ts';
import { LOCALES, LOCALE_LABELS } from '@contract/constants.ts';
import type { Locale } from '@contract/constants.ts';
import { api } from '../api.ts';
import { date, dateTime } from '../format.ts';
import { t, tMaybe } from '../i18n.ts';
import { haptic, openTelegramLink } from '../telegram.ts';
import { Button, ErrorState, Skeleton, State, errorMessage, useToast } from '../ui/kit.tsx';
import { useHome } from './hooks.ts';

export function Profile() {
  const qc = useQueryClient();
  const toast = useToast();
  const home = useHome();
  const activity = useQuery({
    queryKey: ['activity'],
    queryFn: () => api<{ items: ActivityDto[] }>('/api/activity'),
  });
  // Язык меняется сразу для интерфейса, сообщений бота и кнопки меню.
  const changeLocale = useMutation({
    mutationFn: (locale: Locale) => api('/api/me/locale', 'PUT', { locale }),
    onSuccess: () => qc.invalidateQueries(),
    onError: (err) => toast(errorMessage(err), true),
  });

  if (home.isPending) {
    return (
      <div className="page">
        <Skeleton height={150} />
        <Skeleton height={220} />
      </div>
    );
  }
  if (home.error) return <ErrorState error={home.error} onRetry={() => void home.refetch()} />;
  const { me, settings } = home.data;

  return (
    <div className="page page-enter">
      <h1 className="display page-title">{t('profile.title')}</h1>

      <div className="card stack">
        <div className="row">
          <div className="avatar">{me.displayName[0]?.toUpperCase()}</div>
          <div className="grow">
            <div style={{ fontWeight: 800, fontSize: 17 }} className="truncate">
              {me.displayName}
            </div>
            <div className="muted small">{me.username ? `@${me.username}` : t('profile.noUsername')}</div>
          </div>
        </div>
        <dl className="kv">
          <dt>Telegram ID</dt>
          <dd className="mono">{me.telegramId}</dd>
          <dt>{t('profile.since')}</dt>
          <dd>{date(me.createdAt)}</dd>
          <dt>{t('profile.used')}</dt>
          <dd>{me.redeemedBonusesCount}</dd>
        </dl>
        <p className="muted small">{t('profile.tgNote')}</p>
      </div>

      <div className="card stack">
        <div className="tiny">{t('profile.language')}</div>
        <div className="segmented">
          {LOCALES.map((locale) => (
            <button
              key={locale}
              aria-pressed={me.locale === locale}
              disabled={changeLocale.isPending}
              onClick={() => {
                if (me.locale === locale) return;
                haptic.tick();
                changeLocale.mutate(locale);
              }}
            >
              {LOCALE_LABELS[locale]}
            </button>
          ))}
        </div>
      </div>

      {settings.managerContactUrl ? (
        <Button icon="chat" block onClick={() => openTelegramLink(settings.managerContactUrl)}>
          {t('common.writeManager')}
        </Button>
      ) : null}
      {me.isStaff && (
        <Link to="/admin" className="btn secondary block">
          {t('profile.admin')}
        </Link>
      )}

      <div className="section-title">
        <h2>{t('profile.activity')}</h2>
      </div>
      <div className="card">
        {activity.isPending ? (
          <Skeleton height={120} />
        ) : activity.error ? (
          <ErrorState error={activity.error} onRetry={() => void activity.refetch()} />
        ) : activity.data.items.length === 0 ? (
          <State title={t('profile.emptyTitle')}>{t('profile.emptyText')}</State>
        ) : (
          <ul className="timeline">
            {activity.data.items.map((a) => (
              <li key={a.id}>
                {/* Записи хранятся по-русски; для других языков текст берётся по типу события. */}
                {me.locale === 'ru' ? a.title : (tMaybe(`act.${a.type}`) ?? a.title)}
                <time>{dateTime(a.createdAt)}</time>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
