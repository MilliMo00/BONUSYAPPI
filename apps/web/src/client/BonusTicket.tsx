import type { ReactNode } from 'react';
import type { BonusDto } from '@contract/api.ts';
import { bonusValue, date, daysLeft } from '../format.ts';
import { plural, t } from '../i18n.ts';
import { haptic } from '../telegram.ts';
import { useToast } from '../ui/kit.tsx';

export function expiryText(b: Pick<BonusDto, 'expiresAt' | 'status'>): string {
  if (!b.expiresAt) return t('exp.none');
  if (b.status !== 'ACTIVE' && b.status !== 'RESERVED') return t('exp.was', { date: date(b.expiresAt) });
  const left = daysLeft(b.expiresAt)!;
  if (left <= 0) return b.status === 'RESERVED' ? t('exp.pendingExpired') : t('exp.expired');
  if (left <= 7) return t('exp.left', { n: left, days: plural(left, 'day'), date: date(b.expiresAt) });
  return t('exp.until', { date: date(b.expiresAt) });
}

export function BonusTicket({
  bonus,
  currency,
  children,
  copyable = true,
}: {
  bonus: BonusDto;
  currency: string;
  children?: ReactNode;
  /** false — номер показывается текстом (когда сам билет уже является кнопкой) */
  copyable?: boolean;
}) {
  const toast = useToast();
  const open = bonus.status === 'ACTIVE' || bonus.status === 'RESERVED';
  const copyCode = async () => {
    haptic.tick();
    try {
      await navigator.clipboard.writeText(bonus.code);
      toast(t('bonus.copied'));
    } catch {
      toast(`${t('bonus.number')}: ${bonus.code}`);
    }
  };
  return (
    <div className={`ticket ${open ? (bonus.type === 'PRIVILEGE' ? 'cool' : '') : 'used'}`}>
      <div className="shine" />
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div className="stack tight grow">
          <span className="pill">{t(`status.${bonus.status}`)}</span>
          <div className="name" style={{ marginTop: 6 }}>
            {bonus.name}
          </div>
          {bonus.description && <div className="meta">{bonus.description}</div>}
        </div>
        <div className="value">{bonusValue(bonus, currency)}</div>
      </div>
      <div className="dash" />
      <div className="row between wrap">
        <div className="meta">{expiryText(bonus)}</div>
        {copyable ? (
          <button type="button" className="code" onClick={() => void copyCode()} aria-label={t('bonus.copy')}>
            <small>№</small>
            {bonus.code}
          </button>
        ) : (
          <span className="code">
            <small>№</small>
            {bonus.code}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
