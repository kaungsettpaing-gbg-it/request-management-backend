ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "telegramId" TEXT;

ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "telegramUsername" TEXT,
ADD COLUMN IF NOT EXISTS "telegramFirstName" TEXT;

UPDATE "User"
SET "telegramUsername" = LOWER(TRIM(BOTH '@' FROM "telegramId")),
    "telegramId" = NULL
WHERE "telegramId" IS NOT NULL
  AND "telegramId" !~ '^[0-9]+$';

CREATE UNIQUE INDEX IF NOT EXISTS "User_telegramId_key" ON "User"("telegramId");
