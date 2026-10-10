import '../styles/admin.css';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link, NavLink, Route, Routes } from 'react-router-dom';
import type { AdminMeDto, PublicConfig } from '@contract/api.ts';
import { ROLE_LABELS } from '@contract/constants.ts';
import type { Permission } from '@contract/constants.ts';
import { ApiFailure, api } from '../api.ts';
import { setLocale } from '../i18n.ts';
import { isTelegram, telegramUserId } from '../telegram.ts';
import { Icon } from '../ui/icons.tsx';
import type { IconName } from '../ui/icons.tsx';
import { Button, ErrorState, State, errorMessage, useToast } from '../ui/kit.tsx';
import { Audit } from './Audit.tsx';
import { Bonuses } from './Bonuses.tsx';
import { Broadcast } from './Broadcast.tsx';
import { ClientCard, Clients } from './Clients.tsx';
import { Dashboard } from './Dashboard.tsx';
import { Prizes } from './Prizes.tsx';
import { Settings } from './Settings.tsx';
import { AdminContext } from './shared.tsx';
import { StaffPage } from './Staff.tsx';
import { Stats } from './Stats.tsx';

const nav: { to: string; label: string; icon: IconName; needs?: Permission }[] = [
  { to: '/admin', label: 'Дашборд', icon: 'home' },
  { to: '/admin/bonuses', label: 'Бонусы', icon: 'gift', needs: 'bonuses.view' },
  { to: '/admin/clients', label: 'Клиенты', icon: 'users', needs: 'clients.view' },
  { to: '/admin/roulette', label: 'Рулетка', icon: 'wheel', needs: 'roulette.manage' },
  { to: '/admin/broadcast', label: 'Рассылка', icon: 'chat', needs: 'broadcast.send' },
  { to: '/admin/stats', label: 'Статистика', icon: 'chart', needs: 'stats.view' },
  { to: '/admin/staff', label: 'Сотрудники', icon: 'shield', needs: 'staff.manage' },
  { to: '/admin/settings', label: 'Настройки', icon: 'settings', needs: 'settings.manage' },
  { to: '/admin/audit', label: 'Аудит', icon: 'list', needs: 'audit.view' },
];

/** Вход из обычного браузера через официальный виджет Telegram. Подпись проверяет сервер. */
function Login() {
  const box = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isPending } = useQuery({
    queryKey: ['public'],
    queryFn: () => api<PublicConfig>('/api/public/config'),
  });

  useEffect(() => {
    if (!data?.botUsername || !box.current) return;
    (window as unknown as Record<string, unknown>).onTelegramAuth = async (
      user: Record<string, string | number>,
    ) => {
      try {
        await api('/api/admin/auth/widget', 'POST', user);
        await qc.invalidateQueries({ queryKey: ['admin'] });
      } catch (err) {
        toast(errorMessage(err), true);
      }
    };
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.async = true;
    script.dataset.telegramLogin = data.botUsername;
    script.dataset.size = 'large';
    script.dataset.radius = '12';
    script.dataset.requestAccess = 'write';
    script.dataset.onauth = 'onTelegramAuth(user)';
    box.current.replaceChildren(script);
  }, [data?.botUsername, qc, toast]);

  return (
    <div className="gate">
      <div className="card">
        <div className="avatar" style={{ width: 60, height: 60, borderRadius: 20 }}>
          <Icon name="shield" size={28} />
        </div>
        <h1 className="display" style={{ fontSize: 22 }}>
          Админ-панель
        </h1>
        <p className="muted">
          Доступ только для сотрудников. Войдите через Telegram — права проверяются на сервере.
        </p>
        <div ref={box} style={{ minHeight: 44 }} />
        {!isPending && !data?.botUsername && (
          <p className="muted small">
            Вход из браузера не настроен: на сервере не задан BOT_USERNAME. Откройте админ-панель из
            Telegram-бота.
          </p>
        )}
      </div>
    </div>
  );
}

function NoAccess() {
  return (
    <div className="gate">
      <div className="card">
        <State icon="lock" title="Нет доступа">
          Ваш Telegram-аккаунт не добавлен в список сотрудников. Попросите владельца выдать доступ.
        </State>
        {telegramUserId && (
          <p className="small">
            Ваш Telegram ID: <b className="mono">{telegramUserId}</b>
          </p>
        )}
        <a className="btn secondary" href="/">
          В приложение
        </a>
      </div>
    </div>
  );
}

export default function AdminApp() {
  // Админ-панель всегда на русском, даже если сотрудник пришёл из приложения с другим языком.
  setLocale('ru');
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['admin', 'me'], queryFn: () => api<AdminMeDto>('/api/admin/me') });

  if (me.isPending)
    return (
      <div className="gate">
        <span className="spinner" />
      </div>
    );
  if (me.error) {
    if (me.error instanceof ApiFailure && me.error.status === 401) return <Login />;
    if (me.error instanceof ApiFailure && me.error.status === 403) return <NoAccess />;
    return (
      <div className="gate">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }

  const { staff, settings } = me.data;
  const allowed = new Set(staff.effectivePermissions);
  const guard = (permission: Permission, element: React.ReactNode) =>
    allowed.has(permission) ? (
      element
    ) : (
      <State icon="lock" title="Раздел недоступен">
        У вашей роли нет прав на этот раздел.
      </State>
    );

  return (
    <AdminContext.Provider value={me.data}>
      <div className="admin">
        <aside className="admin-side">
          <div className="admin-brand">
            <i />
            <span>{settings.brandName}</span>
          </div>
          <nav className="admin-nav">
            {nav
              .filter((n) => !n.needs || allowed.has(n.needs))
              .map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.to === '/admin'}
                  className={({ isActive }) => (isActive ? 'active' : '')}
                >
                  <Icon name={n.icon} size={19} />
                  {n.label}
                </NavLink>
              ))}
            {/* Обратно в клиентское приложение — оно доступно только внутри Telegram */}
            {isTelegram && (
              <Link to="/" className="to-app">
                <Icon name="back" size={19} />В приложение
              </Link>
            )}
          </nav>
          <div className="admin-user stack tight">
            <b className="truncate">{staff.displayName}</b>
            <span className="muted">{ROLE_LABELS[staff.role]}</span>
            {!isTelegram && (
              <Button
                size="sm"
                variant="ghost"
                icon="logout"
                onClick={async () => {
                  await api('/api/admin/auth/logout', 'POST', {});
                  qc.clear();
                  window.location.reload();
                }}
              >
                Выйти
              </Button>
            )}
          </div>
        </aside>
        <main className="admin-main">
          <Routes>
            <Route index element={<Dashboard />} />
            <Route path="clients" element={guard('clients.view', <Clients />)} />
            <Route path="clients/:id" element={guard('clients.view', <ClientCard />)} />
            <Route path="bonuses" element={guard('bonuses.view', <Bonuses />)} />
            <Route path="roulette" element={guard('roulette.manage', <Prizes />)} />
            <Route path="broadcast" element={guard('broadcast.send', <Broadcast />)} />
            <Route path="stats" element={guard('stats.view', <Stats />)} />
            <Route path="staff" element={guard('staff.manage', <StaffPage />)} />
            <Route path="settings" element={guard('settings.manage', <Settings />)} />
            <Route path="audit" element={guard('audit.view', <Audit />)} />
            <Route path="*" element={<State title="Страница не найдена" />} />
          </Routes>
        </main>
      </div>
    </AdminContext.Provider>
  );
}
