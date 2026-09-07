// server/src/graph/graph.service.ts
// LangGraph 工作流服务：持有编译后的图单例（DI 生命周期管理）
import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { BaseStore }           from '@langchain/langgraph-checkpoint';
import { buildCustomerGraph }       from '../graphs/customer-graph.ts';

export interface PersistedHistory {
  messages: { role: 'user' | 'assistant'; content: string }[];
  summary:  string;
}

export class GraphService {
  private graph: ReturnType<typeof buildCustomerGraph> | null = null;

  constructor(
    private readonly checkpointer: BaseCheckpointSaver,
    private readonly store: BaseStore
  ) {}

  private getGraph(): ReturnType<typeof buildCustomerGraph> {
    // 原来是 routes/graph.ts 的模块级 lazy 单例，现在由 Nest 容器管理
    if (!this.graph) this.graph = buildCustomerGraph(this.checkpointer, this.store);
    return this.graph;
  }

  /**
   * 以 updates 模式流式执行工作流
   * 历史由 checkpointer 按 thread_id 持久化管理，不再接收前端回传的 history
   */
  stream(message: string, threadId: string, userId?: string) {
    return this.getGraph().stream(
      {
        userInput: message,
        messages:  [new HumanMessage(message)],
      },
      {
        streamMode:    'updates',
        configurable:  { thread_id: threadId, user_id: userId },
      }
    );
  }

  /** 读取某会话的持久化状态（用于刷新/重启后恢复对话、验证短期记忆） */
  async getHistory(threadId: string): Promise<PersistedHistory | null> {
    const state = await this.getGraph().getState({
      configurable: { thread_id: threadId },
    });

    if (!state) return null;

    return {
      messages: ((state.values.messages || []) as BaseMessage[])
        .filter((m) => m._getType?.() === 'human' || m._getType?.() === 'ai')
        .map((m) => ({
          role:    m._getType?.() === 'human' ? ('user' as const) : ('assistant' as const),
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
      summary: state.values.summary || '',
    };
  }
}
