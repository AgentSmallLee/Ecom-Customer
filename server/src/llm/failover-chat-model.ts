// src/llm/failover-chat-model.ts
// 带三级降级的 ChatModel：primary → fallback → static fallback
// 继承 BaseChatModel，完全兼容 LangChain 生态（.pipe() / .bindTools() / createAgent()）

import { BaseChatModel, BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models'
import { BaseMessage, AIMessageChunk, HumanMessage } from '@langchain/core/messages'
import { ChatGenerationChunk, ChatResult }         from '@langchain/core/outputs'
import { CallbackManagerForLLMRun }                from '@langchain/core/callbacks/manager'
import { ChatOpenAI }                              from '@langchain/openai'
import type { StructuredToolInterface }            from '@langchain/core/tools'
import { TokenCounterCallback }                    from './token-counter.callback.js'
import type { AuditLogService }                    from './audit-log.service.js'
import { Logger }                                  from '@nestjs/common'

export interface FailoverChatModelOptions {
  /** 主模型配置 */
  primary: {
    model:    string
    apiKey?:  string
    baseURL?: string
  }
  /** 备用模型配置，不传则只有主模型 + 静态兜底两层降级 */
  fallback?: {
    model:    string
    apiKey:   string
    baseURL?: string
  }
  /** 所有模型失败时的静态兜底文案 */
  staticFallback?: string
  /** 单次调用超时（毫秒），默认 30s */
  timeoutMs?: number
  /** 默认温度 */
  temperature?: number
  /** 是否流式 */
  streaming?: boolean
}

/** 全局审计日志引用，所有 FailoverChatModel 实例共享 */
let globalAuditLog: AuditLogService | null = null

/** 设置全局审计日志服务，Nest 启动时调用一次即可 */
export function setGlobalAuditLog(auditLog: AuditLogService | null): void {
  globalAuditLog = auditLog
}

/**
 * 三级降级 ChatModel
 *
 * 非流式：_generate() 内部依次尝试 primary → fallback → static
 * 流式：_streamResponseChunks() 流失败时切换到 fallback 重新流
 *
 * 每次调用结束后自动写审计日志（globalAuditLog 存在时）
 */
export class FailoverChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  private readonly logger = new Logger(FailoverChatModel.name)

  private readonly primaryLlm: ChatOpenAI
  private readonly fallbackLlm: ChatOpenAI | null = null
  private readonly staticFallback: string
  private readonly timeoutMs: number
  private readonly _temperature: number

  /** 已绑定的工具（bindTools 调用后设置） */
  private boundTools: StructuredToolInterface[] = []
  /** 绑定时的额外选项（如 tool_choice） */
  private boundToolOptions: Record<string, any> = {}
  /** 默认审计上下文（当 call options 中没有 source/traceId 时使用） */
  private defaultSource?: string
  private defaultTraceId?: string

  constructor(
    private readonly options: FailoverChatModelOptions,
    boundTools?: StructuredToolInterface[],
    boundToolOptions?: Record<string, any>,
    defaults?: { source?: string; traceId?: string },
  ) {
    super({})

    this._temperature = options.temperature ?? 0.7

    this.primaryLlm = new ChatOpenAI({
      model:         options.primary.model,
      apiKey:        options.primary.apiKey,
      configuration: { baseURL: options.primary.baseURL },
      temperature:   this._temperature,
      streaming:     options.streaming ?? false,
    })

    if (options.fallback?.apiKey) {
      this.fallbackLlm = new ChatOpenAI({
        model:         options.fallback.model,
        apiKey:        options.fallback.apiKey,
        configuration: { baseURL: options.fallback.baseURL },
        temperature:   this._temperature,
        streaming:     options.streaming ?? false,
      })
    }

    this.staticFallback   = options.staticFallback ?? '服务暂时繁忙，请稍后重试。'
    this.timeoutMs        = options.timeoutMs ?? 30_000
    this.boundTools       = boundTools ?? []
    this.boundToolOptions = boundToolOptions ?? {}
    this.defaultSource    = defaults?.source
    this.defaultTraceId   = defaults?.traceId
  }

  /**
   * 绑定工具，返回新的 FailoverChatModel 实例（不可变）
   * 兼容 LangChain 生态的 createAgent / agent 执行节点
   */
  bindTools(tools: StructuredToolInterface[], options?: Record<string, any>): this {
    return new FailoverChatModel(
      this.options,
      tools,
      options ?? {},
      { source: this.defaultSource, traceId: this.defaultTraceId },
    ) as this
  }

  /**
   * 设置默认审计上下文（source / traceId），返回新实例（不可变）
   * 用于 createAgent 等无法直接传递自定义 call option 的场景：
   * 先给模型设置默认值，再把模型传给 createAgent，
   * 这样 agent 内部调用 LLM 时即使不传 source/traceId，也能正确写审计日志。
   */
  withAuditContext(defaults: { source?: string; traceId?: string }): this {
    return new FailoverChatModel(
      this.options,
      this.boundTools,
      this.boundToolOptions,
      { source: defaults.source ?? this.defaultSource, traceId: defaults.traceId ?? this.defaultTraceId },
    ) as this
  }

  _llmType() {
    return 'failover-chat-model'
  }

  /** 便捷方法：传 prompt 字符串，返回回答字符串 */
  async predict(prompt: string, source = 'predict'): Promise<string> {
    const response = await this.invoke([new HumanMessage(prompt)], {
      source,
    } as any)
    return typeof response.content === 'string' ? response.content : ''
  }

  // ── 非流式 ──────────────────────────────────────────
  override async _generate(
    messages:  BaseMessage[],
    options:   this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const { source, traceId } = this.extractMetadata(options)
    const t0                  = Date.now()
    // 第一层：主模型
    const primaryResult = await this.tryGenerate(this.primaryLlm, messages, options, runManager)
    if (primaryResult) {
      this.writeAudit({
        traceId,
        source,
        model:        this.options.primary.model,
        provider:     this.getProvider(this.options.primary.baseURL),
        isFailover:   false,
        status:       'success',
        latencyMs:    Date.now() - t0,
        promptTokens: primaryResult.promptTokens,
        outputTokens: primaryResult.outputTokens,
        totalTokens:  primaryResult.totalTokens,
        messages,
      })
      return primaryResult.result
    }

    // 第二层：备用模型
    if (this.fallbackLlm) {
      this.logger.warn(`[${source}] 主模型失败，切换备用模型`)
      const fallbackResult = await this.tryGenerate(this.fallbackLlm, messages, options, runManager)
      if (fallbackResult) {
        this.writeAudit({
          traceId,
          source,
          model:        this.options.fallback!.model,
          provider:     this.getProvider(this.options.fallback!.baseURL),
          isFailover:   true,
          status:       'success',
          latencyMs:    Date.now() - t0,
          promptTokens: fallbackResult.promptTokens,
          outputTokens: fallbackResult.outputTokens,
          totalTokens:  fallbackResult.totalTokens,
          messages,
        })
        return fallbackResult.result
      }
    }

    // 第三层：静态兜底
    this.logger.error(`[${source}] 所有模型均失败，返回静态兜底`)
    this.writeAudit({
      traceId,
      source,
      model:        'static-fallback',
      provider:     'none',
      isFailover:   true,
      status:       'error',
      latencyMs:    Date.now() - t0,
      errorMessage: '所有模型均不可用，已返回静态兜底',
      messages,
    })

    return {
      generations: [
        {
          text:    this.staticFallback,
          message: new AIMessageChunk({ content: this.staticFallback }),
        },
      ],
      llmOutput: { tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
    }
  }

  // ── 流式 ────────────────────────────────────────────
  override async *_streamResponseChunks(
    messages:  BaseMessage[],
    options:   this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const { source, traceId } = this.extractMetadata(options)
    const t0                  = Date.now()

    // 第一层：主模型流式（边收边发，真正的流式）
    const primaryStats = { promptTokens: 0, outputTokens: 0, totalTokens: 0 }
    try {
      const primaryStream = this.streamChunks(this.primaryLlm, messages, options, runManager)
      const { success, stats } = yield* this.pipeStreamWithStats(primaryStream, primaryStats)

      if (success) {
        this.writeAudit({
          traceId,
          source,
          model:        this.options.primary.model,
          provider:     this.getProvider(this.options.primary.baseURL),
          isFailover:   false,
          status:       'success',
          latencyMs:    Date.now() - t0,
          promptTokens: stats.promptTokens,
          outputTokens: stats.outputTokens,
          totalTokens:  stats.totalTokens,
          messages,
        })
        return
      }
    } catch (e) {
      this.logger.warn(`[${source}] 主模型流式失败: ${e instanceof Error ? e.message : String(e)}`)
    }

    // 第二层：备用模型流式
    if (this.fallbackLlm) {
      this.logger.warn(`[${source}] 主模型流式失败，切换备用模型`)
      try {
        const fallbackStream = this.streamChunks(this.fallbackLlm, messages, options, runManager)
        const fallbackStats = { promptTokens: 0, outputTokens: 0, totalTokens: 0 }
        const { success, stats } = yield* this.pipeStreamWithStats(fallbackStream, fallbackStats)

        if (success) {
          this.writeAudit({
            traceId,
            source,
            model:        this.options.fallback!.model,
            provider:     this.getProvider(this.options.fallback!.baseURL),
            isFailover:   true,
            status:       'success',
            latencyMs:    Date.now() - t0,
            promptTokens: stats.promptTokens,
            outputTokens: stats.outputTokens,
            totalTokens:  stats.totalTokens,
            messages,
          })
          return
        }
      } catch (e) {
        this.logger.warn(`[${source}] 备用模型流式失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // 第三层：静态兜底
    this.logger.error(`[${source}] 所有模型流式均失败，返回静态兜底`)
    this.writeAudit({
      traceId,
      source,
      model:        'static-fallback',
      provider:     'none',
      isFailover:   true,
      status:       'error',
      latencyMs:    Date.now() - t0,
      errorMessage: '所有模型均不可用，已返回静态兜底',
      messages,
    })

    yield new ChatGenerationChunk({
      text:    this.staticFallback,
      message: new AIMessageChunk({ content: this.staticFallback }),
    })
  }

  // ── 内部工具方法 ─────────────────────────────────────

  /**
   * 获取绑定了工具的底层模型实例（如果有绑定的工具）
   * 没有绑定工具时直接返回原模型
   */
  private getBoundLlm(llm: ChatOpenAI): ChatOpenAI {
    if (this.boundTools.length === 0) return llm
    return llm.bindTools(this.boundTools, this.boundToolOptions) as unknown as ChatOpenAI
  }

  /** 尝试用单个模型非流式生成，失败返回 null */
  private async tryGenerate(
    llm:        ChatOpenAI,
    messages:   BaseMessage[],
    options:    this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<{ result: ChatResult; promptTokens: number; outputTokens: number; totalTokens: number } | null> {
    const tokenCounter = new TokenCounterCallback()
    const callOptions: any = {
      ...this.stripAuditFields(options),
      callbacks: [tokenCounter, ...(runManager ? [runManager] : [])],
    }

    // 如果绑定了工具，先绑定再调用
    const boundLlm = this.getBoundLlm(llm)

    try {
      const callPromise    = boundLlm._generate(messages, callOptions, runManager)
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT')), this.timeoutMs)
      )
      const result = await Promise.race([callPromise, timeoutPromise])

      // 内容校验
      const content = result.generations[0]?.text ?? ''
      if (!content.trim()) throw new Error('模型返回空内容')

      return {
        result,
        promptTokens: tokenCounter.promptTokens,
        outputTokens: tokenCounter.outputTokens,
        totalTokens:  tokenCounter.totalTokens,
      }
    } catch (e: any) {
      const isTimeout = e.message === 'TIMEOUT'
      this.logger.warn(
        `模型 ${llm.model} ${isTimeout ? '超时' : '失败'}: ${e.message}`
      )
      return null
    }
  }

  /** 单个模型流式 chunk 生成器 */
  private async *streamChunks(
    llm:        ChatOpenAI,
    messages:   BaseMessage[],
    options:    this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const callOptions: any = {
      ...this.stripAuditFields(options),
      callbacks: runManager ? [runManager] : [],
    }

    // 如果绑定了工具，先绑定再调用
    const boundLlm = this.getBoundLlm(llm)
    const stream = boundLlm._streamResponseChunks(messages, callOptions, runManager)
    for await (const chunk of stream) {
      yield chunk
    }
  }

  /**
   * 边透传 chunk 边统计 token 的生成器委托
   *
   * 用法：const { success, stats } = yield* this.pipeStreamWithStats(gen, statsObj)
   * - 调用方通过 yield* 透传所有 chunk（真正的流式）
   * - 流正常结束时返回 { success: true, stats }
   * - 流出错时抛出异常，由调用方 catch 后切换降级
   */
  private async *pipeStreamWithStats(
    gen: AsyncGenerator<ChatGenerationChunk>,
    stats: { promptTokens: number; outputTokens: number; totalTokens: number },
  ): AsyncGenerator<ChatGenerationChunk, { success: boolean; stats: typeof stats }> {
    let fullText = ''

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT')), this.timeoutMs)
    )

    try {
      const iterator = gen[Symbol.asyncIterator]()
      while (true) {
        const result = await Promise.race([iterator.next(), timeoutPromise])
        if ((result as IteratorResult<any>).done) break
        const chunk = (result as IteratorResult<ChatGenerationChunk>).value

        // 边收边发
        yield chunk
        fullText += chunk.text

        // 从 usage_metadata 累加 token
        const usage = (chunk.message as any).usage_metadata
        if (usage) {
          stats.promptTokens = usage.input_tokens  ?? usage.prompt_tokens     ?? stats.promptTokens
          stats.outputTokens = usage.output_tokens ?? usage.completion_tokens ?? stats.outputTokens
          stats.totalTokens  = usage.total_tokens  ?? (stats.promptTokens + stats.outputTokens)
        }
      }

      if (!fullText.trim()) throw new Error('模型返回空内容')

      return { success: true, stats }
    } catch (e: any) {
      const isTimeout = e.message === 'TIMEOUT'
      this.logger.warn(`流式调用 ${isTimeout ? '超时' : '失败'}: ${e.message}`)
      throw e
    }
  }

  /** 根据 baseURL 推断 provider 名称 */
  private getProvider(baseURL?: string): string {
    if (!baseURL) return 'unknown'
    if (baseURL.includes('deepseek'))  return 'deepseek'
    if (baseURL.includes('volces') || baseURL.includes('ark')) return 'doubao'
    if (baseURL.includes('dashscope') || baseURL.includes('qwen')) return 'qwen'
    if (baseURL.includes('ollama') || baseURL.includes('11434')) return 'ollama'
    if (baseURL.includes('openai'))  return 'openai'
    return 'unknown'
  }

  /** 从 call options 中提取调用上下文（source / traceId） */
  private extractMetadata(options: this['ParsedCallOptions']): { source: string; traceId?: string } {
    const optsAny = options as any
    let source: string | undefined
    let traceId: string | undefined

    // 优先级 1：call options 顶层（调用方直接传，如 chat.service / agent.service）
    source  = source  ?? optsAny.source
    traceId = traceId ?? optsAny.traceId

    // 优先级 2：options.metadata（部分场景下 LangChain 会保留 metadata 在 options 中）
    const meta = optsAny.metadata
    if (meta) {
      source  = source  ?? meta.source
      traceId = traceId ?? meta.traceId
    }

    // 优先级 3：options.configurable（LangGraph 节点通过 configurable 传递的场景）
    const configurable = optsAny.configurable
    if (configurable) {
      source  = source  ?? configurable.source
      traceId = traceId ?? configurable.traceId
    }

    // 优先级 4：默认值（通过 withAuditContext 预设，用于 createAgent 等无法传自定义字段的场景）
    source  = source  ?? this.defaultSource
    traceId = traceId ?? this.defaultTraceId

    return { source: source ?? 'unknown', traceId }
  }

  /**
   * 剥离审计专用字段，避免透传给底层 ChatOpenAI
   * （这些是自定义 call option，不是 OpenAI 认识的参数）
   */
  private stripAuditFields(options: this['ParsedCallOptions']): this['ParsedCallOptions'] {
    const { source, traceId, ...rest } = options as any
    return rest
  }

  /** 写审计日志（异步，不阻塞） */
  private writeAudit(params: {
    traceId?:       string
    source:         string
    model:          string
    provider:       string
    isFailover:     boolean
    status:         'success' | 'error' | 'timeout'
    latencyMs:      number
    promptTokens?:  number
    outputTokens?:  number
    totalTokens?:   number
    errorMessage?:  string
    messages:       BaseMessage[]
  }) {
    if (!globalAuditLog) return

    const promptPreview = params.messages
      .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
      .join('\n')
      .slice(0, 500)

    globalAuditLog.write({
      traceId:       params.traceId,
      source:        params.source,
      model:         params.model,
      provider:      params.provider,
      isFailover:    params.isFailover,
      promptPreview,
      promptTokens:  params.promptTokens,
      outputTokens:  params.outputTokens,
      totalTokens:   params.totalTokens,
      status:        params.status,
      latencyMs:     params.latencyMs,
      errorMessage:  params.errorMessage?.slice(0, 500),
    }).catch(e => {
      this.logger.error('审计日志写入失败', e)
    })
  }
}
