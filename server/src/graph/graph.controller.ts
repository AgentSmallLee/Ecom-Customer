// server/src/graph/graph.controller.ts
// POST /api/graph/stream - LangGraph 工作流（SSE，节点轨迹 + token 级流式）
// GET  /api/graph/history - 读取某会话的持久化状态（短期记忆验证/刷新恢复）
import { Body, Controller, Get, Inject, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { GraphService } from './graph.service.ts';
import { AuthGuard } from '../common/auth/auth.guard.ts';
import type { AuthenticatedRequest } from '../common/auth/request.interface.ts';

interface GraphRequestBody {
  message?: string;
  threadId?: string;
}

@Controller('graph')
export class GraphController {
  constructor(
    @Inject(GraphService) private readonly graphService: GraphService
  ) {}

  @Post('stream')
  @UseGuards(AuthGuard)
  async stream(
    @Body() body: GraphRequestBody, // 请求体
    @Req() req: AuthenticatedRequest,// 请求对象，由 AuthGuard 挂载用户信息，确保已认证
    @Res() res: Response, // 响应对象，用于发送 SSE 流式数据
  ): Promise<void> {
    const { message, threadId } = body;
    const userId = req.user.userId;

    if (!message) {
      res.status(400).json({ error: 'message 不能为空' });
      return;
    }

    // 会话标识：前端生成并持久化；缺失时兜底生成（每次请求会是新会话）
    const tid = threadId || randomUUID();

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const send = (type: string, data: Record<string, unknown>) =>
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

    try {
      const stream = this.graphService.stream(message, tid, userId);

      for await (const event of stream) {
        if (event.kind === 'node') {
          // 节点执行轨迹事件
          const { node, state } = event;
          send('node', { node, intent: state?.intent || null });

          if (state?.orderResult?.steps?.length) {
            send('steps', { steps: state.orderResult.steps });
          }

          if (state?.finalAnswer) {
            send('answer', { content: state.finalAnswer });
          }
        } else if (event.kind === 'custom') {
          // custom 流事件（token 等），直接透传 type 字段
          const { type, ...rest } = event.data;
          if (type) {
            send(type as string, rest);
          }
        }
      }

      send('done', {});
      res.end();
    } catch (err) {
      console.error('[Graph Error]', err instanceof Error ? err.message : err);
      send('error', { content: '处理请求时出错，请重试' });
      res.end();
    }
  }

  @Get('history')
  @UseGuards(AuthGuard)
  async history(
    @Query('threadId') threadId: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    if (!threadId) {
      res.status(400).json({ error: 'threadId 不能为空' });
      return;
    }

    try {
      const history = await this.graphService.getHistory(threadId, req.user.userId);
      if (!history) {
        res.json({ messages: [], summary: '' });
        return;
      }
      res.json(history);
    } catch (err) {
      console.error('[Graph History Error]', err instanceof Error ? err.message : err);
      res.status(500).json({ error: '读取会话状态失败' });
    }
  }
}
