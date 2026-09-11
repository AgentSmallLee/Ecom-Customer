// src/llm/llm.controller.ts

import { Controller, Get, Inject, Query } from '@nestjs/common'
import { AuditLogService }        from './audit-log.service.ts'
import { LlmHealthService }       from './llm-health.service.ts'

@Controller('llm')
export class LlmController {
  constructor(
    @Inject(AuditLogService) private readonly auditLog: AuditLogService,
    @Inject(LlmHealthService) private readonly health: LlmHealthService,
  ) {}

  // GET /api/llm/health
  @Get('health')
  checkHealth() {
    return this.health.checkAll()
  }

  // GET /api/llm/failure-rate?minutes=5
  @Get('failure-rate')
  failureRate(@Query('minutes') minutes?: string) {
    return this.health.failureRate(minutes ? parseInt(minutes) : 5)
  }

  // GET /api/llm/logs?source=xxx&status=xxx&page=1&pageSize=20
  @Get('logs')
  queryLogs(
    @Query('source')    source?:    string,
    @Query('model')     model?:     string,
    @Query('status')    status?:    string,
    @Query('startDate') startDate?: string,
    @Query('endDate')   endDate?:   string,
    @Query('page')      page?:      string,
    @Query('pageSize')  pageSize?:  string,
  ) {
    return this.auditLog.query({
      source, model, status,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate:   endDate   ? new Date(endDate)   : undefined,
      page:      page      ? parseInt(page)      : 1,
      pageSize:  pageSize  ? parseInt(pageSize)  : 20,
    })
  }

  // GET /api/llm/token-stats?days=7
  @Get('token-stats')
  tokenStats(@Query('days') days?: string) {
    return this.auditLog.tokenStats(days ? parseInt(days) : 7)
  }
}