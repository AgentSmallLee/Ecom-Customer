// server/src/chat/chat.module.ts
import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller.ts';
import { ChatService }    from './chat.service.ts';

@Module({
  controllers: [ChatController],
  providers:   [ChatService],
})
export class ChatModule {}
