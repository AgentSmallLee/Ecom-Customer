// server/src/graphs/memory-context.ts
// 把摘要（长度控制）和长期记忆（用户偏好）格式化为可注入 prompt 的上下文块
import type { BaseMessage } from '@langchain/core/messages';
import type { GraphStateType } from './state.ts';

/** 拼接摘要 + 长期记忆为一段 system 上下文文本；为空时返回空字符串 */
export const buildMemoryContext = (state: GraphStateType): string => {
  const parts: string[] = [];

  if (state.summary) {
    parts.push(`【此前对话摘要】\n${state.summary}`);
  }

  if (state.userMemories?.length) {
    parts.push(`【该用户的长期记忆】\n${state.userMemories.map((m) => `- ${m}`).join('\n')}`);
  }

  return parts.join('\n\n');
};

/** 把 BaseMessage[] 格式化为 "用户/客服: 内容" 的纯文本对话（供意图分类等场景） */
export const formatMessagesAsText = (messages: BaseMessage[], maxMessages: number): string =>
  messages
    .slice(-maxMessages)
    .map((m) => `${m._getType?.() === 'human' ? '用户' : '客服'}: ${m.content}`)
    .join('\n');
