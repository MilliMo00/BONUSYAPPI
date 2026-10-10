import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { PrizeDto, PrizeInput } from '@contract/api.ts';
import { PRIZE_TYPES, PRIZE_TYPE_LABELS, ROUNDING_LABELS, ROUNDING_RULES } from '@contract/constants.ts';
import type { PrizeType, RoundingRule } from '@contract/constants.ts';
import { api } from '../api.ts';
import { Icon } from '../ui/icons.tsx';
import { Button, ErrorState, Field, Skeleton, Switch } from '../ui/kit.tsx';
import { PageHead, useAction, useAdmin } from './shared.tsx';

type Draft = PrizeInput & { key: string; open: boolean };

const blank = (sortOrder: number): Draft => ({
  key: crypto.randomUUID(),
  open: true,
  name: '',
  description: '',
  type: 'PERCENT_DISCOUNT',
  value: '10',
  probability: '0',
  isActive: false,
  validityDays: null,
  minOrderAmount: null,
  maxDiscountAmount: null,
  sortOrder,
  rules: { rounding: 'ROUND_UNIT', allowedServices: [], stackable: false, terms: '' },
  translations: {},
});

/** Проценты → сотые доли процента, целым числом: суммируем без ошибок плавающей точки. */
const toBp = (v: string) => (/^\d{1,3}(\.\d{1,2})?$/.test(v.trim()) ? Math.round(Number(v) * 100) : NaN);
const nullable = (v: string) => (v.trim() === '' ? null : v.trim().replace(',', '.'));

export function Prizes() {
  const { settings } = useAdmin();
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ['admin', 'prizes'],
    queryFn: () => api<{ items: PrizeDto[] }>('/api/admin/prizes'),
  });
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (data && !dirty) setDrafts(data.items.map((p) => ({ ...p, key: p.id, open: false })));
  }, [data, dirty]);

  const save = useAction<{ prizes: PrizeInput[] }>('/api/admin/prizes', {
    method: 'PUT',
    success: 'Настройки рулетки сохранены',
    onDone: () => setDirty(false),
  });

  if (isPending) return <Skeleton height={420} />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const update = (key: string, patch: Partial<Draft>) => {
    setDirty(true);
    setDrafts((list) => list.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  };
  const updateRules = (p: Draft, patch: Partial<Draft['rules']>) =>
    update(p.key, { rules: { ...p.rules, ...patch } });

  const active = drafts.filter((p) => p.isActive);
  const sum = active.reduce((acc, p) => acc + toBp(p.probability), 0);
  const problems: string[] = [];
  if (active.length < 2) problems.push('Нужно минимум два активных приза.');
  if (Number.isNaN(sum))
    problems.push('Вероятность — число от 0 до 100, не более двух знаков после запятой.');
  else if (sum !== 10_000)
    problems.push(
      `Сумма вероятностей активных призов — ${(sum / 100).toFixed(2)}%, а должна быть ровно 100%.`,
    );
  if (drafts.some((p) => !p.name.trim())) problems.push('У каждого приза должно быть название.');
  if (drafts.some((p) => p.type !== 'PRIVILEGE' && !(Number(p.value) > 0)))
    problems.push('У скидок должен быть указан размер.');

  return (
    <>
      <PageHead title="Настройки рулетки">
        <span className={`sum-pill ${problems.length ? 'bad' : ''}`}>
          {Number.isNaN(sum) ? '—' : `${(sum / 100).toFixed(2)}%`}
        </span>
        <Button
          variant="primary"
          loading={save.isPending}
          disabled={!dirty || problems.length > 0}
          onClick={() =>
            save.mutate({
              prizes: drafts.map(({ key: _key, open: _open, ...p }, i) => ({ ...p, sortOrder: i })),
            })
          }
        >
          Сохранить
        </Button>
      </PageHead>

      <div className="note" style={{ marginBottom: 14 }}>
        <Icon name="alert" size={18} />
        <span>
          Изменения действуют только на новые вращения. Уже выданные бонусы сохраняют условия, с которыми были
          выиграны. Клиент видит сегменты одинакового размера — вероятности ему не показываются.
        </span>
      </div>
      {dirty && problems.length > 0 && (
        <div className="note warn" style={{ marginBottom: 14 }}>
          <Icon name="alert" size={18} />
          <div>
            {problems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </div>
        </div>
      )}

      <div className="stack">
        {drafts.map((p) => (
          <div className="panel" key={p.key} style={{ opacity: p.isActive ? 1 : 0.72 }}>
            <div className="prize-row">
              <Field label="Название">
                <input
                  className="input"
                  value={p.name}
                  maxLength={60}
                  onChange={(e) => update(p.key, { name: e.target.value })}
                />
              </Field>
              <Field label="Тип">
                <select
                  className="input"
                  value={p.type}
                  onChange={(e) => update(p.key, { type: e.target.value as PrizeType })}
                >
                  {PRIZE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {PRIZE_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label={
                  p.type === 'PERCENT_DISCOUNT'
                    ? 'Скидка, %'
                    : p.type === 'FIXED_DISCOUNT'
                      ? `Скидка, ${settings.currency}`
                      : 'Значение'
                }
              >
                <input
                  className="input"
                  inputMode="decimal"
                  disabled={p.type === 'PRIVILEGE'}
                  value={p.type === 'PRIVILEGE' ? '' : (p.value ?? '')}
                  placeholder={p.type === 'PRIVILEGE' ? '—' : ''}
                  onChange={(e) => update(p.key, { value: nullable(e.target.value) })}
                />
              </Field>
              <Field label="Вероятность, %">
                <input
                  className="input"
                  inputMode="decimal"
                  value={p.probability}
                  onChange={(e) => update(p.key, { probability: e.target.value.replace(',', '.') })}
                />
              </Field>
              <div className="field">
                <span>Активен</span>
                <div style={{ height: 46, display: 'flex', alignItems: 'center' }}>
                  <Switch
                    checked={p.isActive}
                    onChange={(v) => update(p.key, { isActive: v })}
                    label={`Приз ${p.name} активен`}
                  />
                </div>
              </div>
              <div className="row" style={{ height: 46 }}>
                <Button
                  size="sm"
                  onClick={() =>
                    setDrafts((l) => l.map((x) => (x.key === p.key ? { ...x, open: !x.open } : x)))
                  }
                >
                  {p.open ? 'Скрыть' : 'Условия'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  aria-label="Удалить приз"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Убрать приз «${p.name || 'без названия'}» из рулетки? Уже выданные бонусы сохранятся.`,
                      )
                    ) {
                      setDirty(true);
                      setDrafts((l) => l.filter((x) => x.key !== p.key));
                    }
                  }}
                />
              </div>
            </div>
            {p.open && (
              <div className="prize-extra">
                <Field label="Описание для клиента">
                  <input
                    className="input"
                    value={p.description}
                    maxLength={500}
                    onChange={(e) => update(p.key, { description: e.target.value })}
                  />
                </Field>
                <Field
                  label="Срок действия, дней"
                  hint={`Пусто — по умолчанию (${settings.bonusValidityDays ?? 'бессрочно'}), 0 — бессрочно`}
                >
                  <input
                    className="input"
                    inputMode="numeric"
                    value={p.validityDays ?? ''}
                    onChange={(e) =>
                      update(p.key, {
                        validityDays:
                          e.target.value === '' ? null : Number(e.target.value.replace(/\D/g, '')),
                      })
                    }
                  />
                </Field>
                <Field label={`Мин. сумма заказа, ${settings.currency}`} optional>
                  <input
                    className="input"
                    inputMode="decimal"
                    value={p.minOrderAmount ?? ''}
                    onChange={(e) => update(p.key, { minOrderAmount: nullable(e.target.value) })}
                  />
                </Field>
                <Field label={`Макс. сумма скидки, ${settings.currency}`} optional>
                  <input
                    className="input"
                    inputMode="decimal"
                    disabled={p.type === 'PRIVILEGE'}
                    value={p.maxDiscountAmount ?? ''}
                    onChange={(e) => update(p.key, { maxDiscountAmount: nullable(e.target.value) })}
                  />
                </Field>
                <Field label="Округление скидки">
                  <select
                    className="input"
                    disabled={p.type !== 'PERCENT_DISCOUNT'}
                    value={p.rules.rounding}
                    onChange={(e) => updateRules(p, { rounding: e.target.value as RoundingRule })}
                  >
                    {ROUNDING_RULES.map((r) => (
                      <option key={r} value={r}>
                        {ROUNDING_LABELS[r]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Условия использования (текст для клиента)">
                  <textarea
                    className="input"
                    style={{ minHeight: 64 }}
                    value={p.rules.terms}
                    maxLength={1000}
                    onChange={(e) => updateRules(p, { terms: e.target.value })}
                  />
                </Field>
                <div className="field">
                  <span>Допустимые услуги</span>
                  <div className="chips">
                    {settings.services.map((s) => {
                      const on = p.rules.allowedServices.includes(s);
                      return (
                        <button
                          key={s}
                          type="button"
                          className="chip"
                          aria-pressed={on}
                          onClick={() =>
                            updateRules(p, {
                              allowedServices: on
                                ? p.rules.allowedServices.filter((x) => x !== s)
                                : [...p.rules.allowedServices, s],
                            })
                          }
                        >
                          {s}
                        </button>
                      );
                    })}
                  </div>
                  <small>Ничего не выбрано — действует на любые услуги</small>
                </div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={p.rules.stackable}
                    onChange={(e) => updateRules(p, { stackable: e.target.checked })}
                  />
                  <span>
                    Можно совмещать с другими акциями
                    <br />
                    <small className="muted">
                      Информация для клиента и менеджера; к одному заказу всегда применяется один бонус.
                    </small>
                  </span>
                </label>
                {(['en', 'uk'] as const).map((lang) => {
                  const tr = p.translations[lang] ?? { name: '', description: '', terms: '' };
                  const setTr = (patch: Partial<typeof tr>) =>
                    update(p.key, { translations: { ...p.translations, [lang]: { ...tr, ...patch } } });
                  return (
                    <div key={lang} className="stack tight" style={{ gridColumn: '1 / -1' }}>
                      <div className="tiny">
                        {lang === 'en' ? 'English' : 'Українська'} · перевод для клиентов
                      </div>
                      <div className="form-grid">
                        <Field label="Название" hint="Пусто — показывается русское">
                          <input
                            className="input"
                            value={tr.name}
                            maxLength={60}
                            onChange={(e) => setTr({ name: e.target.value })}
                          />
                        </Field>
                        <Field label="Описание">
                          <input
                            className="input"
                            value={tr.description}
                            maxLength={500}
                            onChange={(e) => setTr({ description: e.target.value })}
                          />
                        </Field>
                        <Field label="Условия использования">
                          <input
                            className="input"
                            value={tr.terms}
                            maxLength={1000}
                            onChange={(e) => setTr({ terms: e.target.value })}
                          />
                        </Field>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        <Button
          icon="plus"
          onClick={() => {
            setDirty(true);
            setDrafts((l) => [...l, blank(l.length)]);
          }}
        >
          Добавить приз
        </Button>
      </div>
    </>
  );
}
