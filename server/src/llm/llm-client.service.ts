// src/llm/llm-client.service.ts

import { Injectable, Logger, Optional } from '@nestjs/common'
import { ChatOpenAI }                        from '@langchain/openai'
import { BaseMessage, HumanMessage }         from '@langchain/core/messages'
import { TokenCounterCallback }              from './token-counter.callback.js'
import { AuditLogService }                   from './audit-log.service.js'
import { estimateCost }                      from './cost-estimator.js'

export interface InvokeOptions {
  source:     string    // 来源接口名，写入审计日志
  traceId?:   string    // 请求链路 ID
  timeoutMs?: number    // 单次调用超时，默认 30000ms
    fallback?:  string    // 所有模型失败时的静态兜底文字
}

export interface InvokeResult {
  content:    string
  model:      string
  provider:   string
  isFailover: boolean   // true 表示触发了降级
  latencyMs:  number
  tokenUsage: { prompt: number; output: number; total: number }
  cost:       { totalCost: number; unit: string }
}

@Injectable()
  export class LlmClientService {
    private readonly logger = new Logger(LlmClientService.name)

    private readonly primaryLlm:  ChatOpenAI
    private readonly fallbackLlm: ChatOpenAI | null = null

    constructor(@Optional() private readonly auditLog: AuditLogService | null = null) {
      // 主模型
      this.primaryLlm = new ChatOpenAI({
        model:         process.env.PRIMARY_MODEL || 'deepseek-v4-flash',
        apiKey:        process.env.PRIMARY_API_KEY || 'ollama',
        configuration: {
          baseURL: process.env.PRIMARY_BASE_URL || 'http://localhost:11434/v1',
        },
        temperature: 0.7,
      })

      // 备用模型，有 API Key 才初始化
      if (process.env.FALLBACK_API_KEY) {
        this.fallbackLlm = new ChatOpenAI({
          model:         process.env.FALLBACK_MODEL || 'deepseek-chat',
          apiKey:        process.env.FALLBACK_API_KEY,
          configuration: { baseURL: process.env.FALLBACK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3' },
          temperature:   0.7,
        })
        this.logger.log(`备用模型已初始化：${process.env.FALLBACK_MODEL || 'deepseek-chat'}`)
      } else {
        this.logger.warn('未配置 FALLBACK_API_KEY，仅有两层降级（主模型 + 静态兜底）')
      }

      this.logger.log(`主模型已初始化：${process.env.PRIMARY_MODEL || 'deepseek-v4-flash'}`)
    }

    /**
     * 便捷方法：输入 prompt 字符串，返回模型回答文本
     * 兼容原 LlmService.predict，给评估、分类等只需纯文本结果的场景用
     */
    async predict(prompt: string, source = 'predict'): Promise<string> {
      const result = await this.invoke([new HumanMessage(prompt)], { source })
      return result.content
    }

    // ── 对外统一调用入口 ─────────────────────────────────
    async invoke(messages: BaseMessage[], options: InvokeOptions): Promise<InvokeResult> {
      const timeoutMs = options.timeoutMs ?? 30_000

      // 第一层：主模型
      const primaryResult = await this.tryInvoke(this.primaryLlm, messages, {
      model:      process.env.PRIMARY_MODEL || 'qwen3.5:0.8b',
      provider:   'ollama',
      isFailover: false,
      timeoutMs,
      ...options,
    })
    if (primaryResult) return primaryResult

    // 第二层：备用模型
    if (this.fallbackLlm) {
      this.logger.warn(`[${options.source}] 主模型失败，切换备用模型`)
      const fallbackResult = await this.tryInvoke(this.fallbackLlm, messages, {
        model:      process.env.FALLBACK_MODEL || 'deepseek-chat',
        provider:   'deepseek',
        isFailover: true,
        timeoutMs,
        ...options,
      })
      if (fallbackResult) return fallbackResult
    }

    // 第三层：静态兜底
    this.logger.error(`[${options.source}] 所有模型均失败，返回静态兜底`)
    const staticContent = options.fallback ?? '服务暂时繁忙，请稍后重试。'

    this.auditLog?.write({
      traceId:      options.traceId,
      source:       options.source,
      model:        'static-fallback',
      provider:     'none',
      isFailover:   true,
      status:       'error',
      latencyMs:    0,
      errorMessage: '所有模型均不可用，已返回静态兜底',
    })

    return {
      content:    staticContent,
      model:      'static-fallback',
      provider:   'none',
      isFailover: true,
      latencyMs:  0,
      tokenUsage: { prompt: 0, output: 0, total: 0 },
      cost:       { totalCost: 0, unit: '元' },
    }
  }

  // ── 内部：尝试调用单个模型，失败返回 null 触发降级 ──
  private async tryInvoke(
    llm:      ChatOpenAI,
    messages: BaseMessage[],
    opts: InvokeOptions & {
      model:      string
      provider:   string
      isFailover: boolean
      timeoutMs:  number
    },
  ): Promise<InvokeResult | null> {
    const t0           = Date.now()
    const tokenCounter = new TokenCounterCallback()

    const promptPreview = messages
      .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
      .join('\n')
      .slice(0, 500)

    try {
      // Promise.race：调用 vs 超时，谁先完成用谁
      const callPromise    = llm.invoke(messages, { callbacks: [tokenCounter] })
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT')), opts.timeoutMs)
      )

      const response  = await Promise.race([callPromise, timeoutPromise])
      const latencyMs = Date.now() - t0
      const content   = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content)

      if (!content?.trim()) throw new Error('模型返回空内容')

      const cost = estimateCost(opts.model, tokenCounter.promptTokens, tokenCounter.outputTokens)

      // 异步写审计日志，不 await 不阻塞返回
      this.auditLog?.write({
        traceId:      opts.traceId,
        source:       opts.source,
        model:        opts.model,
        provider:     opts.provider,
        isFailover:   opts.isFailover,
        promptPreview,
        promptTokens: tokenCounter.promptTokens,
        outputTokens: tokenCounter.outputTokens,
        totalTokens:  tokenCounter.totalTokens,
        status:       'success',
        latencyMs,
      })

      return {
        content,
        model:      opts.model,
        provider:   opts.provider,
        isFailover: opts.isFailover,
        latencyMs,
        tokenUsage: {
          prompt: tokenCounter.promptTokens,
          output: tokenCounter.outputTokens,
          total:  tokenCounter.totalTokens,
        },
        cost,
      }
    } catch (e: any) {
      const latencyMs = Date.now() - t0
      const isTimeout = e.message === 'TIMEOUT'
      const status    = isTimeout ? 'timeout' : 'error'

      this.logger.warn(
        `[${opts.source}] 模型 ${opts.model} ${isTimeout ? '超时' : '失败'}（${latencyMs}ms）: ${e.message}`
      )

      this.auditLog?.write({
        traceId:      opts.traceId,
        source:       opts.source,
        model:        opts.model,
        provider:     opts.provider,
        isFailover:   opts.isFailover,
        promptPreview,
        status,
        latencyMs,
        errorMessage: e.message?.slice(0, 500),
      })

      return null
    }
  }
}