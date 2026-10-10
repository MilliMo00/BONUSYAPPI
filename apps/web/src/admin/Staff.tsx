import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { StaffDto } from '@contract/api.ts';
import { PERMISSIONS, PERMISSION_LABELS, ROLES, ROLE_LABELS, ROLE_PERMISSIONS } from '@contract/constants.ts';
import type { Permission, Role } from '@contract/constants.ts';
import { api } from '../api.ts';
import { shortDate } from '../format.ts';
import { Badge, Button, ErrorState, Field, Sheet, Skeleton } from '../ui/kit.tsx';
import { PageHead, useAction, useAdmin } from './shared.tsx';

interface Form {
  id: string | null;
  telegramId: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  enabled: Set<Permission>;
}

const fromStaff = (s: StaffDto): Form => ({
  id: s.id,
  telegramId: String(s.telegramId),
  displayName: s.displayName,
  role: s.role,
  isActive: s.isActive,
  enabled: new Set(s.effectivePermissions),
});
const empty = (): Form => ({
  id: null,
  telegramId: '',
  displayName: '',
  role: 'MANAGER',
  isActive: true,
  enabled: new Set(ROLE_PERMISSIONS.MANAGER),
});

/** Права, которые имеют смысл в текущей версии: приложение не принимает заказы, поэтому права на заказы скрыты. */
const VISIBLE_PERMISSIONS: Permission[] = [
  'clients.view',
  'clients.manage',
  'spins.grant',
  'bonuses.view',
  'bonuses.redeem',
  'bonuses.release',
  'bonuses.grant',
  'bonuses.cancel',
  'bonuses.correct',
  'stats.view',
  'reports.export',
  'roulette.manage',
  'broadcast.send',
  'settings.manage',
  'staff.manage',
  'audit.view',
];

/** Отличия выбранных прав от прав роли по умолчанию. */
function overrides(form: Form) {
  const defaults = new Set(ROLE_PERMISSIONS[form.role]);
  return {
    grant: PERMISSIONS.filter((p) => form.enabled.has(p) && !defaults.has(p)),
    revoke: PERMISSIONS.filter((p) => !form.enabled.has(p) && defaults.has(p)),
  };
}

export function StaffPage() {
  const me = useAdmin();
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ['admin', 'staff'],
    queryFn: () => api<{ items: StaffDto[] }>('/api/admin/staff'),
  });
  const [form, setForm] = useState<Form | null>(null);
  const close = () => setForm(null);
  const create = useAction<object>('/api/admin/staff', { success: 'Сотрудник добавлен', onDone: close });
  const update = useAction<object>(() => `/api/admin/staff/${form?.id}`, {
    method: 'PATCH',
    success: 'Изменения сохранены',
    onDone: close,
  });

  if (isPending) return <Skeleton height={320} />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const submit = () => {
    if (!form) return;
    const permissions = overrides(form);
    if (form.id)
      update.mutate({ displayName: form.displayName, role: form.role, isActive: form.isActive, permissions });
    else
      create.mutate({
        telegramId: Number(form.telegramId),
        displayName: form.displayName,
        role: form.role,
        permissions,
      });
  };
  const valid = form && form.displayName.trim() && (form.id || /^\d{4,16}$/.test(form.telegramId));

  return (
    <>
      <PageHead title="Сотрудники">
        <Button variant="solid" icon="plus" onClick={() => setForm(empty())}>
          Добавить
        </Button>
      </PageHead>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Сотрудник</th>
              <th>Telegram ID</th>
              <th>Роль</th>
              <th>Особые права</th>
              <th>Добавлен</th>
              <th>Доступ</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((s) => (
              <tr key={s.id} className="clickable" onClick={() => setForm(fromStaff(s))}>
                <td>
                  <b>{s.displayName}</b>
                  {s.id === me.staff.id && <span className="muted"> · это вы</span>}
                </td>
                <td className="mono muted">{s.telegramId}</td>
                <td>{ROLE_LABELS[s.role]}</td>
                <td className="muted">
                  {s.permissions.grant.length + s.permissions.revoke.length === 0
                    ? '—'
                    : [
                        s.permissions.grant.length && `+${s.permissions.grant.length}`,
                        s.permissions.revoke.length && `−${s.permissions.revoke.length}`,
                      ]
                        .filter(Boolean)
                        .join(' / ')}
                </td>
                <td className="muted">{shortDate(s.createdAt)}</td>
                <td>
                  <Badge tone={s.isActive ? 'tone-ok' : 'tone-mute'}>
                    {s.isActive ? 'Активен' : 'Отозван'}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ marginTop: 12 }}>
        Сотрудник определяется по Telegram ID — username и знание адреса админки доступа не дают. Узнать свой
        ID можно в приложении: Профиль → Telegram ID. Чтобы получать уведомления лично, сотрудник должен один
        раз нажать /start в боте.
      </p>

      <Sheet open={form !== null} onClose={close} title={form?.id ? 'Сотрудник' : 'Новый сотрудник'} wide>
        {form && (
          <div className="stack" style={{ marginTop: 12 }}>
            <div className="form-grid">
              <Field label="Имя">
                <input
                  className="input"
                  value={form.displayName}
                  maxLength={120}
                  onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                />
              </Field>
              <Field
                label="Telegram ID"
                hint={form.id ? 'Изменить нельзя — добавьте нового сотрудника' : 'Только цифры'}
              >
                <input
                  className="input"
                  inputMode="numeric"
                  disabled={form.id !== null}
                  value={form.telegramId}
                  onChange={(e) => setForm({ ...form, telegramId: e.target.value.replace(/\D/g, '') })}
                />
              </Field>
              <Field label="Роль">
                <select
                  className="input"
                  value={form.role}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      role: e.target.value as Role,
                      enabled: new Set(ROLE_PERMISSIONS[e.target.value as Role]),
                    })
                  }
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div>
              <div className="tiny" style={{ marginBottom: 10 }}>
                Права · отмечены права роли, их можно расширить или сузить
              </div>
              <div className="perm-grid">
                {VISIBLE_PERMISSIONS.map((p) => (
                  <label key={p} className="check">
                    <input
                      type="checkbox"
                      checked={form.enabled.has(p)}
                      onChange={(e) => {
                        const enabled = new Set(form.enabled);
                        if (e.target.checked) enabled.add(p);
                        else enabled.delete(p);
                        setForm({ ...form, enabled });
                      }}
                    />
                    {PERMISSION_LABELS[p]}
                  </label>
                ))}
              </div>
            </div>
            {form.id && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                />
                <span>
                  Доступ активен
                  <br />
                  <small className="muted">
                    Снятие отметки отзывает доступ сразу, история действий сохраняется.
                  </small>
                </span>
              </label>
            )}
            <div className="row">
              <Button className="grow" onClick={close}>
                Отмена
              </Button>
              <Button
                className="grow"
                variant="solid"
                disabled={!valid}
                loading={create.isPending || update.isPending}
                onClick={submit}
              >
                Сохранить
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </>
  );
}
