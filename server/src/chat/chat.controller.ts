// server/src/chat/chat.controller.ts
// GET  /api/chat/health  - 健康检查
// GET  /api/chat/history - 获取会话历史（短期记忆，刷新恢复用）
// POST /api/chat        - 普通对话（一次性返回）
// POST /api/chat/stream - 流式对话（SSE）
import { BadRequestException, Body, Controller, Get, Inject, Post, Query, Res } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { ChatService } from './chat.service.ts';

interface ChatRequestBody {
  message?: string;
  threadId?: string;
}

@Controller('chat')
export class ChatController {
  constructor(
    @Inject(ChatService) private readonly chatService: ChatService
  ) {}

  // ─── 健康检查 ────────────────────────────────────────────────────
  @Get('health')
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  // ─── 获取会话历史 ────────────────────────────────────────────────
  @Get('history')
  async history(@Query('threadId') threadId: string | undefined) {
    if (!threadId) {
      // threadId 为undefined或者空字符串时，返回空数组
      return { messages: [] };
    }
    const messages = await this.chatService.getHistory(threadId);
    return { messages };
  }

  // ─── 普通对话接口 ────────────────────────────────────────────────
  @Post()
  async chat(@Body() body: ChatRequestBody) {
    const { message, threadId } = body;

    if (!message || typeof message !== 'string') {
      throw new BadRequestException({ error: 'message 字段不能为空' });
    }

    // 没传 threadId 就生成一个新的（每次请求都是新会话）
    const tid = threadId || randomUUID();

    try {
      const content = await this.chatService.chat(message, tid);
      return { content, threadId: tid };
    } catch (error) {
      console.error('[Chat Error]', error instanceof Error ? error.message : error);
      throw new Error('服务暂时不可用，请稍后重试');
    }
  }

  // ─── 流式对话接口（SSE）─────────────────────────────────────────
  @Post('stream')
  async stream(@Body() body: ChatRequestBody, @Res() res: Response): Promise<void> {
    const { message, threadId } = body;

    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'message 字段不能为空' });
      return;
    }

    const tid = threadId || randomUUID();

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // 禁用 Nginx 缓冲

    // 发送 SSE 数据的工具函数
    const sendData = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const stream = this.chatService.stream(message, tid);

      // 先把 threadId 发给前端
      sendData({ threadId: tid });

      // 逐块发送给前端
      for await (const chunk of stream) {
        if (chunk) {
          sendData({ content: chunk });
        }
      }

      // 发送结束标记
      sendData({ done: true });
      res.end();
    } catch (error) {
      console.error('[Stream Error]', error instanceof Error ? error.message : error);
      sendData({ error: '生成回复时出错，请重试' });
      res.end();
    }
  }
}
