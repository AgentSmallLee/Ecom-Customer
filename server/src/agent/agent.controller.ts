// server/src/agent/agent.controller.ts
// POST /api/agent/stream - Agent 流式对话（SSE，含工具调用步骤）
import { Body, Controller, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AIMessage } from '@langchain/core/messages';
import { AgentService } from './agent.service.ts';
import type { ChatMessage } from '../chains/basic-chat.ts';

interface AgentRequestBody {
  message?: string;
  history?: ChatMessage[];
}

/** Agent SSE 事件 */
type AgentSseEvent =
  | { type: 'step'; tool: string; toolInput: unknown; observation: string }
  | { type: 'answer'; content: unknown }
  | { type: 'done' }
  | { type: 'error'; content: string };

@Controller('agent')
export class AgentController {
  constructor(
    @Inject(AgentService) private readonly agentService: AgentService
  ) {}

  @Post('stream')
  async stream(@Body() body: AgentRequestBody, @Res() res: Response): Promise<void> {
    const { message, history = [] } = body;

    if (!message) {
      res.status(400).json({ error: 'message 不能为空' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const send = (type: AgentSseEvent['type'], data: Partial<AgentSseEvent>) =>
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

    try {
      const result = await this.agentService.invoke(message, history);

      // 从消息列表提取工具调用步骤
      const msgs = result.messages;
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]!;
        if (msg instanceof AIMessage && msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            const toolResult = msgs[i + 1];
            send('step', {
              tool:        tc.name,
              toolInput:   tc.args,
              observation: typeof toolResult?.content === 'string'
                ? toolResult.content
                : JSON.stringify(toolResult?.content ?? ''),
            });
          }
        }
      }

      const finalMsg = msgs[msgs.length - 1]!;
      send('answer', { content: finalMsg.content });
      send('done',   {});
      res.end();
    } catch (err) {
      console.error('[Agent Error]', err instanceof Error ? err.message : err);
      send('error', { content: '处理请求时出错，请重试' });
      res.end();
    }
  }
}
