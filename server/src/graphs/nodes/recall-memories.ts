// server/src/graphs/nodes/recall-memories.ts
// 长期记忆召回节点：从 Store（按用户隔离的命名空间）检索跨会话的用户偏好，
// 写入 state.userMemories，供后续节点注入 prompt。
//
// Store 注入链路：
//   1. buildCustomerGraph(checkpointer, store) — 构造图时从外部传入 store
//   2. graph.compile({ checkpointer, store })  — 编译时绑定到图实例
//   3. 节点执行时，LangGraph 运行时把 store 注入到 config 中
//   4. 本节点通过 getStore(config) 取出使用
import { getStore } from '@langchain/langgraph';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import type { GraphStateType } from '../state.ts';

export const recallMemoriesNode = async (
  _state: GraphStateType,
  config?: LangGraphRunnableConfig
) => {
  // 获取长期记忆对象
  const store = getStore(config);
  // 获取当前会话的用户ID
  const userId = config?.configurable?.user_id as string | undefined;
  // store 没传或无用户时，返回空（不阻断对话）
  if (!store || !userId) {
    return { userMemories: [] };
  }

  try {
    const items = await store.search(['memories', userId], { limit: 10 });
    console.log('[recallMemories]', items); // 打印召回的长期记忆
    // [
    //    {
    //    namespace: [ 'memories', 'U-dev-0001' ],
    //    key: 'm_用户喜欢蓝色',
    //    value: { text: '用户喜欢蓝色' },
    //    createdAt: 2026-09-09T04:21:34.494Z,
    //    updatedAt: 2026-09-09T04:21:40.518Z 
    //    }
    //]
    const memories = items
      .map((item) => String(item.value?.text ?? ''))
      .filter(Boolean);

    if (memories.length > 0) {
      console.log(`[recallMemories] 召回 ${memories.length} 条长期记忆`);
    } else {
      console.log(`userId: ${userId} [recallMemories] 无长期记忆`);
      return { userMemories: [] };
    }
    return { userMemories: memories };
  } catch (err) {
    // 长期记忆不可用不阻断对话
    console.error('[recallMemories]', err instanceof Error ? err.message : err);
    return { userMemories: [] };
  }
};
