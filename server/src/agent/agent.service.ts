// server/src/agent/agent.service.ts
// Agent 服务：带短期记忆（checkpointer）的 ReAct Agent
import { Inject, Injectable } from '@nestjs/common';
import { HumanMessage, AIMessage, ToolMessage, BaseMessage } from '@langchain/core/messages';
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
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { allTools } from '../tools/order-tools.ts';
import { createModel } from '../models/deepseek.ts';

const NAMESPACE = 'agent';

/** Agent 流式事件类型 */
export type AgentStreamEvent =
  | { type: 'token'; content: string }
  | { type: 'tool_start'; name: string; input: unknown }
  | { type: 'tool_end'; name: string; observation: string };

@Injectable()
export class AgentService {
  private graph: ReturnType<typeof this.buildGraph>;

  constructor(
    @Inject(CHECKPOINTER) private readonly checkpointer: BaseCheckpointSaver,
  ) {
    this.graph = this.buildGraph();
  }

  private buildGraph() {
    const streamingModel = createModel({ temperature: 0, streaming: true }).bindTools(allTools);
    const toolNode = new ToolNode(allTools);

    const shouldContinue = (state: typeof MessagesAnnotation.State) => {
      const lastMessage = state.messages[state.messages.length - 1];
      if (lastMessage instanceof AIMessage && lastMessage.tool_calls?.length) {
        return 'tools';
      }
      return END;
    };

    // Agent 节点：流式生成 + 推送 token（通过 custom 流）
    const callModel = async (
      state: typeof MessagesAnnotation.State,
      config: LangGraphRunnableConfig,
    ) => {
      const writer = getWriter(config);
      const stream = await streamingModel.stream(state.messages);

      let content = '';
      // 用字符串暂存 args，流式场景下是逐段字符串拼起来的
      const toolCallBuilders: { name: string; args: string; id: string }[] = [];

      for await (const chunk of stream) {
        // 逐块推送 token 到 custom 流
        const chunkContent = typeof chunk.content === 'string' ? chunk.content : '';
        if (chunkContent) {
          content += chunkContent;
          writer?.({ type: 'token', content: chunkContent });
        }
        // 累加 tool_call_chunks（流式场景下 tool_calls 是逐块出来的字符串片段）
        if (chunk.tool_call_chunks?.length) {
          for (const tc of chunk.tool_call_chunks) {
            const idx = tc.index ?? toolCallBuilders.length;
            if (idx >= toolCallBuilders.length) {
              toolCallBuilders.push({ name: tc.name || '', args: tc.args || '', id: tc.id || '' });
            } else {
              const existing = toolCallBuilders[idx];
              if (tc.args) existing.args += tc.args;
              if (tc.name) existing.name = tc.name;
              if (tc.id) existing.id = tc.id;
            }
          }
        }
      }

      // 把字符串 args 解析成对象，构造正式的 tool_calls
      const toolCalls = toolCallBuilders.map((tc) => {
        let args: Record<string, unknown> = {};
        try {
          args = tc.args ? JSON.parse(tc.args) : {};
        } catch {
          // 解析失败就给空对象，不影响主流程
        }
        return { name: tc.name, args, id: tc.id, type: 'tool_call' as const };
      });

      // 如果有工具调用，推送工具开始事件
      if (toolCalls.length > 0 && writer) {
        for (const tc of toolCalls) {
          writer({ type: 'tool_start', name: tc.name, input: tc.args });
        }
      }

      return { messages: [new AIMessage({ content, tool_calls: toolCalls })] };
    };

    // 工具节点：执行工具 + 推送工具结果事件
    const callTools = async (
      state: typeof MessagesAnnotation.State,
      config: LangGraphRunnableConfig,
    ) => {
      const result = await toolNode.invoke(state);
      const writer = getWriter(config);

      if (writer) {
        const toolMsgs = (result.messages || []) as ToolMessage[];
        for (const tm of toolMsgs) {
          writer({
            type: 'tool_end',
            name: tm.name || '',
            observation: typeof tm.content === 'string'
              ? tm.content
              : JSON.stringify(tm.content),
          });
        }
      }

      return result;
    };

    const workflow = new StateGraph(MessagesAnnotation)
      .addNode('agent', callModel)
      .addNode('tools', callTools)
      .addEdge(START, 'agent')
      .addConditionalEdges('agent', shouldContinue, {
        tools: 'tools',
        [END]: END,
      })
      .addEdge('tools', 'agent');

    return workflow.compile({ checkpointer: this.checkpointer });
  }

  /** 非流式调用（一次性返回） */
  async invoke(message: string, threadId: string) {
    const config = { configurable: { thread_id: withNamespace(NAMESPACE, threadId) } };

    const result = await this.graph.invoke(
      { messages: [new HumanMessage(message)] },
      config,
    );

    // 轮次裁剪
    await this.trimIfNeeded(config);

    return result;
  }

  /** 流式调用：通过 custom 流推送 token + 工具步骤事件 */
  async *stream(message: string, threadId: string): AsyncGenerator<AgentStreamEvent> {
    const config = { configurable: { thread_id: withNamespace(NAMESPACE, threadId) } };

    const stream = await this.graph.stream(
      { messages: [new HumanMessage(message)] },
      { streamMode: 'custom', ...config },
    );

    // 透传 custom 流中的事件
    for await (const event of stream as unknown as AsyncIterable<unknown>) {
      if (event && typeof event === 'object') {
        yield event as AgentStreamEvent;
      }
    }

    // 轮次裁剪
    await this.trimIfNeeded(config);
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

  /** 获取会话历史 */
  async getHistory(threadId: string) {
    const state = await this.graph.getState({
      configurable: { thread_id: withNamespace(NAMESPACE, threadId) },
    });

    if (!state || !state.values?.messages) return { messages: [] };

    const messages = (state.values.messages as BaseMessage[])
      .filter((m) => m._getType?.() === 'human' || m._getType?.() === 'ai')
      .map((m) => ({
        role:    m._getType?.() === 'human' ? 'user' : 'assistant',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }));

    return { messages };
  }
}
