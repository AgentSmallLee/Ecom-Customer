-- AlterTable
ALTER TABLE "llm_audit_logs" ADD COLUMN     "threadId" TEXT,
ADD COLUMN     "userId" TEXT;

-- CreateIndex
CREATE INDEX "llm_audit_logs_userId_createdAt_idx" ON "llm_audit_logs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "llm_audit_logs_threadId_idx" ON "llm_audit_logs"("threadId");
