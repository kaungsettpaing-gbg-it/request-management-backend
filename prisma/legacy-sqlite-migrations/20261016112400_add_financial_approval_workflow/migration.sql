ALTER TABLE "Request" ADD COLUMN "adminManagerApprovedBy" INTEGER;
ALTER TABLE "Request" ADD COLUMN "financeManagerApprovedBy" INTEGER;

UPDATE "Request"
SET "status" = 'PENDING_ADMIN_MANAGER',
    "approvalStage" = 'PENDING_ADMIN_MANAGER'
WHERE UPPER("category") IN ('FINANCE', 'FINANCIAL', 'WITHDRAWAL')
  AND "status" = 'PENDING';
