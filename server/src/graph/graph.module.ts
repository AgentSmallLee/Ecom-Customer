// server/src/graph/graph.module.ts
import { Module, Inject, type OnApplicationShutdown } from '@nestjs/common';
import { PostgresStore } from '@langchain/langgraph-checkpoint-postgres/store';
import { GraphController } from './graph.controller.ts';
import { GraphService }   from './graph.service.ts';
import { CHECKPOINTER }   from '../common/memory/memory.module.ts';
import { AuthModule }     from '../common/auth/auth.module.ts';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

export const MEMORY_STORE = 'MEMORY_STORE';

/** 由 PG_* 环境变量拼出 PostgresStore 的连接串（该库需要自建连接池） */
const connString = () => {
  const user     = process.env.PG_USER     || 'postgres';
  const password  = process.env.PG_PASSWORD || '';
  const host     = process.env.PG_HOST     || 'localhost';
  const port     = process.env.PG_PORT     || '5432';
  const database = process.env.PG_DATABASE || 'ecom_ai';
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
};

@Module({
  imports:     [AuthModule],
  controllers: [GraphController],
  providers:   [
    // 长期记忆：跨会话用户偏好（自建连接池，应用关闭时需要 stop()）
    {
      provide:    MEMORY_STORE,
      useFactory: async () => {
        const store = await PostgresStore.fromConnString(connString());
        await store.setup(); // 幂等：创建 store / store_vectors 表（依赖 pgvector）
        console.log('[memory] PostgresStore 就绪（长期记忆）');
        return store;
      },
    },
    {
      provide:    GraphService,
      inject:     [CHECKPOINTER, MEMORY_STORE],
      useFactory: (checkpointer: BaseCheckpointSaver, store: PostgresStore) =>
        new GraphService(checkpointer, store),
    },
  ],
  exports: [GraphService],
})
export class GraphModule implements OnApplicationShutdown {
  constructor(@Inject(MEMORY_STORE) private readonly store: PostgresStore) {}

  /** 只关闭 PostgresStore 的独立连接池；PostgresSaver 共享全局 pool，交由进程退出回收 */
  async onApplicationShutdown() {
    await this.store.stop();
  }
}
