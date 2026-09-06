// server/src/chat/chat.controller.ts
// GET  /api/chat/health  - 健康检查
// POST /api/chat        - 普通对话（一次性返回）
// POST /api/chat/stream - 流式对话（SSE）
import { BadRequestException, Body, Controller, Get, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ChatService } from './chat.service.ts';
import type { ChatMessage } from '../chains/basic-chat.ts';

interface ChatRequestBody {
  message?: string;
  history?: ChatMessage[];
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

  // ─── 普通对话接口 ────────────────────────────────────────────────
  @Post()
  async chat(@Body() body: ChatRequestBody) {
    const { message, history = [] } = body;

    if (!message || typeof message !== 'string') {
      throw new BadRequestException({ error: 'message 字段不能为空' });
    }

    try {
      const content = await this.chatService.chat(message, history);
      return { content };
    } catch (error) {
      console.error('[Chat Error]', error instanceof Error ? error.message : error);
      throw new Error('服务暂时不可用，请稍后重试');
    }
  }

  // ─── 流式对话接口（SSE）─────────────────────────────────────────
  @Post('stream')
  async stream(@Body() body: ChatRequestBody, @Res() res: Response): Promise<void> {
    const { message, history = [] } = body;

    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'message 字段不能为空' });
      return;
    }

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
      const stream = await this.chatService.stream(message, history);

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
