// server/src/app.module.ts
import { Module } from '@nestjs/common';
import { AppController }      from './app.controller.ts';
import { ChatModule }         from './chat/chat.module.ts';
import { AgentModule }        from './agent/agent.module.ts';
import { RagModule }          from './rag/rag.module.ts';
import { GraphModule }        from './graph/graph.module.ts';

@Module({
  imports: [ChatModule, AgentModule, RagModule, GraphModule],
  controllers: [AppController],
})
export class AppModule {}
