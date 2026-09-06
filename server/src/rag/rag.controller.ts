// server/src/rag/rag.controller.ts
// POST /api/rag/query - 知识库问答（SSE，带参考来源）
import { Body, Controller, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RagService } from './rag.service.ts';

@Controller('rag')
export class RagController {
  constructor(
    @Inject(RagService) private readonly ragService: RagService
  ) {}

  @Post('query')
  async query(
    @Body() body: { question?: string },
    @Res() res: Response
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

    const send = (type: string, data: Record<string, unknown>) =>
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

    try {
      const result = await this.ragService.query(question);

      if (result.sources?.length) {
        send('sources', { sources: result.sources });
      }

      send('answer', { content: result.answer });
      send('done', {});
      res.end();
    } catch (err) {
      console.error('[RAG Error]', err instanceof Error ? err.message : err);
      send('error', { content: '查询出错，请重试' });
      res.end();
    }
  }
}
