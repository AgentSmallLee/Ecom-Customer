// client/src/types.ts
// 前后端共享的数据契约类型

/** 基础消息 */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Agent 工具调用步骤 */
export interface ToolStep {
  tool: string;
  toolInput?: Record<string, unknown>;
  input?: Record<string, unknown>;
  observation?: string;
}

/** RAG 参考来源 */
export interface SourceInfo {
  content: string;
  source: string;
}

// ─────────────────────────────────────────────────────────
// LLM 监控台（GET /api/llm/*）
// ─────────────────────────────────────────────────────────

/** 模型健康状态（GET /api/llm/health） */
export interface LlmHealthStatus {
  model: string;
  provider: string;
  role: 'primary' | 'fallback';
  healthy: boolean;
  latencyMs: number | null;
  checkedAt: string;
  errorMessage?: string;
}

/** 模型失败率（GET /api/llm/failure-rate） */
export interface LlmFailureRate {
  model: string;
  total: number;
  failures: number;
  failure_rate_pct: number | null;
}

/** 单条 LLM 调用审计日志（对应后端 LlmAuditLog / llm_audit_logs 表） */
export interface LlmAuditLog {
  id: string;
  traceId: string | null;
  userId: string | null;
  threadId: string | null;
  source: string;
  model: string;
  provider: string;
  isFailover: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  latencyMs: number;
  status: 'success' | 'error' | 'timeout';
  errorMessage: string | null;
  promptPreview: string | null;
  createdAt: string;
}

/** 审计日志分页返回（GET /api/llm/logs） */
export interface LlmAuditLogPage {
  total: number;
  page: number;
  pageSize: number;
  logs: LlmAuditLog[];
}

/** Token 用量统计（GET /api/llm/token-stats，字段名与后端聚合 SQL 别名一致） */
export interface LlmTokenStat {
  date: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  avg_latency_ms: number | null;
  errors: number;
  timeouts: number;
}
