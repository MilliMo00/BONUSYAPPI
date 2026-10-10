// Создание первого владельца: npm run owner:create -- --telegram-id 123456789 --name "Имя"
import { parseArgs } from 'node:util';
import { createDb } from '../db/client.ts';
import { auditLogs, staff } from '../db/schema.ts';

const { values } = parseArgs({ options: { 'telegram-id': { type: 'string' }, name: { type: 'string' } } });
const telegramId = Number(values['telegram-id']);
const name = values.name?.trim();
if (!Number.isSafeInteger(telegramId) || telegramId <= 0 || !name) {
  console.error('Использование: npm run owner:create -- --telegram-id 123456789 --name "Имя Фамилия"');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL не задан');
const { db, pool } = createDb(url);

await db.transaction(async (tx) => {
  const [owner] = await tx
    .insert(staff)
    .values({ telegramId, displayName: name, role: 'OWNER' })
    .onConflictDoUpdate({
      target: staff.telegramId,
      set: { role: 'OWNER', isActive: true, displayName: name, updatedAt: new Date() },
    })
    .returning();
  await tx.insert(auditLogs).values({
    actorType: 'SYSTEM',
    action: 'staff.create_owner_cli',
    entityType: 'staff',
    entityId: owner!.id,
    details: { telegramId },
  });
  console.log(`Владелец «${owner!.displayName}» (Telegram ID ${telegramId}) создан.`);
});
await pool.end();
