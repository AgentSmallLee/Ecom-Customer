// server/src/common/memory/memory.module.ts
// 共享记忆模块：统一提供 PostgresSaver（短期记忆 checkpointer），
// 供 graph / chat / agent 等多个模块复用，避免重复实例化。
import { Global, Module } from '@nestjs/common';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { pool } from '../../db/postgres.ts';

export const CHECKPOINTER = 'CHECKPOINTER';

/**
 * 全局共享的短期记忆 checkpointer。
 * 标记为 Global，其他模块不用显式 imports 就能注入。
 * 复用全局 pg.Pool，不重复创建连接池。
 */
@Global()
@Module({
  providers: [
    {
      provide:    CHECKPOINTER,
      useFactory: async () => {
        const saver = new PostgresSaver(pool);
        await saver.setup(); // 幂等：checkpoints / checkpoint_blobs / checkpoint_writes
        console.log('[memory] PostgresSaver 就绪（共享短期记忆）');
        return saver;
      },
    },
  ],
  exports: [CHECKPOINTER],
})
export class MemoryModule {}
