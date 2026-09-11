// src/llm/llm-health.service.ts

import { Injectable } from '@nestjs/common'
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
    constructor(private readonly auditLog: AuditLogService) {}

    // 检测单个模型（发一个最小请求，超 5 秒算不可用）
    async checkModel(baseURL: string, apiKey: string, model: string): Promise<HealthStatus> {
      const t0       = Date.now()
      const provider = baseURL.includes('localhost') ? 'ollama' : 'deepseek'

      try {
        const apiBase = baseURL.endsWith('/v1') ? baseURL : `${baseURL}/v1`
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

    // 检测所有已配置的模型
    async checkAll(): Promise<HealthStatus[]> {
      const checks: Promise<HealthStatus>[] = []

      checks.push(this.checkModel(
        process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
        'ollama',
        process.env.PRIMARY_MODEL  || 'qwen3.5:0.8b',
      ))

      if (process.env.DEEPSEEK_API_KEY) {
        checks.push(this.checkModel(
          'https://api.deepseek.com',
          process.env.DEEPSEEK_API_KEY,
          process.env.FALLBACK_MODEL || 'deepseek-chat',
        ))
      }

      return Promise.all(checks)
    }

    async failureRate(minutes = 5) {
      return this.auditLog.failureRate(minutes)
    }
  }