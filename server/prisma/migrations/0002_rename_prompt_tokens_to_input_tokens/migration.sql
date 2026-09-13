-- 将 promptTokens 重命名为 inputTokens
--
-- 注意：这里必须用 RENAME 而不是 DROP + ADD。
-- Prisma 的 migrate diff 会自动生成 "DROP COLUMN promptTokens / ADD COLUMN inputTokens"，
-- 那样会把已有列数据全部清空。RENAME 只改列名，数据完整保留。
ALTER TABLE "llm_audit_logs" RENAME COLUMN "promptTokens" TO "inputTokens";
