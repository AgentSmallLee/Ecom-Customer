// server/src/graph/graph.controller.ts
// POST /api/graph/stream - LangGraph 工作流（SSE，带节点执行轨迹）
import { Body, Controller, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { GraphService } from './graph.service.ts';
import type { ChatMessage } from '../chains/basic-chat.ts';
import type { GraphStateType } from '../graphs/state.ts';

interface GraphRequestBody {
  message?: string;
  history?: ChatMessage[];
}

@Controller('graph')
export class GraphController {
  constructor(
    @Inject(GraphService) private readonly graphService: GraphService
  ) {}

  @Post('stream')
  async stream(@Body() body: GraphRequestBody, @Res() res: Response): Promise<void> {
    const { message, history = [] } = body;

    if (!message) {
      res.status(400).json({ error: 'message 不能为空' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const send = (type: string, data: Record<string, unknown>) =>
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

    try {
      const stream = await this.graphService.stream(message, history);

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
}
