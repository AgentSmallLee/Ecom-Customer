// server/src/rag/rag.module.ts
import { Module } from '@nestjs/common';
import { RagController } from './rag.controller.ts';
import { RagService }    from './rag.service.ts';
import { AuthModule }    from '../common/auth/auth.module.ts';

@Module({
  imports:     [AuthModule],
  controllers: [RagController],
  providers:   [RagService],
})
export class RagModule {}
