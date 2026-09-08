// server/src/graphs/nodes/order-agent.ts
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { createModel }      from '../../models/deepseek.ts';
import { createOrderTools } from '../../tools/order-tools.ts';
import { buildMemoryContext, formatMessagesAsText } from '../memory-context.ts';
import type { GraphStateType, ToolStep } from '../state.ts';

const model = createModel({ temperature: 0 });

/** 消息内容统一转为字符串（content 可能为多模态数组） */
const contentToString = (content: unknown): string =>
  typeof content === 'string' ? content : JSON.stringify(content);

export const orderAgentNode = async (
  state: GraphStateType,
  config: LangGraphRunnableConfig,
) => {
  const { userInput, messages } = state;

  // 从 config 中取出 userId，注入到订单工具中
  // 这样 getUserOrders 工具不需要 LLM 传 userId，直接用当前登录用户
  const userId = config?.configurable?.user_id as string | undefined;
  const tools = createOrderTools(userId || '');

  // 动态创建 agent（每次调用都用绑定了当前用户的工具）
  const agentApp = createReactAgent({
    llm:    model,
    tools,
    prompt: `你是红松心选的订单查询助手。
根据用户的问题，调用相应工具查询订单或物流信息。
只查询数据，不需要生成最终的客服回答。`,
  });

  // 注入对话上下文（摘要 + 长期记忆 + 最近几轮），
  // 让"查一下我的订单"这类依赖上下文的追问能正确解析
  const recentDialogue = formatMessagesAsText((messages || []).slice(0, -1), 4);
  const contextParts = [buildMemoryContext(state), recentDialogue].filter(Boolean);
  const inputMessages = contextParts.length
    ? [
        new SystemMessage(`对话上下文（供理解用户指代时参考）：\n${contextParts.join('\n\n')}`),
        new HumanMessage(userInput),
      ]
    : [new HumanMessage(userInput)];

  try {
    const result = await agentApp.invoke({ messages: inputMessages });

    // 从消息列表提取工具调用步骤
    const msgs  = result.messages;
    const steps: ToolStep[] = [];
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i]!;
      if (msg instanceof AIMessage && msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          steps.push({
            tool:  tc.name,
            input: tc.args,
            obs:   contentToString(msgs[i + 1]?.content ?? ''),
          });
        }
      }
    }

    const finalMsg = msgs[msgs.length - 1]!;
    return {
      orderResult: { answer: contentToString(finalMsg.content), steps },
    };
  } catch (err) {
    console.error('[orderAgentNode]', err instanceof Error ? err.message : err);
    return { orderResult: { answer: '查询订单信息时出错', steps: [] } };
  }
};
