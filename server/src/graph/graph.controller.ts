// server/src/graph/graph.controller.ts
// POST /api/graph/stream - LangGraph 工作流（SSE，带节点执行轨迹）
// GET  /api/graph/history - 读取某会话的持久化状态（短期记忆验证/刷新恢复）
import { Body, Controller, Get, Inject, Post, Query, Res } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { GraphService } from './graph.service.ts';
import type { GraphStateType } from '../graphs/state.ts';

interface GraphRequestBody {
  message?: string;
  threadId?: string;
  userId?: string;
}

@Controller('graph')
export class GraphController {
  constructor(
    @Inject(GraphService) private readonly graphService: GraphService
  ) {}

  @Post('stream')
  async stream(@Body() body: GraphRequestBody, @Res() res: Response): Promise<void> {
    const { message, threadId, userId } = body;

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

      for await (const update of stream) {
        const [nodeName, nodeState] =
          Object.entries(update as Record<string, Partial<GraphStateType>>)[0]!;
        if (!nodeName) continue;

        send('node', { node: nodeName, intent: nodeState?.intent || null });

        if (nodeState?.orderResult?.steps?.length) {
          send('steps', { steps: nodeState.orderResult.steps });
        }

        if (nodeState?.finalAnswer) {
          send('answer', { content: nodeState.finalAnswer });
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
  async history(
    @Query('threadId') threadId: string | undefined,
    @Res() res: Response
  ): Promise<void> {
    if (!threadId) {
      res.status(400).json({ error: 'threadId 不能为空' });
      return;
    }

    try {
      const history = await this.graphService.getHistory(threadId);
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
