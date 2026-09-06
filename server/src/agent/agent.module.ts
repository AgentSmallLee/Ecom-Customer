// server/src/agent/agent.module.ts
import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller.ts';
import { AgentService }     from './agent.service.ts';

@Module({
  controllers: [AgentController],
  providers:   [AgentService],
})
export class AgentModule {}
