// src/llm/llm-health.service.ts

import { Inject, Injectable } from '@nestjs/common'
import { AuditLogService } from './audit-log.service.js'

export interface HealthStatus {
  model:         string
  provider:      string
  healthy:       boolean
  latencyMs:     number | null
  checkedAt:     string
  errorMessage?: string
}

@Injectable()
export class LlmHealthService {
  constructor(@Inject(AuditLogService) private readonly auditLog: AuditLogService) {}

  // 检测单个模型（发一个最小请求，超 5 秒算不可用）
  async checkModel(baseURL: string, apiKey: string, model: string): Promise<HealthStatus> {
    const t0       = Date.now()
    const provider = this.getProvider(baseURL)

    try {
      // baseURL 已带版本段（/v1、/v3 等）则直接用，否则补 /v1
      const apiBase = /\/v\d+$/.test(baseURL) ? baseURL : `${baseURL}/v1`
      const resp    = await fetch(`${apiBase}/chat/completions`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages:   [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          stream:     false,
        }),
        signal: AbortSignal.timeout(5000),
      })

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)

      return {
        model, provider,
        healthy:   true,
        latencyMs: Date.now() - t0,
        checkedAt: new Date().toISOString(),
      }
    } catch (e: any) {
      return {
        model, provider,
        healthy:      false,
        latencyMs:    null,
        checkedAt:    new Date().toISOString(),
        errorMessage: e.message,
      }
    }
  }

  // 检测所有已配置的模型（与 model-factory.ts 的 PRIMARY_* / FALLBACK_* 配置保持一致）
  async checkAll(): Promise<HealthStatus[]> {
    const checks: Promise<HealthStatus>[] = []

    // 主模型
    if (process.env.PRIMARY_MODEL && process.env.PRIMARY_API_KEY) {
      checks.push(this.checkModel(
        process.env.PRIMARY_BASE_URL || 'https://api.deepseek.com',
        process.env.PRIMARY_API_KEY,
        process.env.PRIMARY_MODEL,
      ))
    }

    // 备用模型
    if (process.env.FALLBACK_MODEL && process.env.FALLBACK_API_KEY) {
      checks.push(this.checkModel(
        process.env.FALLBACK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
        process.env.FALLBACK_API_KEY,
        process.env.FALLBACK_MODEL,
      ))
    }

    return Promise.all(checks)
  }

  // 根据 baseURL 推断 provider（与 failover-chat-model.ts 的 getProvider 一致）
  private getProvider(baseURL: string): string {
    if (baseURL.includes('deepseek'))  return 'deepseek'
    if (baseURL.includes('volces') || baseURL.includes('ark')) return 'doubao'
    if (baseURL.includes('dashscope') || baseURL.includes('qwen')) return 'qwen'
    if (baseURL.includes('ollama') || baseURL.includes('11434')) return 'ollama'
    if (baseURL.includes('openai'))  return 'openai'
    return 'unknown'
  }

  async failureRate(minutes = 5) {
    return this.auditLog.failureRate(minutes)
  }
}