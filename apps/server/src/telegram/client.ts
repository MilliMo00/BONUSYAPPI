// Тонкий клиент Telegram Bot API. Используются только нужные методы — без сторонних библиотек.

export class TelegramError extends Error {
  readonly code: number;
  readonly retryAfter?: number;

  constructor(code: number, description: string, retryAfter?: number) {
    super(description);
    this.code = code;
    this.retryAfter = retryAfter;
  }

  /** Повтор бесполезен: бот заблокирован пользователем, чат не найден, некорректный запрос. */
  get permanent(): boolean {
    return this.code === 400 || this.code === 403 || this.code === 401 || this.code === 404;
  }
}

export interface InlineButton {
  text: string;
  url?: string;
  web_app?: { url: string };
  /** Кнопка-действие: нажатие приходит боту как callback_query (до 64 байт) */
  callback_data?: string;
}

export interface SendMessageOptions {
  buttons?: InlineButton[][];
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number; type: string };
    text?: string;
    from?: { id: number; first_name?: string; last_name?: string; username?: string; language_code?: string };
  };
  callback_query?: {
    id: string;
    from: { id: number; first_name?: string; last_name?: string; username?: string; language_code?: string };
    data?: string;
    message?: { message_id: number; chat: { id: number }; text?: string };
  };
}

export interface TelegramClient {
  sendMessage(chatId: string | number, html: string, options?: SendMessageOptions): Promise<void>;
  call<T = unknown>(method: string, body?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  /** Вызов с загрузкой файла (multipart/form-data) */
  upload<T = unknown>(method: string, form: FormData): Promise<T>;
}

export function createTelegramClient(botToken: string, apiBase: string): TelegramClient {
  async function call<T>(method: string, body: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const res = await fetch(`${apiBase}/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => null)) as {
      ok: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    } | null;
    if (!json?.ok) {
      throw new TelegramError(
        json?.error_code ?? res.status,
        json?.description ?? `HTTP ${res.status}`,
        json?.parameters?.retry_after,
      );
    }
    return json.result as T;
  }

  async function upload<T>(method: string, form: FormData): Promise<T> {
    const res = await fetch(`${apiBase}/bot${botToken}/${method}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await res.json().catch(() => null)) as {
      ok: boolean;
      result?: T;
      error_code?: number;
      description?: string;
    } | null;
    if (!json?.ok)
      throw new TelegramError(json?.error_code ?? res.status, json?.description ?? `HTTP ${res.status}`);
    return json.result as T;
  }

  return {
    call,
    upload,
    async sendMessage(chatId, html, options) {
      await call('sendMessage', {
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(options?.buttons ? { reply_markup: { inline_keyboard: options.buttons } } : {}),
      });
    },
  };
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
