// src/llm/llm.module.ts

import { Inject, Module, OnModuleInit } from '@nestjs/common'
import { PrismaModule }         from '../prisma/prisma.module.ts'
import { AuditLogService }      from './audit-log.service.ts'
import { LlmHealthService }     from './llm-health.service.ts'
import { LlmController }        from './llm.controller.ts'
import { setGlobalAuditLog }    from './failover-chat-model.ts'

@Module({
  imports:     [PrismaModule],
  controllers: [LlmController],
  providers:   [AuditLogService, LlmHealthService],
  exports:     [AuditLogService, LlmHealthService],
})
export class LlmModule implements OnModuleInit {
  constructor(@Inject(AuditLogService) private readonly auditLog: AuditLogService) {}

  onModuleInit() {
    // Nest 启动时设置全局审计日志，所有 FailoverChatModel 实例共享
    setGlobalAuditLog(this.auditLog)
  }
}
