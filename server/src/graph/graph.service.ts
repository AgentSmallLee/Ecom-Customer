// server/src/graph/graph.service.ts
// LangGraph 工作流服务：持有编译后的图单例（DI 生命周期管理）
import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { BaseStore }           from '@langchain/langgraph-checkpoint';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { buildCustomerGraph }       from '../graphs/customer-graph.ts';
import { memoryWriterNode }         from '../graphs/nodes/memory-writer.ts';
import type { GraphStateType }      from '../graphs/state.ts';

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
    if (!this.graph) this.graph = buildCustomerGraph(this.checkpointer);
    return this.graph;
  }

  /**
   * 以 updates 模式流式执行工作流
   * 历史由 checkpointer 按 thread_id 持久化管理，不再接收前端回传的 history
   *
   * 长期记忆写入改为异步副作用：图执行完之后后台 fire-and-forget，
   * 不阻塞用户收到最终答案。
   */
  async *stream(message: string, threadId: string, userId?: string) {
    const graph = this.getGraph();
    const config: LangGraphRunnableConfig = {
      configurable: { thread_id: threadId, user_id: userId },
    };

    const stream = await graph.stream(
      {
        userInput: message,
        messages:  [new HumanMessage(message)],
      },
      {
        streamMode:   'updates',
        ...config,
      }
    );

    let finalAnswer = '';
    let userInput   = message;

    // 透传所有流式输出，同时收集需要的字段
    for await (const chunk of stream as unknown as AsyncIterable<Record<string, Partial<GraphStateType>>>) {
      yield chunk;

      // 记录 answerSynthesizer 节点的输出（包含 finalAnswer）
      if (chunk.answerSynthesizer?.finalAnswer) {
        finalAnswer = chunk.answerSynthesizer.finalAnswer;
      }
    }

    // ── 异步写长期记忆（fire-and-forget，不阻塞响应） ──
    if (finalAnswer && userId) {
      // 读最新 state（确保拿到 checkpointer 里的完整 messages 和 summary）
      graph.getState(config).then((snapshot) => {
        const state: Partial<GraphStateType> = {
          userInput,
          finalAnswer,
          messages:    (snapshot?.values?.messages || []) as BaseMessage[],
          summary:     (snapshot?.values?.summary || '') as string,
          userMemories: (snapshot?.values?.userMemories || []) as string[],
        };

        memoryWriterNode(state as GraphStateType, config).catch((err) =>
          console.error('[GraphService][memoryWriter] 异步写入失败:', err instanceof Error ? err.message : err)
        );
      }).catch((err) =>
        console.error('[GraphService][memoryWriter] 读取状态失败:', err instanceof Error ? err.message : err)
      );
    }
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
