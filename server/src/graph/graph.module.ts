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
    // ── Provider 1：长期记忆存储（PostgresStore） ──
    // 注册一个名为 MEMORY_STORE 的自定义 Provider，用工厂函数异步创建实例
    {
      provide:    MEMORY_STORE,          // 注入令牌：其他地方用 @Inject(MEMORY_STORE) 获取
      useFactory: async () => {          // 工厂函数：Nest 启动时调用，返回值作为单例注入
        const store = await PostgresStore.fromConnString(connString()); // 用连接串创建 PG 存储实例
        await store.setup();             // 幂等初始化：建表 store / store_vectors（依赖 pgvector 扩展）
        console.log('[memory] PostgresStore 就绪（长期记忆）');
        return store;                    // 返回实例，供 DI 容器作为单例复用
      },
    },
    // ── Provider 2：图服务（GraphService） ──
    // 工厂模式手动注入两个依赖，显式控制构造顺序
    {
      provide:    GraphService,          // 注入令牌：类本身作为 Token（常规类 Provider 的写法）
      inject:     [CHECKPOINTER, MEMORY_STORE], // 声明依赖：按顺序注入这两个 Provider
      useFactory: (checkpointer: BaseCheckpointSaver, store: PostgresStore) =>
        new GraphService(checkpointer, store),  // 工厂函数：拿到依赖后手动 new 实例
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
