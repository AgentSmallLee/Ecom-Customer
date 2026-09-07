// server/src/graphs/nodes/general-chat.ts
import { createModel }        from '../../models/deepseek.ts';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { buildMemoryContext } from '../memory-context.ts';
import type { GraphStateType } from '../state.ts';

const prompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    `你是红松心选电商平台的客服助手小购。语气友好，称呼用户为"亲"，回复简洁。

{memoryContext}`,
  ],
  ['placeholder', '{chat_history}'],
  ['human', '{userInput}'],
]);

const chain = prompt.pipe(createModel({ temperature: 0.7 })).pipe(new StringOutputParser());

export const generalChatNode = async (state: GraphStateType) => {
  const { userInput, messages } = state;

  // 历史注入：排除最后一条（本轮 userInput 由下方 human 模板承担）
  const chatHistory = (messages || [])
    .slice(0, -1)
    .slice(-8)
    .map((m) => [m._getType?.() === 'human' ? 'human' : 'assistant', m.content] as const)
    .filter(Boolean);

  const result = await chain.invoke({
    userInput,
    chat_history: chatHistory,
    memoryContext: buildMemoryContext(state),
  });
  return { finalAnswer: result };
};
