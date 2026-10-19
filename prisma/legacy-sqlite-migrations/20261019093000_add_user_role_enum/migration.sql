DO $$
BEGIN
  CREATE TYPE "Role" AS ENUM (
    'STAFF',
    'ASSISTANT',
    'SUPERVISOR',
    'IT_SPECIALIST',
    'MANAGER',
    'DGM',
    'GM',
    'ADMIN',
    'SUPER_ADMIN',
    'USER',
    'HR'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
DECLARE
  invalid_roles TEXT;
BEGIN
  SELECT STRING_AGG(DISTINCT "role", ', ' ORDER BY "role")
  INTO invalid_roles
  FROM "User"
  WHERE "role" IS NOT NULL
    AND "role" NOT IN (
      'STAFF', 'ASSISTANT', 'SUPERVISOR', 'IT_SPECIALIST',
      'MANAGER', 'DGM', 'GM', 'ADMIN', 'SUPER_ADMIN', 'USER', 'HR'
    );

  IF invalid_roles IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot migrate User.role: unsupported existing role value(s): %', invalid_roles;
  END IF;
END $$;

ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User"
  ALTER COLUMN "role" TYPE "Role"
  USING "role"::"Role";
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'USER'::"Role";
