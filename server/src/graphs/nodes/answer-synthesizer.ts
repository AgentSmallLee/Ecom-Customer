// server/src/graphs/nodes/answer-synthesizer.ts
import { AIMessage } from '@langchain/core/messages';
import { createModel }        from '../../models/deepseek.ts';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { buildMemoryContext } from '../memory-context.ts';
import type { GraphStateType } from '../state.ts';

const prompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    `你是红松心选电商平台的客服助手小购。

根据以下查询结果，为用户生成一个清晰、友好的回答。
称呼用户为"亲"，语气专业，内容简洁准确。

订单查询结果（如有）：{orderResult}
知识库查询结果（如有）：{ragResult}

{memoryContext}`,
  ],
  ['placeholder', '{chat_history}'],
  ['human', '{userInput}'],
]);

const chain = prompt.pipe(createModel({ temperature: 0.5 })).pipe(new StringOutputParser());

export const answerSynthesizerNode = async (state: GraphStateType) => {
  const { userInput, orderResult, ragResult, finalAnswer, intent, messages } = state;

  // general 意图已在 generalChatNode 生成答案，直接透传（同样要落一条 AIMessage 进短期记忆）
  if (intent === 'general' && finalAnswer) {
    return { finalAnswer, messages: [new AIMessage(finalAnswer)] };
  }

  // 历史注入：排除最后一条（本轮 userInput 由下方 human 模板承担）
  const chatHistory = (messages || [])
    .slice(0, -1)
    .slice(-6)
    .map((m) => [m._getType?.() === 'human' ? 'human' : 'assistant', m.content] as const);

  const result = await chain.invoke({
    userInput,
    orderResult: orderResult ? JSON.stringify(orderResult.answer) : '无',
    ragResult:   ragResult   || '无',
    memoryContext: buildMemoryContext(state),
    chat_history: chatHistory,
  });

  // 关键：把 AI 回复写入 messages 通道，checkpointer 才能持久化完整对话
  return { finalAnswer: result, messages: [new AIMessage(result)] };
};
