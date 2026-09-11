// src/llm/llm.module.ts

import { Module }           from '@nestjs/common'
import { PrismaModule }     from '../prisma/prisma.module.ts'
import { LlmClientService } from './llm-client.service.ts'
import { AuditLogService }  from './audit-log.service.ts'
import { LlmHealthService } from './llm-health.service.ts'
import { LlmController }    from './llm.controller.ts'

@Module({
  imports:     [PrismaModule],
  controllers: [LlmController],
  providers:   [LlmClientService, AuditLogService, LlmHealthService],
  // exports 让 LanggraphModule 等其他模块能注入 LlmClientService
  exports:     [LlmClientService, AuditLogService, LlmHealthService],
})
  export class LlmModule {}