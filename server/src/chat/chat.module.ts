// server/src/chat/chat.module.ts
import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller.ts';
import { ChatService }    from './chat.service.ts';
import { AuthModule }     from '../common/auth/auth.module.ts';

@Module({
  imports:     [AuthModule],
  controllers: [ChatController],
  providers:   [ChatService],
})
export class ChatModule {}
