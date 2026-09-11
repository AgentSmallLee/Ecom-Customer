// server/src/graph/graph.service.ts
// LangGraph 工作流服务：持有编译后的图单例（DI 生命周期管理）
import { randomUUID } from 'crypto';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { BaseStore }           from '@langchain/langgraph-checkpoint';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { buildCustomerGraph }       from '../graphs/customer-graph.ts';
import { updateUserMemory }         from '../graphs/nodes/memory-writer.ts';
import type { GraphStateType } from '../graphs/state.ts';
import { withNamespace } from '../common/memory/thread-utils.ts';

const NAMESPACE = 'graph';

export interface PersistedHistory {
  messages: { role: 'user' | 'assistant'; content: string }[];
  summary:  string;
}

/** 图流式事件类型 */
export type GraphStreamEvent =
  | { kind: 'node'; node: string; state: Partial<GraphStateType> }
  | { kind: 'custom'; data: Record<string, unknown> };

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
   * 双流模式：updates（节点执行轨迹） + custom（token 级流式）
   *
   * LangGraph streamMode 数组格式：每个 chunk 是 [mode, data] 元组
   *   ["updates", { nodeName: stateUpdate }]
   *   ["custom",  { type: "token", content: "..." }]
   *
   * 历史由 checkpointer 按 thread_id 持久化管理。
   * 长期记忆写入改为异步副作用：图执行完之后后台 fire-and-forget。
   */
  async *stream(message: string, threadId: string, userId?: string): AsyncGenerator<GraphStreamEvent> {
    const graph = this.getGraph();
    // traceId：每次请求唯一，关联本次请求内所有节点的所有 LLM 调用
    const traceId = randomUUID();
    const config: LangGraphRunnableConfig = {
      configurable: { thread_id: withNamespace(NAMESPACE, threadId, userId), user_id: userId, traceId },
    };

    // graph.stream 接收2个参数
    // 1. 输入状态（是一个对象，字段可以自定义）
    // 2. 配置参数（streamMode 等）
    const stream = await graph.stream(
      {
        userInput: message, // 用户输入， 非LLM 节点（如意图路由器）直接读取字符串
        messages:  [new HumanMessage(message)], // 历史消息
      },
      // 第二个参数是PregelOptions对象，包含streamMode等配置，它继承RunnableConfig，RunnableConfig中有configurable字段
      {
        streamMode:   ['updates', 'custom'] as const,
        ...config,
      }
    );

    let finalAnswer = '';
    let userInput   = message;

    // 消费双流事件，每个 chunk 是 [mode, data] 元组
    for await (const chunk of stream as unknown as [string, unknown][]) {
      const [mode, data] = chunk;

      if (mode === 'updates') {
        // updates 流：每个节点执行完推送一次状态更新
        const nodeStates = data as Record<string, Partial<GraphStateType>>;
        for (const [nodeName, nodeState] of Object.entries(nodeStates)) {
          yield { kind: 'node', node: nodeName, state: nodeState };

          // 收集最终答案（answerSynthesizer 节点产出）
          if (nodeName === 'answerSynthesizer' && nodeState.finalAnswer) {
            finalAnswer = nodeState.finalAnswer;
          }
        }
      } else if (mode === 'custom') {
        // custom 流：节点内部主动推送的事件（token 等）
        yield { kind: 'custom', data: data as Record<string, unknown> };
      }
    }

    // ── 异步写长期记忆（fire-and-forget，不阻塞响应） ──
    // 只需要 userInput 和 finalAnswer 就能生成记忆，不需要读完整 state
    if (finalAnswer && userId) {
      updateUserMemory(
        { userInput, finalAnswer },
        this.store,
        userId,
        traceId,
      ).catch((err) =>
        console.error('[GraphService][memoryWriter] 异步写入失败:', err instanceof Error ? err.message : err)
      );
    }
  }

  /** 读取某会话的持久化状态（带用户隔离，防止 IDOR 越权） */
  async getHistory(threadId: string, userId?: string): Promise<PersistedHistory | null> {
    const state = await this.getGraph().getState({
      configurable: { thread_id: withNamespace(NAMESPACE, threadId, userId) },
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
