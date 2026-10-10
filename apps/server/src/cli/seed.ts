// Стартовый набор призов. Запускается один раз: если призы уже есть, ничего не меняет.
// Это начальная конфигурация рулетки, а не тестовые данные — дальше она правится в админ-панели.
import { createDb } from '../db/client.ts';
import { prizes } from '../db/schema.ts';
import type { PrizeRules } from '../contract/api.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL не задан');
const { db, pool } = createDb(url);

const rules = (terms: string): PrizeRules => ({
  rounding: 'ROUND_UNIT',
  allowedServices: [],
  stackable: false,
  terms,
});
const discountTerms = 'Скидка действует на один следующий заказ и не суммируется с другими акциями.';

const existing = await db.select({ id: prizes.id }).from(prizes).limit(1);
if (existing.length > 0) {
  console.log('Призы уже настроены — пропускаем.');
} else {
  await db.insert(prizes).values([
    {
      name: 'Скидка 5%',
      description: 'Скидка 5% на следующий заказ',
      type: 'PERCENT_DISCOUNT',
      value: '5',
      probability: '35',
      sortOrder: 0,
      rules: rules(discountTerms),
      translations: {
        en: {
          name: '5% discount',
          description: '5% off your next order',
          terms:
            'The discount applies to one order — your next one — and cannot be combined with other offers.',
        },
        uk: {
          name: 'Знижка 5%',
          description: 'Знижка 5% на наступне замовлення',
          terms: 'Знижка діє на одне наступне замовлення і не сумується з іншими акціями.',
        },
      },
    },
    {
      name: 'Заказ вне очереди',
      description: 'Следующий заказ берём в работу вне очереди',
      type: 'PRIVILEGE',
      value: null,
      probability: '25',
      sortOrder: 1,
      rules: rules('Приоритетное выполнение одного следующего заказа.'),
      translations: {
        en: {
          name: 'Priority order',
          description: 'Your next order goes to the front of the queue',
          terms: 'Priority handling for one order — your next one.',
        },
        uk: {
          name: 'Замовлення поза чергою',
          description: 'Наступне замовлення беремо в роботу поза чергою',
          terms: 'Пріоритетне виконання одного наступного замовлення.',
        },
      },
    },
    {
      name: 'Скидка 10%',
      description: 'Скидка 10% на следующий заказ',
      type: 'PERCENT_DISCOUNT',
      value: '10',
      probability: '20',
      sortOrder: 2,
      rules: rules(discountTerms),
      translations: {
        en: {
          name: '10% discount',
          description: '10% off your next order',
          terms:
            'The discount applies to one order — your next one — and cannot be combined with other offers.',
        },
        uk: {
          name: 'Знижка 10%',
          description: 'Знижка 10% на наступне замовлення',
          terms: 'Знижка діє на одне наступне замовлення і не сумується з іншими акціями.',
        },
      },
    },
    {
      name: '20$ на баланс',
      description: '20$ в счёт следующего заказа',
      type: 'FIXED_DISCOUNT',
      value: '20',
      probability: '10',
      sortOrder: 3,
      rules: rules(
        '20$ списываются в счёт одного следующего заказа. Остаток не переносится и не выплачивается.',
      ),
      translations: {
        en: {
          name: '$20 credit',
          description: '$20 towards your next order',
          terms:
            '$20 is deducted from one order — your next one. Any remainder is not carried over or paid out.',
        },
        uk: {
          name: '20$ на баланс',
          description: '20$ у рахунок наступного замовлення',
          terms:
            '20$ списуються в рахунок одного наступного замовлення. Залишок не переноситься і не виплачується.',
        },
      },
    },
    {
      name: 'Скидка 15%',
      description: 'Скидка 15% на следующий заказ',
      type: 'PERCENT_DISCOUNT',
      value: '15',
      probability: '10',
      sortOrder: 4,
      rules: rules(discountTerms),
      translations: {
        en: {
          name: '15% discount',
          description: '15% off your next order',
          terms:
            'The discount applies to one order — your next one — and cannot be combined with other offers.',
        },
        uk: {
          name: 'Знижка 15%',
          description: 'Знижка 15% на наступне замовлення',
          terms: 'Знижка діє на одне наступне замовлення і не сумується з іншими акціями.',
        },
      },
    },
  ]);
  console.log('Стартовый набор призов создан.');
}
await pool.end();
