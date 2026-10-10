// Обёртка над Telegram Mini Apps SDK (telegram-web-app.js подключён в index.html).

interface TelegramWebApp {
  initData: string;
  initDataUnsafe: { user?: { id: number; first_name?: string; language_code?: string } };
  platform: string;
  ready(): void;
  expand(): void;
  isVersionAtLeast(version: string): boolean;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  openTelegramLink(url: string): void;
  openLink(url: string): void;
  disableVerticalSwipes?: () => void;
  requestWriteAccess?: (callback?: (granted: boolean) => void) => void;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  HapticFeedback: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(type: 'success' | 'warning' | 'error'): void;
    selectionChanged(): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

const webApp = window.Telegram?.WebApp;

/** Подписанные данные запуска. Пустая строка — приложение открыто не из Telegram. */
export const initData: string = webApp?.initData ?? '';
export const isTelegram = initData !== '';
export const telegramUserId = webApp?.initDataUnsafe?.user?.id ?? null;
/** Язык приложения Telegram у пользователя — для первого экрана, пока профиль не загружен */
export const telegramLanguage = webApp?.initDataUnsafe?.user?.language_code ?? null;

const supports = (version: string) => {
  try {
    return webApp?.isVersionAtLeast(version) ?? false;
  } catch {
    return false;
  }
};

/** Тема одна — тёмная, как на сайте агентства. Красим шапку Telegram в цвет фона. */
function applyTheme() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (isTelegram && supports('6.1') && bg) {
    try {
      webApp!.setHeaderColor(bg);
      webApp!.setBackgroundColor(bg);
    } catch {
      /* старые клиенты Telegram */
    }
  }
}

export function initTelegram() {
  applyTheme();
  if (!webApp) return;
  try {
    webApp.ready();
    webApp.expand();
    // Вертикальный свайп иначе сворачивает приложение во время вращения рулетки.
    if (supports('7.7')) webApp.disableVerticalSwipes?.();
  } catch {
    /* вне Telegram методы могут быть недоступны */
  }
}

export const haptic = {
  tick: () => isTelegram && supports('6.1') && webApp!.HapticFeedback.selectionChanged(),
  impact: (style: 'light' | 'medium' | 'heavy' = 'light') =>
    isTelegram && supports('6.1') && webApp!.HapticFeedback.impactOccurred(style),
  notify: (type: 'success' | 'warning' | 'error') =>
    isTelegram && supports('6.1') && webApp!.HapticFeedback.notificationOccurred(type),
};

/** Открывает ссылку t.me внутри Telegram, а вне его — в новой вкладке. */
export function openTelegramLink(url: string) {
  if (isTelegram && supports('6.1')) webApp!.openTelegramLink(url);
  else window.open(url, '_blank', 'noopener');
}

export function openExternal(url: string) {
  if (isTelegram) webApp!.openLink(url);
  else window.open(url, '_blank', 'noopener');
}

/** Системная кнопка «Назад» в шапке Telegram. Возвращает функцию отписки. */
export function showBackButton(onBack: () => void): () => void {
  if (!isTelegram || !supports('6.1')) return () => {};
  webApp!.BackButton.onClick(onBack);
  webApp!.BackButton.show();
  return () => {
    webApp!.BackButton.offClick(onBack);
    webApp!.BackButton.hide();
  };
}

/**
 * Просит у пользователя разрешение для бота писать ему (диалог показывает Telegram).
 * Нужно тем, кто открыл приложение, не заходя в чат с ботом.
 */
export function requestWriteAccess(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!isTelegram || !supports('6.9') || !webApp!.requestWriteAccess) return resolve(false);
    try {
      webApp!.requestWriteAccess((granted) => resolve(granted));
    } catch {
      resolve(false);
    }
  });
}
