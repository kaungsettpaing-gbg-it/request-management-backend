-- CreateEnum
CREATE TYPE "Role" AS ENUM ('STAFF', 'ASSISTANT', 'SUPERVISOR', 'IT_SPECIALIST', 'MANAGER', 'DGM', 'GM', 'ADMIN', 'SUPER_ADMIN', 'USER', 'HR');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "department" TEXT,
    "role" "Role" DEFAULT 'USER',
    "telegramId" TEXT,
    "telegramUsername" TEXT,
    "telegramFirstName" TEXT,
    "otp" TEXT,
    "otpExpiry" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Request" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'General',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "targetDepartment" TEXT DEFAULT 'General',
    "requiresExecutiveApproval" BOOLEAN NOT NULL DEFAULT false,
    "approvalStage" TEXT DEFAULT 'PENDING',
    "currentApprovalStep" INTEGER NOT NULL DEFAULT 0,
    "adminManagerApprovedBy" INTEGER,
    "financeManagerApprovedBy" INTEGER,
    "extraFields" TEXT,
    "attachment" TEXT,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestApprovalStep" (
    "id" SERIAL NOT NULL,
    "requestId" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "stepType" TEXT NOT NULL,
    "department" TEXT,
    "approverRole" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approvedById" INTEGER,
    "remarks" TEXT,
    "actedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestApprovalStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" SERIAL NOT NULL,
    "action" TEXT NOT NULL,
    "remarks" TEXT,
    "userId" INTEGER NOT NULL,
    "requestId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");
CREATE INDEX "Request_status_currentApprovalStep_idx" ON "Request"("status", "currentApprovalStep");
CREATE INDEX "RequestApprovalStep_department_approverRole_status_idx" ON "RequestApprovalStep"("department", "approverRole", "status");
CREATE UNIQUE INDEX "RequestApprovalStep_requestId_sequence_key" ON "RequestApprovalStep"("requestId", "sequence");

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RequestApprovalStep" ADD CONSTRAINT "RequestApprovalStep_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RequestApprovalStep" ADD CONSTRAINT "RequestApprovalStep_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
