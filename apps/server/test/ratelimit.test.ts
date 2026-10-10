import { afterAll, beforeAll, expect, it } from 'vitest';
import { call, createTestEnv, resetDb, seedPrizes, tma, uuid } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  // Лимиты по умолчанию, как в production.
  env = await createTestEnv({}, {});
  await resetDb(env.db);
  await seedPrizes(env.db);
});
afterAll(() => env.close());

it('частота вращений ограничена для каждого клиента отдельно', async () => {
  const A = tma(1);
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++)
    statuses.push((await call(env.app, 'POST', '/api/roulette/spin', A, { requestId: uuid() })).status);
  expect(statuses.slice(0, 10)).not.toContain(429);
  expect(statuses.slice(10)).toEqual([429, 429]);
  // Другой клиент под лимит первого не попадает.
  expect((await call(env.app, 'POST', '/api/roulette/spin', tma(2), { requestId: uuid() })).status).toBe(200);
});
