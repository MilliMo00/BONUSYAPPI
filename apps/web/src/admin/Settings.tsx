import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AdminMeDto, AppSettings } from '@contract/api.ts';
import { SPIN_GRANT_TRIGGERS, SPIN_GRANT_TRIGGER_LABELS } from '@contract/constants.ts';
import type { SpinGrantTrigger } from '@contract/constants.ts';
import { Badge, Button, Field } from '../ui/kit.tsx';
import { PageHead, useAction, useAdmin } from './shared.tsx';

const VALIDITY_PRESETS = [7, 14, 30];

export function Settings() {
  const { settings, botUsername } = useAdmin();
  const qc = useQueryClient();
  const [form, setForm] = useState<AppSettings>(settings);
  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const int = (v: string) => Number(v.replace(/\D/g, '') || 0);

  const save = useAction<AppSettings, AppSettings>('/api/admin/settings', {
    method: 'PUT',
    success: 'Настройки сохранены',
    onDone: (next) =>
      qc.setQueryData<AdminMeDto>(['admin', 'me'], (me) => (me ? { ...me, settings: next } : me)),
  });
  const payload: AppSettings = form;
  const customValidity =
    form.bonusValidityDays !== null && !VALIDITY_PRESETS.includes(form.bonusValidityDays);

  return (
    <>
      <PageHead title="Настройки">
        <Button
          variant="primary"
          loading={save.isPending}
          disabled={JSON.stringify(payload) === JSON.stringify(settings)}
          onClick={() => save.mutate(payload)}
        >
          Сохранить
        </Button>
      </PageHead>

      <div className="stack">
        <div className="panel">
          <h3>Программа лояльности</h3>
          <div className="form-grid">
            <Field label="Название в приложении">
              <input
                className="input"
                value={form.brandName}
                maxLength={40}
                onChange={(e) => set('brandName', e.target.value)}
              />
            </Field>
            <Field label="Валюта" hint="Код ISO, например RUB. Действует на новые заказы">
              <input
                className="input"
                value={form.currency}
                maxLength={3}
                onChange={(e) => set('currency', e.target.value.toUpperCase())}
              />
            </Field>
            <Field label="Срок действия бонусов по умолчанию">
              <select
                className="input"
                value={
                  form.bonusValidityDays === null
                    ? 'none'
                    : customValidity
                      ? 'custom'
                      : String(form.bonusValidityDays)
                }
                onChange={(e) =>
                  set(
                    'bonusValidityDays',
                    e.target.value === 'none'
                      ? null
                      : e.target.value === 'custom'
                        ? 60
                        : Number(e.target.value),
                  )
                }
              >
                <option value="none">Без срока действия</option>
                {VALIDITY_PRESETS.map((d) => (
                  <option key={d} value={d}>
                    {d} дней
                  </option>
                ))}
                <option value="custom">Другой срок</option>
              </select>
            </Field>
            {customValidity && (
              <Field label="Срок, дней">
                <input
                  className="input"
                  inputMode="numeric"
                  value={form.bonusValidityDays ?? ''}
                  onChange={(e) => set('bonusValidityDays', Math.max(1, int(e.target.value)))}
                />
              </Field>
            )}
          </div>
        </div>

        <div className="panel">
          <h3>Право на вращение рулетки</h3>
          <div className="form-grid">
            <Field label="Когда клиент получает новое вращение">
              <select
                className="input"
                value={form.spinGrantTrigger}
                onChange={(e) => set('spinGrantTrigger', e.target.value as SpinGrantTrigger)}
              >
                {SPIN_GRANT_TRIGGERS.filter(
                  (t) => t === 'BONUS_ACTIVATED' || t === 'NONE' || t === form.spinGrantTrigger,
                ).map((t) => (
                  <option key={t} value={t}>
                    {SPIN_GRANT_TRIGGER_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Приветственные вращения" hint="Новому клиенту при первом входе; 0 — не выдавать">
              <input
                className="input"
                inputMode="numeric"
                value={form.welcomeSpins}
                onChange={(e) => set('welcomeSpins', Math.min(10, int(e.target.value)))}
              />
            </Field>
            <Field label="Срок действия вращения, дней" hint="Не использовал за это время — вращение сгорает">
              <input
                className="input"
                inputMode="numeric"
                value={form.spinValidityDays}
                onChange={(e) => set('spinValidityDays', Math.max(1, int(e.target.value)))}
              />
            </Field>
            <Field
              label="Напомнить о сгорающем вращении за, дней"
              hint={
                form.spinReminderEnabled
                  ? 'Бот напишет клиенту, что вращение скоро сгорит'
                  : 'Напоминания выключены'
              }
            >
              <input
                className="input"
                inputMode="numeric"
                disabled={!form.spinReminderEnabled}
                value={form.spinReminderDaysBefore}
                onChange={(e) => set('spinReminderDaysBefore', Math.max(1, int(e.target.value)))}
              />
            </Field>
            <Field label="Перерыв между вращениями, часов" hint="0 — без ограничения">
              <input
                className="input"
                inputMode="numeric"
                value={form.spinCooldownHours}
                onChange={(e) => set('spinCooldownHours', int(e.target.value))}
              />
            </Field>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={form.spinReminderEnabled}
              onChange={(e) => set('spinReminderEnabled', e.target.checked)}
            />
            Напоминать клиентам в боте, что их вращение скоро сгорит
          </label>
          <p className="muted small">
            Вращение начисляет владелец или тимлид после заказа клиента — на дашборде, по @username или
            Telegram ID. У клиента может быть одно неиспользованное вращение и один действующий бонус.
          </p>
        </div>

        <div className="panel">
          <h3>Уведомления и связь</h3>
          <div className="form-grid">
            <Field
              label="Ссылка на менеджера"
              optional
              hint="Вида https://t.me/username — сюда клиент попадает по кнопке «Применить бонус»"
            >
              <input
                className="input"
                value={form.managerContactUrl}
                placeholder="https://t.me/"
                onChange={(e) => set('managerContactUrl', e.target.value.trim())}
              />
            </Field>
            <Field
              label="ID рабочего чата"
              optional
              hint="Не обязательно. Заявки на активацию бонуса всегда приходят владельцу и тимлиду лично в бота"
            >
              <input
                className="input"
                value={form.teamChatId}
                placeholder="-100…"
                onChange={(e) => set('teamChatId', e.target.value.trim())}
              />
            </Field>
            <Field label="Напоминать об истечении бонуса за, дней">
              <input
                className="input"
                inputMode="numeric"
                disabled={!form.expiryReminderEnabled}
                value={form.expiryReminderDaysBefore}
                onChange={(e) => set('expiryReminderDaysBefore', Math.max(1, int(e.target.value)))}
              />
            </Field>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={form.expiryReminderEnabled}
              onChange={(e) => set('expiryReminderEnabled', e.target.checked)}
            />
            Напоминать клиентам о скором истечении бонуса
          </label>
        </div>

        <div className="panel">
          <h3>Интеграции</h3>
          <div className="row between wrap">
            <div>
              <b>Telegram-бот</b>
              <div className="muted small">
                {botUsername
                  ? `@${botUsername}`
                  : 'BOT_USERNAME не задан на сервере — вход в админку из браузера отключён'}
              </div>
            </div>
            <Badge tone={botUsername ? 'tone-ok' : 'tone-warn'}>
              {botUsername ? 'Подключён' : 'Настроен частично'}
            </Badge>
          </div>
          <div className="row between wrap">
            <div>
              <b>Google Sheets</b>
              <div className="muted small">
                Синхронизация с таблицами агентства не подключена. Данные можно выгрузить в CSV в разделе
                «Статистика».
              </div>
            </div>
            <Badge tone="tone-mute">Не подключено</Badge>
          </div>
        </div>
      </div>
    </>
  );
}
