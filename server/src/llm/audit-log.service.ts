// src/llm/audit-log.service.ts 

import { Inject, Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'

export interface AuditLogPayload {
  traceId?:       string
  userId?:        string
  threadId?:      string
  source:         string
  model:          string
  provider:       string
  isFailover?:    boolean
  promptPreview?: string
    inputTokens?:   number
  outputTokens?:  number
  totalTokens?:   number
    status:         'success' | 'error' | 'timeout'
  latencyMs:      number
  errorMessage?:  string
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name)

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // 写入审计日志（异步，不阻塞主流程）
  async write(payload: AuditLogPayload): Promise<void> {
    try {
      await this.prisma.llmAuditLog.create({ data: payload })
    } catch (e) {
      // 日志写失败不能影响主流程，只打本地 log
      this.logger.error('审计日志写入失败', e)
    }
  }

  // 分页查询调用记录
  async query(params: {
    source?:    string
    model?:     string
    status?:    string
    userId?:    string
    threadId?:  string
    startDate?: Date
    endDate?:   Date
    page?:      number
    pageSize?:  number
  }) {
    const { source, model, status, userId, threadId, startDate, endDate, page = 1, pageSize = 20 } = params
    const where: any = {}

    if (source)   where.source   = source
    if (model)    where.model    = model
    if (status)   where.status   = status
    if (userId)   where.userId   = userId
    if (threadId) where.threadId = threadId
    if (startDate || endDate) {
      where.createdAt = {}
      if (startDate) where.createdAt.gte = startDate
      if (endDate)   where.createdAt.lte = endDate
    }

    const [total, logs] = await Promise.all([
      this.prisma.llmAuditLog.count({ where }),
      this.prisma.llmAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip:    (page - 1) * pageSize,
        take:    pageSize,
      }),
    ])

    return { total, page, pageSize, logs }
  }

  // Token 消耗统计（按日期 + 模型分组）
  async tokenStats(days = 7) {
    const since = new Date()
    since.setDate(since.getDate() - days)

    const result = await this.prisma.$queryRaw<any[]>`
      SELECT
        DATE("createdAt")::text                             AS date,
        "model",
        COUNT(*)::int                                       AS calls,
        SUM("totalTokens")::int                             AS total_tokens,
        SUM("inputTokens")::int                             AS input_tokens,
        SUM("outputTokens")::int                            AS output_tokens,
        ROUND(AVG("latencyMs"))::int                        AS avg_latency_ms,
        COUNT(*) FILTER (WHERE "status" = 'error')::int     AS errors,
        COUNT(*) FILTER (WHERE "status" = 'timeout')::int   AS timeouts
      FROM llm_audit_logs
      WHERE "createdAt" >= ${since}
      GROUP BY DATE("createdAt"), "model"
      ORDER BY date DESC, calls DESC
    `
    return result
  }

  // 近 N 分钟失败率（用于告警判断）
  async failureRate(minutes = 5) {
    const since = new Date(Date.now() - minutes * 60 * 1000)
    const result = await this.prisma.$queryRaw<any[]>`
      SELECT
        "model",
        COUNT(*)::int                                                     AS total,
        COUNT(*) FILTER (WHERE "status" != 'success')::int               AS failures,
        ROUND(
          COUNT(*) FILTER (WHERE "status" != 'success') * 100.0
          / NULLIF(COUNT(*), 0), 2
        )                                                                 AS failure_rate_pct
      FROM llm_audit_logs
      WHERE "createdAt" >= ${since}
      GROUP BY "model"
    `
    return result
  }
}