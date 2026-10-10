import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import type { PublicConfig } from '@contract/api.ts';
import { LOCALES, LOCALE_LABELS, guessLocale } from '@contract/constants.ts';
import type { Locale } from '@contract/constants.ts';
import { api } from '../api.ts';
import { setLocale, t } from '../i18n.ts';
import type { TKey } from '../i18n.ts';
import { isTelegram, requestWriteAccess, telegramLanguage } from '../telegram.ts';
import { Icon } from '../ui/icons.tsx';
import type { IconName } from '../ui/icons.tsx';
import { Button, Sheet, State } from '../ui/kit.tsx';
import { Bonuses } from './Bonuses.tsx';
import { Home } from './Home.tsx';
import { useHome } from './hooks.ts';
import { Profile } from './Profile.tsx';
import { Roulette } from './Roulette.tsx';

const tabs: { to: string; label: TKey; icon: IconName }[] = [
  { to: '/', label: 'nav.home', icon: 'home' },
  { to: '/roulette', label: 'nav.roulette', icon: 'wheel' },
  { to: '/bonuses', label: 'nav.bonuses', icon: 'gift' },
  { to: '/profile', label: 'nav.profile', icon: 'user' },
];

/** Приложение открыто не из Telegram: войти нельзя, честно объясняем, что делать. */
function OutsideTelegram() {
  const { data } = useQuery({ queryKey: ['public'], queryFn: () => api<PublicConfig>('/api/public/config') });
  return (
    <div className="gate">
      <div className="card">
        <div className="avatar" style={{ width: 60, height: 60, borderRadius: 20 }}>
          <Icon name="gift" size={28} />
        </div>
        <h1 className="display" style={{ fontSize: 22 }}>
          {data?.brandName ?? t('gate.title')}
        </h1>
        <p className="muted">{t('gate.text')}</p>
        {data?.botUsername && (
          <a className="btn primary block" href={`https://t.me/${data.botUsername}`}>
            {t('gate.open', { bot: data.botUsername })}
          </a>
        )}
        <a className="muted small" href="/admin">
          {t('gate.staff')}
        </a>
      </div>
    </div>
  );
}

function TabBar() {
  const { data } = useHome();
  return (
    <nav className="tabbar">
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.to === '/'}
          className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}
        >
          {tab.to === '/roulette' && data?.availability.canSpin && <span className="dot" />}
          <Icon name={tab.icon} />
          {t(tab.label)}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * Первый запуск для тех, кто открыл приложение, не заходя в чат с ботом: выбор языка
 * (в чате его спрашивает бот) и разрешение боту присылать уведомления.
 */
function FirstRun() {
  const qc = useQueryClient();
  const { data } = useHome();
  const asked = useRef(false);
  const me = data?.me;

  useEffect(() => {
    if (!me || me.botStarted || !me.localeChosen || asked.current) return;
    asked.current = true;
    void requestWriteAccess().then(async (granted) => {
      if (!granted) return;
      await api('/api/me/bot-access', 'POST', {}).catch(() => {});
      void qc.invalidateQueries({ queryKey: ['home'] });
    });
  }, [me, qc]);

  const choose = useMutation({
    mutationFn: (locale: Locale) => api('/api/me/locale', 'PUT', { locale }),
    onSuccess: () => qc.invalidateQueries(),
  });
  if (!me || me.localeChosen) return null;
  return (
    <Sheet open onClose={() => {}} title="🌐 Выберите язык · Choose language · Оберіть мову">
      <div className="stack" style={{ marginTop: 14 }}>
        {LOCALES.map((locale) => (
          <Button
            key={locale}
            block
            variant={locale === me.locale ? 'primary' : 'secondary'}
            loading={choose.isPending && choose.variables === locale}
            onClick={() => choose.mutate(locale)}
          >
            {LOCALE_LABELS[locale]}
          </Button>
        ))}
      </div>
    </Sheet>
  );
}

export function ClientApp() {
  const home = useHome(isTelegram);
  // Язык — из профиля, а пока он не загружен — по языку приложения Telegram.
  // Выставляется до отрисовки экранов: все они берут тексты из общего словаря.
  setLocale(home.data?.me.locale ?? guessLocale(telegramLanguage ?? navigator.language));
  if (!isTelegram) return <OutsideTelegram />;
  return (
    <div className="app">
      <FirstRun />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/roulette" element={<Roulette />} />
        <Route path="/bonuses" element={<Bonuses />} />
        <Route path="/profile" element={<Profile />} />
        <Route
          path="*"
          element={<State title={t('common.notFoundTitle')}>{t('common.notFoundText')}</State>}
        />
      </Routes>
      <TabBar />
    </div>
  );
}
