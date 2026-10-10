import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ApiFailure } from '../api.ts';
import { getLocale, t, tMaybe } from '../i18n.ts';
import { haptic } from '../telegram.ts';
import { Icon } from './icons.tsx';
import type { IconName } from './icons.tsx';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'solid';
  size?: 'md' | 'sm';
  block?: boolean;
  loading?: boolean;
  icon?: IconName;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  block,
  loading,
  icon,
  children,
  className = '',
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={`btn ${variant} ${size === 'sm' ? 'sm' : ''} ${block ? 'block' : ''} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading}
      {...rest}
    >
      {loading ? (
        <span className="spinner" />
      ) : icon ? (
        <Icon name={icon} size={size === 'sm' ? 16 : 20} />
      ) : null}
      {children}
    </button>
  );
}

export function Badge({ tone, children, plain }: { tone: string; children: ReactNode; plain?: boolean }) {
  return <span className={`badge ${tone} ${plain ? 'plain' : ''}`}>{children}</span>;
}

export function Skeleton({ height = 80, width }: { height?: number; width?: number | string }) {
  return <div className="skeleton" style={{ height, width }} />;
}

export function State({
  icon = 'inbox',
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="state">
      <div className="state-icon">
        <Icon name={icon} size={26} />
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** Единое отображение ошибки загрузки с возможностью повторить. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <State
      icon="alert"
      title={t('err.title')}
      action={
        onRetry && (
          <Button size="sm" onClick={onRetry}>
            {t('err.retry')}
          </Button>
        )
      }
    >
      {errorMessage(error)}
    </State>
  );
}

/**
 * Текст ошибки для пользователя. Сервер отвечает по-русски, поэтому для других языков
 * сообщение подбирается по коду ошибки, а если перевода нет — показывается общая фраза.
 */
export function errorMessage(error: unknown): string {
  if (!(error instanceof ApiFailure)) return t('err.generic');
  if (error.isNetwork) return t('err.network');
  const byCode = tMaybe(`err.${error.code}`) ?? tMaybe(`avail.${error.code.replace(/^SPIN_/, '')}`);
  return byCode ?? (getLocale() === 'ru' ? error.message : t('err.generic'));
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sheet ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        {title && <h2 className="display">{title}</h2>}
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Field({
  label,
  hint,
  optional,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>
        {label} {optional && <i>· необязательно</i>}
      </span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        haptic.tick();
        onChange(!checked);
      }}
    />
  );
}

// ── Тосты ────────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  text: string;
  error: boolean;
}
const ToastContext = createContext<(text: string, error?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const push = useCallback((text: string, error = false) => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-2), { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 5000 : 3000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
