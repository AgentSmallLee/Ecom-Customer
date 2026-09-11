// server/src/rag/rag.controller.ts
// POST /api/rag/query - 知识库问答（SSE 流式，带参考来源）
import { randomUUID } from 'crypto';
import { Body, Controller, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { RagService } from './rag.service.ts';
import { AuthGuard } from '../common/auth/auth.guard.ts';
import type { AuthenticatedRequest } from '../common/auth/request.interface.ts';

/** RAG SSE 事件 */
type RagSseEvent =
  | { type: 'sources'; sources: { content: string; source: string }[] }
  | { type: 'token'; content: string }
  | { type: 'answer'; content: string }
  | { type: 'done' }
  | { type: 'error'; content: string };

@Controller('rag')
export class RagController {
  constructor(
    @Inject(RagService) private readonly ragService: RagService
  ) {}

  @Post('query')
  @UseGuards(AuthGuard)
  async query(
    @Body() body: { question?: string },
    @Req() _req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const { question } = body;

    if (!question) {
      res.status(400).json({ error: 'question 不能为空' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const send = (type: RagSseEvent['type'], data: Partial<RagSseEvent>) =>
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

    try {
      // traceId：每次请求唯一，关联本次请求内的所有 LLM 调用
      const traceId = randomUUID();
      const stream = this.ragService.stream(question, traceId);
      let fullAnswer = '';
      let sourcesSent = false;

      for await (const chunk of stream) {
        // 并行分支的 sources 在流结束前才会完整输出，遇到就发一次
        if (chunk.sources?.length && !sourcesSent) {
          send('sources', { sources: chunk.sources });
          sourcesSent = true;
        }

        // answer 是流式输出的字符串片段，逐 token 推送
        if (chunk.answer) {
          fullAnswer += chunk.answer;
          send('token', { content: chunk.answer });
        }
      }

      // 流结束，发送完整回答和结束标记
      send('answer', { content: fullAnswer });
      send('done', {});
      res.end();
    } catch (err) {
      console.error('[RAG Error]', err instanceof Error ? err.message : err);
      send('error', { content: '查询出错，请重试' });
      res.end();
    }
  }
}
