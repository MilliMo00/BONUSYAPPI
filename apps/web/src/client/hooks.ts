import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { BonusDto, HomeDto } from '@contract/api.ts';
import { api } from '../api.ts';
import { t } from '../i18n.ts';
import { haptic, openTelegramLink, showBackButton } from '../telegram.ts';
import { errorMessage, useToast } from '../ui/kit.tsx';

/** Сводка для главной; её же используют остальные экраны (настройки, профиль, доступность рулетки). */
export const useHome = (enabled = true) =>
  useQuery({ queryKey: ['home'], queryFn: () => api<HomeDto>('/api/home'), enabled });

/** Системная кнопка «Назад» Telegram на вложенных экранах. */
export function useBackButton(fallback: string) {
  const navigate = useNavigate();
  useEffect(
    () => showBackButton(() => (window.history.length > 1 ? navigate(-1) : navigate(fallback))),
    [navigate, fallback],
  );
}

/** Текст, с которым клиент приходит к менеджеру, — на языке клиента. По номеру бонуса сотрудник проверяет его в админке. */
export const bonusMessage = (bonus: Pick<BonusDto, 'name' | 'code'>) =>
  t('bonus.message', { name: bonus.name, code: bonus.code });

/**
 * «Применить бонус». Сервер фиксирует применение (бонус ждёт активации, повторно применить нельзя)
 * и уведомляет владельца и тимлида; затем открывается чат менеджера с готовым сообщением и номером бонуса.
 * Для бонуса, который уже ждёт активации, кнопка просто снова открывает чат.
 */
export function useApplyBonus() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useHome();
  const [busy, setBusy] = useState(false);

  async function apply(bonus: Pick<BonusDto, 'id' | 'name' | 'code' | 'status'>) {
    if (busy) return;
    haptic.impact('medium');
    if (bonus.status === 'ACTIVE') {
      setBusy(true);
      try {
        await api<BonusDto>(`/api/bonuses/${bonus.id}/apply`, 'POST', {});
      } catch (err) {
        haptic.notify('error');
        toast(errorMessage(err), true);
        void qc.invalidateQueries();
        return;
      } finally {
        setBusy(false);
      }
      void qc.invalidateQueries();
    }
    const url = data?.settings.managerContactUrl;
    if (url)
      openTelegramLink(
        `${url}${url.includes('?') ? '&' : '?'}text=${encodeURIComponent(bonusMessage(bonus))}`,
      );
    else toast(t('bonus.sent'));
  }
  return { apply, busy };
}

export function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Старые WebView без randomUUID: UUID v4 из криптографически стойких байт.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
