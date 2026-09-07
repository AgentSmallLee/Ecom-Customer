// server/src/app.controller.ts
import { Controller, Get } from '@nestjs/common';

/**
 * 根路径控制器
 *
 * 处理全局路由前缀 /api 之外的根路径请求。
 * main.ts 中通过 app.setGlobalPrefix('api', { exclude: ['/'] })
 * 将 / 路径排除在 /api 前缀之外，所以这里的路由直接挂载在根路径。
 *
 * 用途：提供服务健康检查与能力发现接口，与迁移前 GET / 行为保持一致，
 * 方便上游调用方或运维工具快速确认服务状态与可用接口。
 */
@Controller()
export class AppController {
  /**
   * 获取服务信息
   * GET /
   *
   * 返回服务名称、版本号以及各业务模块的主要接口路径，
   * 作为服务发现与快速排错的入口。
   */
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
