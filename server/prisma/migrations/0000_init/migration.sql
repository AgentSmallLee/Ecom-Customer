-- CreateTable
CREATE TABLE "llm_audit_logs" (
    "id" TEXT NOT NULL,
    "traceId" TEXT,
    "source" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "isFailover" BOOLEAN NOT NULL DEFAULT false,
    "promptPreview" TEXT,
    "promptTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "status" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "llm_audit_logs_source_createdAt_idx" ON "llm_audit_logs"("source", "createdAt");

-- CreateIndex
CREATE INDEX "llm_audit_logs_model_createdAt_idx" ON "llm_audit_logs"("model", "createdAt");

-- CreateIndex
CREATE INDEX "llm_audit_logs_status_createdAt_idx" ON "llm_audit_logs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "llm_audit_logs_traceId_idx" ON "llm_audit_logs"("traceId");
