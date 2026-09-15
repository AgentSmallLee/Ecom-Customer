// server/src/agent/agent.controller.ts
// GET  /api/agent/history - 获取会话历史（短期记忆，刷新恢复用）
// POST /api/agent/stream - Agent 流式对话（SSE，token 级 + 工具步骤）
import { Body, Controller, Get, Inject, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { AgentService } from './agent.service.ts';
import { AuthGuard } from '../common/auth/auth.guard.ts';
import type { AuthenticatedRequest } from '../common/auth/request.interface.ts';

interface AgentRequestBody {
  message?: string;
  threadId?: string;
}

/** Agent SSE 事件 */
type AgentSseEvent =
  | { type: 'threadId'; threadId: string }
  | { type: 'token'; content: string }
  | { type: 'step'; tool: string; toolInput: unknown; observation: string }
  | { type: 'answer'; content: string }
  | { type: 'done' }
  | { type: 'error'; content: string };

@Controller('agent')
export class AgentController {
  constructor(
    @Inject(AgentService) private readonly agentService: AgentService
  ) {}

  // ─── 获取会话历史 ────────────────────────────────────────────────
  @Get('history')
  @UseGuards(AuthGuard)
  async history(
    @Query('threadId') threadId: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!threadId) return { messages: [] };
    return this.agentService.getHistory(threadId, req.user.userId);
  }

  @Post('stream')
  @UseGuards(AuthGuard)
  async stream(
    @Body() body: AgentRequestBody,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const { message, threadId } = body;
    const userId = req.user.userId;

    if (!message) {
      res.status(400).json({ error: 'message 不能为空' });
      return;
    }

    const tid = threadId || randomUUID();

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const send = (type: AgentSseEvent['type'], data: Partial<AgentSseEvent>) =>
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

    try {
      // 先把 threadId 发给前端
      send('threadId', { threadId: tid });

      const stream = this.agentService.stream(message, tid, userId);

      // 暂存工具调用信息，等 tool_end 时一起发 step 事件
      const pendingTools = new Map<string, { name: string; input: unknown }>();
      let fullAnswer = '';

      for await (const event of stream) {
        switch (event.type) {
          case 'token':
            fullAnswer += event.content;
            send('token', { content: event.content });
            break;

          case 'tool_start':
            pendingTools.set(event.name, { name: event.name, input: event.input });
            break;

          case 'tool_end': {
            // data: {"type":"step","tool":"getOrderInfo",
            // "toolInput":{"orderId":"ORD-001"},
            // "observation":"{\"error\":\"订单 ORD-001 不存在\"}"}
            const pending = pendingTools.get(event.name);
            send('step', {
              tool:        event.name,
              toolInput:   pending?.input ?? {},
              observation: event.observation,
            });
            pendingTools.delete(event.name);
            // 工具执行完后，下一轮 AI 回复从头开始累计
            fullAnswer = '';
            break;
          }
        }
      }

      // 流结束，发最终 answer 和 done
      send('answer', { content: fullAnswer });
      send('done',   {});
      res.end();
    } catch (err) {
      console.error('[Agent Error]', err instanceof Error ? err.message : err);
      send('error', { content: '处理请求时出错，请重试' });
      res.end();
    }
  }
}
