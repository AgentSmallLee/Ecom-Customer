// src/llm/trace-context.ts
// 调用链路追踪上下文：审计日志（llm_audit_logs）与 LangSmith 共用同一份标识
//
// 为什么要同时放顶层和 metadata：
// - 顶层 source / traceId / userId / threadId：FailoverChatModel.extractMetadata 直接读顶层，用于写审计日志
// - metadata：LangSmith 只认 config.metadata（不认自定义顶层键），用于按用户/会话筛选 trace
// - runName：让 LangSmith 里的 run 名称与审计日志的 source 字段一致，两边可互查
//
// 三者必须保持同步，所以统一由本函数生成，避免各调用点各写各的造成漂移。

export interface TraceIds {
  traceId?:  string;
  userId?:   string;
  threadId?: string;
}

export interface TraceConfig {
  source:    string;
  traceId?:  string;
  userId?:   string;
  threadId?: string;
  runName:   string;
  metadata:  {
    source:    string;
    traceId?:  string;
    userId?:   string;
    threadId?: string;
  };
}

/**
 * 构建调用链路追踪配置
 * @param source - 调用来源标识，同时作为审计日志的 source 和 LangSmith 的 runName
 * @param ids - traceId / userId / threadId（同一次用户请求内共享）
 */
export function buildTraceConfig(source: string, ids: TraceIds = {}): TraceConfig {
  const { traceId, userId, threadId } = ids;
  return {
    // 自定义的顶层键，LangChain 不认识，不报错，用于审计日志写入
    source,
    traceId,
    userId,
    threadId,
    // runName和metadata是LangChain官方标准字段，BaseCallbackConfig
    runName: source,
    metadata: { source, traceId, userId, threadId },
  };
}
