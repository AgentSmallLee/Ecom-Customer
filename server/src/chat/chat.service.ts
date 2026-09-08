// server/src/chat/chat.service.ts
// 基础对话服务：带短期记忆（checkpointer 持久化）
import { Inject, Injectable } from '@nestjs/common';
import {
  customerServiceStreamChain,
  formatHistory,
  type ChatMessage,
} from '../chains/basic-chat.ts';
import { CHECKPOINTER } from '../common/memory/memory.module.ts';
import { withNamespace, trimMessages, DEFAULT_MAX_ROUNDS } from '../common/memory/thread-utils.ts';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import {
  MessagesAnnotation,
  StateGraph,
  START,
  END,
  getWriter,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph';
import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';

const NAMESPACE = 'chat';

@Injectable()
export class ChatService {
  private graph: ReturnType<typeof this.buildGraph>;

  constructor(
    @Inject(CHECKPOINTER) private readonly checkpointer: BaseCheckpointSaver,
  ) {
    this.graph = this.buildGraph();
  }

  private buildGraph() {
    const workflow = new StateGraph(MessagesAnnotation)
      .addNode('chat', async (state, config: LangGraphRunnableConfig) => {
        // 把 messages 转成 chain 需要的格式
        const history: ChatMessage[] = (state.messages as BaseMessage[])
          .filter((m) => m.type === 'human' || m.type === 'ai')
          .map((m) => ({
            role:    m.type === 'human' ? 'user' : 'assistant',
            content: typeof m.content === 'string' ? m.content : '',
          }));
        // 最后一条是当前用户输入，去掉它作为历史
        const input = history[history.length - 1]?.content || '';
        const pastHistory = history.slice(0, -1);

        // 流式调用：逐 token 推送，同时收集完整输出
        const stream = await customerServiceStreamChain.stream({
          user_input:   input,
          chat_history: formatHistory(pastHistory),
          current_time: new Date().toLocaleString('zh-CN'),
        });
        let fullOutput = '';
        for await (const chunk of stream as unknown as AsyncIterable<string>) {
          if (chunk) {
            fullOutput += chunk;
            // 通过 writer 把 token 推送给 graph.stream（custom 模式）
            getWriter(config)?.(chunk);
          }
        }

        return { messages: [new AIMessage(fullOutput)] };
      })
      .addEdge(START, 'chat')
      .addEdge('chat', END);

    return workflow.compile({ checkpointer: this.checkpointer });
  }

  /** 普通对话（一次性返回） */
  async chat(message: string, threadId: string): Promise<string> {
    const config = { configurable: { thread_id: withNamespace(NAMESPACE, threadId) } };

    const result = await this.graph.invoke(
      { messages: [new HumanMessage(message)] },
      config,
    );

    // 轮次裁剪
    await this.trimIfNeeded(config);

    const msgs = (result.messages as BaseMessage[]).filter(
      (m) => m.type === 'ai',
    );
    const lastAi = msgs[msgs.length - 1];
    return lastAi && typeof lastAi.content === 'string' ? lastAi.content : '';
  }

  /** 流式对话：通过 graph.stream 执行，checkpointer 自动管理历史 */
  async *stream(message: string, threadId: string) {
    const config = { configurable: { thread_id: withNamespace(NAMESPACE, threadId) } };

    // 走图执行：历史由 checkpointer 自动加载，结果自动写入 checkpoint
    // streamMode: 'custom' —— 节点内通过 streamWriter 推送 token 级流式输出
    const stream = await this.graph.stream(
      { messages: [new HumanMessage(message)] },
      { streamMode: 'custom', ...config },
    );

    // 透传节点内通过 getWriter 推送的 token 流
    for await (const chunk of stream as unknown as AsyncIterable<unknown>) {
      if (typeof chunk === 'string' && chunk) {
        // 把token字符串吐出去
        yield chunk;
      }
    }

    // 轮次裁剪
    await this.trimIfNeeded(config);
  }

  /** 获取某会话的历史消息（用于刷新恢复） */
  async getHistory(threadId: string): Promise<ChatMessage[]> {
    const state = await this.graph.getState({
      configurable: { thread_id: withNamespace(NAMESPACE, threadId) },
    });

    const messages = (state?.values?.messages || []) as BaseMessage[];

    return messages
      .filter((m) => m._getType?.() === 'human' || m._getType?.() === 'ai')
      .map((m) => ({
        role:    m._getType?.() === 'human' ? 'user' : 'assistant',
        content: typeof m.content === 'string' ? m.content : '',
      }));
  }

  /** 消息数超最大轮数时，删除旧消息 */
  private async trimIfNeeded(config: { configurable: { thread_id: string } }) {
    const state = await this.graph.getState(config);
    const messages = (state?.values?.messages || []) as BaseMessage[];
    const removes = trimMessages(messages, DEFAULT_MAX_ROUNDS);
    if (removes.length > 0) {
      await this.graph.updateState(config, { messages: removes });
    }
  }
}
