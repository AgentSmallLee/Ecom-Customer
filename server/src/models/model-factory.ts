/**
 * 模型工厂（基于 FailoverChatModel，带三级降级）
 *
 * createModel() 返回带降级能力的 ChatModel 实例，
 * 完全兼容 LangChain 生态：.pipe() / .bindTools() / createAgent()
 *
 * 所有调用自动走：主模型 → 备用模型 → 静态兜底
 * 全局审计日志通过 setGlobalAuditLog() 设置（Nest 启动时调用）
 */

import 'dotenv/config';
import { FailoverChatModel } from '../llm/failover-chat-model.js';

interface CreateModelOptions {
  temperature?: number;
  streaming?: boolean;
}

/**
 * 创建带三级降级的模型实例
 * @param options - 可覆盖默认参数，如 { temperature: 0, streaming: true }
 */
export const createModel = (options: CreateModelOptions = {}) => {
  const fallback = process.env.FALLBACK_API_KEY
    ? {
        model:   process.env.FALLBACK_MODEL || '',
        apiKey:  process.env.FALLBACK_API_KEY,
        baseURL: process.env.FALLBACK_BASE_URL || '',
      }
    : undefined;

  return new FailoverChatModel({
    primary: {
      model:   process.env.PRIMARY_MODEL || '',
      apiKey:  process.env.PRIMARY_API_KEY || '',
      baseURL: process.env.PRIMARY_BASE_URL || '',
    },
    fallback,
    temperature: options.temperature ?? 0.7,
    streaming:   options.streaming   ?? false,
    timeoutMs:   30_000,
  });
};

// 默认非流式实例
export const model = createModel();

// 流式实例，用于 SSE 接口
export const streamingModel = createModel({ streaming: true });
