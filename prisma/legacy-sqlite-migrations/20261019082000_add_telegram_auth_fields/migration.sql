ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "telegramId" TEXT;

ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "telegramUsername" TEXT,
ADD COLUMN IF NOT EXISTS "telegramFirstName" TEXT;

ALTER TABLE "User"
ALTER COLUMN "role" DROP NOT NULL;

UPDATE "User"
SET "telegramUsername" = COALESCE("telegramUsername", LOWER(TRIM(BOTH '@' FROM "telegramId"))),
    "telegramId" = NULL
WHERE "telegramId" IS NOT NULL
  AND "telegramId" !~ '^[0-9]+$';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "User"
    WHERE "telegramId" IS NOT NULL
    GROUP BY "telegramId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate Telegram IDs exist in User; resolve the duplicate links before enforcing uniqueness.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "User_telegramId_key" ON "User"("telegramId");
