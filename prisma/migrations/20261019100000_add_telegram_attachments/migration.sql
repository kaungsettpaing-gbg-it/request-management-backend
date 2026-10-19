CREATE TABLE "Attachment" (
    "id" SERIAL NOT NULL,
    "requestId" INTEGER NOT NULL,
    "telegramFileId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "publicUrl" TEXT NOT NULL,
    "uploadedById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Attachment_requestId_key" ON "Attachment"("requestId");
CREATE INDEX "Attachment_telegramFileId_idx" ON "Attachment"("telegramFileId");

ALTER TABLE "Attachment"
    ADD CONSTRAINT "Attachment_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "Request"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Attachment"
    ADD CONSTRAINT "Attachment_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
