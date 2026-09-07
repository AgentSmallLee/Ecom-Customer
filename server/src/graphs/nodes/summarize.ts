// server/src/graphs/nodes/summarize.ts
// 长度控制节点：消息数超过阈值时，把旧摘要 + 旧消息交给 LLM 压缩成新摘要，
// 并用 RemoveMessage 从 checkpoint 状态中删除被压缩的旧消息（保留最近几条）。
import { RemoveMessage } from '@langchain/core/messages';
import { createModel }        from '../../models/deepseek.ts';
import { ChatPromptTemplate }  from '@langchain/core/prompts';
import { StringOutputParser }  from '@langchain/core/output_parsers';
import type { GraphStateType } from '../state.ts';

// 触发压缩的消息数阈值 / 压缩后保留的最近消息数（可用 env 覆盖）
const SUMMARY_THRESHOLD = parseInt(process.env.MEMORY_SUMMARY_THRESHOLD || '10');
const KEEP_RECENT       = parseInt(process.env.MEMORY_KEEP_RECENT || '4');

/** answerSynthesizer 之后条件路由：超阈值 → summarize，否则 → memoryWriter */
export const shouldSummarize = (state: GraphStateType): 'summarize' | 'memoryWriter' =>
  state.messages.length > SUMMARY_THRESHOLD ? 'summarize' : 'memoryWriter';

const prompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    `你是对话摘要助手。请把"已有摘要"和"新增对话"合并为一份更新的摘要。
要求：
- 保留用户的个人信息、偏好、订单相关诉求等关键事实
- 用第三人称简述，不要遗漏已有摘要中的重要信息
- 直接输出摘要正文，不要任何前缀或解释`,
  ],
  ['human', `已有摘要：\n{summary}\n\n新增对话：\n{conversation}`],
]);

const chain = prompt.pipe(createModel({ temperature: 0 })).pipe(new StringOutputParser());

export const summarizeNode = async (state: GraphStateType) => {
  const { messages, summary } = state;

  const oldMessages = messages.slice(0, -KEEP_RECENT);
  if (oldMessages.length === 0) return {};

  const conversation = oldMessages
    .map((m) => `${m._getType?.() === 'human' ? '用户' : '客服'}: ${m.content}`)
    .join('\n');

  try {
    const newSummary = await chain.invoke({
      summary: summary || '（无）',
      conversation,
    });

    console.log(
      `[summarize] 压缩 ${oldMessages.length} 条旧消息 → 摘要（保留最近 ${KEEP_RECENT} 条）`
    );

    return {
      summary: newSummary,
      // 只删除 checkpoint 中带 id 的旧消息，不碰当前轮新消息
      messages: oldMessages
        .filter((m) => m.id != null)
        .map((m) => new RemoveMessage({ id: m.id! })),
    };
  } catch (err) {
    console.error('[summarize]', err instanceof Error ? err.message : err);
    return {};
  }
};
