// server/src/graphs/nodes/answer-synthesizer.ts
import { createModel }        from '../../models/deepseek.ts';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import type { GraphStateType } from '../state.ts';

const prompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    `你是红松心选电商平台的客服助手小购。

根据以下查询结果，为用户生成一个清晰、友好的回答。
称呼用户为"亲"，语气专业，内容简洁准确。

订单查询结果（如有）：{orderResult}
知识库查询结果（如有）：{ragResult}`,
  ],
  ['human', '{userInput}'],
]);

const chain = prompt.pipe(createModel({ temperature: 0.5 })).pipe(new StringOutputParser());

export const answerSynthesizerNode = async (state: GraphStateType) => {
  const { userInput, orderResult, ragResult, finalAnswer, intent } = state;

  // general 意图已在 generalChatNode 生成答案，直接透传
  if (intent === 'general' && finalAnswer) return { finalAnswer };

  const result = await chain.invoke({
    userInput,
    orderResult: orderResult ? JSON.stringify(orderResult.answer) : '无',
    ragResult:   ragResult   || '无',
  });
  return { finalAnswer: result };
};
