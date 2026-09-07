// server/src/graphs/nodes/recall-memories.ts
// 长期记忆召回节点：从 Store（按用户隔离的命名空间）检索跨会话的用户偏好，
// 写入 state.userMemories，供后续节点注入 prompt。
import { getStore } from '@langchain/langgraph';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { GraphStateType } from '../state.ts';

export const recallMemoriesNode = async (
  _state: GraphStateType,
  config?: LangGraphRunnableConfig
) => {
  const store = getStore(config);
  const userId = config?.configurable?.user_id as string | undefined;

  if (!store || !userId) return { userMemories: [] };

  try {
    const items = await store.search(['memories', userId], { limit: 10 });
    const memories = items
      .map((item) => String(item.value?.text ?? ''))
      .filter(Boolean);

    if (memories.length > 0) {
      console.log(`[recallMemories] 召回 ${memories.length} 条长期记忆`);
    }
    return { userMemories: memories };
  } catch (err) {
    // 长期记忆不可用不阻断对话
    console.error('[recallMemories]', err instanceof Error ? err.message : err);
    return { userMemories: [] };
  }
};
