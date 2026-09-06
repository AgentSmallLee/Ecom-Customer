// server/src/graph/graph.module.ts
import { Module } from '@nestjs/common';
import { GraphController } from './graph.controller.ts';
import { GraphService }     from './graph.service.ts';

@Module({
  controllers: [GraphController],
  providers:   [GraphService],
})
export class GraphModule {}
