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
