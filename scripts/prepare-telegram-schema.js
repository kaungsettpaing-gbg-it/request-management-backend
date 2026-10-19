const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function prepareTelegramSchema() {
  const [table] = await prisma.$queryRaw`SELECT to_regclass('"User"')::text AS name`;
  if (!table.name) {
    return;
  }

  await prisma.$executeRawUnsafe('ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "telegramId" TEXT');
  await prisma.$executeRawUnsafe('ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "telegramUsername" TEXT');
  await prisma.$executeRawUnsafe('ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "telegramFirstName" TEXT');
  await prisma.$executeRawUnsafe(`
    UPDATE "User"
    SET "telegramUsername" = COALESCE("telegramUsername", LOWER(TRIM(BOTH '@' FROM "telegramId"))),
        "telegramId" = NULL
    WHERE "telegramId" IS NOT NULL
      AND "telegramId" !~ '^[0-9]+$'
  `);

  const duplicates = await prisma.$queryRaw`
    SELECT ARRAY_AGG("id" ORDER BY "id") AS user_ids
    FROM "User"
    WHERE "telegramId" IS NOT NULL
    GROUP BY "telegramId"
    HAVING COUNT(*) > 1
    LIMIT 20
  `;
  if (duplicates.length) {
    const userIds = duplicates.map(({ user_ids: ids }) => ids.join(', ')).join('; ');
    throw new Error(
      `Cannot enforce unique Telegram IDs because duplicate IDs are linked to User records: ${userIds}. ` +
      'Resolve these links manually in the database, then redeploy. No user records were deleted.'
    );
  }

  await prisma.$executeRawUnsafe(
    'CREATE UNIQUE INDEX IF NOT EXISTS "User_telegramId_key" ON "User"("telegramId")'
  );
}

prepareTelegramSchema()
  .catch(error => {
    console.error('Unable to prepare Telegram account columns:', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
