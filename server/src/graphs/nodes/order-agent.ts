// server/src/graphs/nodes/order-agent.ts
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { createModel }      from '../../models/deepseek.ts';
import { allTools }         from '../../tools/order-tools.ts';
import type { GraphStateType, ToolStep } from '../state.ts';

const model    = createModel({ temperature: 0 });
const agentApp = createReactAgent({
  llm:    model,
  tools:  allTools,
  prompt: `你是红松心选的订单查询助手。
根据用户的问题，调用相应工具查询订单或物流信息。
只查询数据，不需要生成最终的客服回答。`,
});

/** 消息内容统一转为字符串（content 可能为多模态数组） */
const contentToString = (content: unknown): string =>
  typeof content === 'string' ? content : JSON.stringify(content);

export const orderAgentNode = async (state: GraphStateType) => {
  const { userInput } = state;
  try {
    const result = await agentApp.invoke({
      messages: [new HumanMessage(userInput)],
    });

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
