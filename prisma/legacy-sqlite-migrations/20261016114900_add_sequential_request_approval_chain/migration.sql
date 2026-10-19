ALTER TABLE "Request" ADD COLUMN "currentApprovalStep" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "RequestApprovalStep" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "requestId" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "stepType" TEXT NOT NULL,
    "department" TEXT,
    "approverRole" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approvedById" INTEGER,
    "remarks" TEXT,
    "actedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RequestApprovalStep_requestId_fkey"
        FOREIGN KEY ("requestId") REFERENCES "Request" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RequestApprovalStep_approvedById_fkey"
        FOREIGN KEY ("approvedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RequestApprovalStep_requestId_sequence_key"
    ON "RequestApprovalStep"("requestId", "sequence");
CREATE INDEX "RequestApprovalStep_department_approverRole_status_idx"
    ON "RequestApprovalStep"("department", "approverRole", "status");
CREATE INDEX "Request_status_currentApprovalStep_idx"
    ON "Request"("status", "currentApprovalStep");

UPDATE "Request"
SET "status" = 'PENDING',
    "currentApprovalStep" = 0,
    "approvalStage" = 'PENDING_' ||
        UPPER(REPLACE(
            REPLACE(COALESCE(NULLIF(TRIM("User"."department"), ''), 'General'), ' & ', '_'),
            ' ', '_'
        )) ||
        '_MANAGER'
FROM "User"
WHERE "Request"."userId" = "User"."id"
  AND "Request"."status" IN ('PENDING', 'PENDING_ADMIN_MANAGER', 'PENDING_FINANCE_MANAGER');

INSERT INTO "RequestApprovalStep"
    ("requestId", "sequence", "stepType", "department", "approverRole", "status")
SELECT "Request"."id", 0, 'DEPARTMENT',
       COALESCE(NULLIF(TRIM("User"."department"), ''), 'General'),
       'MANAGER', 'PENDING'
FROM "Request"
JOIN "User" ON "Request"."userId" = "User"."id"
WHERE "Request"."status" = 'PENDING';

INSERT INTO "RequestApprovalStep"
    ("requestId", "sequence", "stepType", "department", "approverRole", "status")
SELECT "Request"."id", 1, 'DEPARTMENT',
       TRIM("Request"."targetDepartment"), 'MANAGER', 'PENDING'
FROM "Request"
JOIN "User" ON "Request"."userId" = "User"."id"
WHERE "Request"."status" = 'PENDING'
  AND "Request"."targetDepartment" IS NOT NULL
  AND TRIM("Request"."targetDepartment") <> ''
  AND LOWER(TRIM("Request"."targetDepartment")) <> 'general'
  AND LOWER(TRIM("Request"."targetDepartment")) <>
      LOWER(COALESCE(NULLIF(TRIM("User"."department"), ''), 'General'));

INSERT INTO "RequestApprovalStep"
    ("requestId", "sequence", "stepType", "department", "approverRole", "status")
SELECT "Request"."id",
       CASE
           WHEN "Request"."targetDepartment" IS NOT NULL
             AND TRIM("Request"."targetDepartment") <> ''
             AND LOWER(TRIM("Request"."targetDepartment")) <> 'general'
             AND LOWER(TRIM("Request"."targetDepartment")) <>
                 LOWER(COALESCE(NULLIF(TRIM("User"."department"), ''), 'General'))
           THEN 2
           ELSE 1
       END,
       'EXECUTIVE', NULL, 'EXECUTIVE', 'PENDING'
FROM "Request"
JOIN "User" ON "Request"."userId" = "User"."id"
WHERE "Request"."status" = 'PENDING';
