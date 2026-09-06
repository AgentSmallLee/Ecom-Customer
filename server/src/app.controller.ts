// server/src/app.controller.ts
// 根路径服务信息接口（与迁移前 GET / 行为一致）
import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  getInfo() {
    return {
      service: '红松心选 AI 客服系统',
      version: '1.0.0',
      routes: {
        chat:  'POST /api/chat/stream',
        agent: 'POST /api/agent/stream',
        rag:   'POST /api/rag/query',
        graph: 'POST /api/graph/stream',
      },
    };
  }
}
