import type { z } from 'zod';

/** Ожидаемая ошибка с понятным пользователю сообщением. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Требуется вход через Telegram') =>
  new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Недостаточно прав') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Не найдено') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    throw badRequest(
      'VALIDATION',
      `Проверьте данные — ${where}${first?.message ?? 'некорректное значение'}`,
      result.error.issues,
    );
  }
  return result.data;
}

/** Код ошибки PostgreSQL «нарушение уникальности». */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = (err as { cause?: unknown })?.cause ?? err;
  const pgErr = e as { code?: string; constraint?: string };
  return pgErr?.code === '23505' && (!constraint || pgErr.constraint === constraint);
}
