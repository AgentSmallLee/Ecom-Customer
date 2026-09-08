// server/src/common/memory/thread-utils.ts
// 记忆相关工具函数：命名空间前缀、消息裁剪等
import type { BaseMessage } from '@langchain/core/messages';
import { RemoveMessage } from '@langchain/core/messages';

/**
 * 给 threadId 加上命名空间前缀，避免不同模块的 threadId 冲突
 * 例：withNamespace('chat', 'abc123') → 'chat:abc123'
 */
export const withNamespace = (namespace: string, threadId: string): string =>
  `${namespace}:${threadId}`;

/**
 * 裁剪消息到最大轮数，返回 RemoveMessage 列表（用于从 checkpoint 删除旧消息）
 * 保留最后 maxRounds 轮（以 HumanMessage 数量计轮，一轮 = 一次用户提问开始）
 *
 * 计数方式：每出现一条 HumanMessage 算一轮，不管中间有多少条 AI / Tool 消息。
 * 找到倒数第 maxRounds 条 HumanMessage 的位置，把它之前的所有消息全部删掉。
 *
 * @param messages 完整消息列表（按时间顺序排列）
 * @param maxRounds 最大保留轮数
 * @returns 需要删除的 RemoveMessage 数组
 */
export function trimMessages(
  messages: BaseMessage[],
  maxRounds: number,
): RemoveMessage[] {
  // 找出所有 HumanMessage 的位置
  const humanMsgs = messages.filter((m) => m._getType?.() === 'human');
  if (humanMsgs.length <= maxRounds) return [];

  // 从倒数第 maxRounds 条 HumanMessage 开始保留
  const keepFromIndex = humanMsgs.length - maxRounds;
  const cutoffMsgId = humanMsgs[keepFromIndex]?.id;
  const cutoffIdx = messages.findIndex((m) => m.id === cutoffMsgId);

  if (cutoffIdx <= 0) return [];

  // cutoffIdx 之前的所有消息全部删掉（human + ai + tool 等）
  const toRemove = messages.slice(0, cutoffIdx);
  return toRemove
    .filter((m) => m.id != null)
    .map((m) => new RemoveMessage({ id: m.id! }));
}

/**
 * 默认最大轮数（可通过 env 覆盖）
 * 为什么是 20 轮？—— 20 轮对话对大部分客服场景足够，
 * 再多的话 token 成本上升明显，用户也基本不会聊这么久。
 */
export const DEFAULT_MAX_ROUNDS = parseInt(
  process.env.CHAT_MAX_ROUNDS || '20',
);
