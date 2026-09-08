// server/src/agent/agent.module.ts
import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller.ts';
import { AgentService }     from './agent.service.ts';
import { AuthModule }       from '../common/auth/auth.module.ts';

@Module({
  imports:     [AuthModule],
  controllers: [AgentController],
  providers:   [AgentService],
})
export class AgentModule {}
