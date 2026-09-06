// server/src/rag/rag.module.ts
import { Module } from '@nestjs/common';
import { RagController } from './rag.controller.ts';
import { RagService }    from './rag.service.ts';

@Module({
  controllers: [RagController],
  providers:   [RagService],
})
export class RagModule {}
