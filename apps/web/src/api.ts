import type { ApiError } from '@contract/api.ts';
import { t } from './i18n.ts';
import { initData } from './telegram.ts';

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }

  /** Сетевой сбой: запрос можно безопасно повторить с тем же ключом идемпотентности. */
  get isNetwork() {
    return this.status === 0;
  }
}

const authHeaders = (): Record<string, string> => (initData ? { authorization: `tma ${initData}` } : {});

async function request(path: string, method: string, body?: unknown): Promise<Response> {
  try {
    return await fetch(path, {
      method,
      headers: { ...authHeaders(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiFailure(0, 'NETWORK', t('err.network'));
  }
}

export async function api<T>(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' = 'GET',
  body?: unknown,
): Promise<T> {
  const res = await request(path, method, body);
  const json = (await res.json().catch(() => null)) as (T & Partial<ApiError>) | null;
  if (!res.ok || json === null) {
    throw new ApiFailure(res.status, json?.error?.code ?? 'UNKNOWN', json?.error?.message ?? t('err.server'));
  }
  return json;
}

/** Загружает файл телом запроса как есть (без JSON): так сервер получает его без перекодирования. */
export async function apiUpload<T>(path: string, file: Blob): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/octet-stream' },
      body: file,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiFailure(0, 'NETWORK', t('err.network'));
  }
  const json = (await res.json().catch(() => null)) as (T & Partial<ApiError>) | null;
  if (!res.ok || json === null) {
    throw new ApiFailure(res.status, json?.error?.code ?? 'UNKNOWN', json?.error?.message ?? t('err.server'));
  }
  return json;
}

/** Скачивает файл через fetch: внутри Telegram вход идёт заголовком, обычная ссылка его не передаст. */
export async function download(path: string, filename: string): Promise<void> {
  const res = await request(path, 'GET');
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiFailure(
      res.status,
      json?.error?.code ?? 'UNKNOWN',
      json?.error?.message ?? 'Не удалось скачать файл',
    );
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const qs = (params: Record<string, string | number | undefined | null>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};
