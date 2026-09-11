// src/llm/token-counter.callback.ts

import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { LLMResult }      from '@langchain/core/outputs'

// 注入到 llm.invoke(messages, { callbacks: [tokenCounter] })
// LLM 调用结束后，handleLLMEnd 自动触发，拿到 Token 使用量
export class TokenCounterCallback extends BaseCallbackHandler {
  name = 'TokenCounterCallback'

  promptTokens  = 0
  outputTokens  = 0
  totalTokens   = 0

  async handleLLMEnd(output: LLMResult): Promise<void> {
    // 不同模型返回字段名不一样，兼容处理
    const usage = output.llmOutput?.tokenUsage ?? output.llmOutput?.usage ?? {}

    this.promptTokens = usage.promptTokens     ?? usage.prompt_tokens     ?? 0
    this.outputTokens = usage.completionTokens ?? usage.completion_tokens ?? 0
    this.totalTokens  = usage.totalTokens      ?? usage.total_tokens      ??
      (this.promptTokens + this.outputTokens)
  }
}