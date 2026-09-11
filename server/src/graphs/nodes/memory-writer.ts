// server/src/graphs/nodes/memory-writer.ts
// 长期记忆写入节点：每轮对话结束后，让 LLM 结合已有记忆和本轮交流，
// 重新生成该用户的记忆列表，diff 写回 Store（新增 put、消失 delete）。
// 纯副作用节点，失败不影响主流程。
import type { BaseStore } from '@langchain/langgraph-checkpoint';
import { createModel } from '../../models/model-factory.ts';
import type { GraphStateType } from '../state.ts';

const MAX_MEMORIES = 10;

// 用 temperature=0 的模型保证输出稳定
const model = createModel({ temperature: 0 });

/** 记忆条目使用确定性 key，重复事实 upsert 而不是重复插入 */
const memoryKey = (text: string) => `m_${text.slice(0, 60)}`;

/**
 * 从模型输出中解析 JSON 数组
 * 兼容：直接数组、markdown code block、包裹在其他文本中
 */
function parseMemoryArray(text: string): string[] {
  // 1. 尝试直接解析 JSON 数组
  try {
    const parsed = JSON.parse(text.trim());
    if (Array.isArray(parsed)) {
      return parsed.filter((s): s is string => typeof s === 'string');
    }
  } catch { /* 不是纯 JSON，继续尝试 */ }

  // 2. 尝试提取 ```json ... ``` 代码块
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeBlock?.[1]) {
    try {
      const parsed = JSON.parse(codeBlock[1].trim());
      if (Array.isArray(parsed)) {
        return parsed.filter((s): s is string => typeof s === 'string');
      }
    } catch { /* 解析失败继续 */ }
  }

  // 3. 尝试提取第一个 [ 到最后一个 ] 之间的内容
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    try {
      const parsed = JSON.parse(text.slice(firstBracket, lastBracket + 1));
      if (Array.isArray(parsed)) {
        return parsed.filter((s): s is string => typeof s === 'string');
      }
    } catch { /* 解析失败 */ }
  }

  return [];
}

/**
 * 更新用户长期记忆
 * @param state - 对话状态（用户输入 + 最终回答）
 * @param store - 长期记忆存储实例
 * @param userId - 用户 ID（用于命名空间隔离）
 * @param traceId - 可选，链路追踪 ID，关联本次用户请求
 */
export const updateUserMemory = async (
  state: Pick<GraphStateType, 'userInput' | 'finalAnswer'>,
  store: BaseStore,
  userId: string,
  traceId?: string,
) => {
  const { userInput, finalAnswer } = state;
  if (!userInput || !finalAnswer) return;

  try {
    // 读取已有记忆
    const existing = await store.search(['memories', userId], { limit: MAX_MEMORIES });
    const existingTexts = existing
      .map((item) => String(item.value?.text ?? ''))
      .filter(Boolean);

    const systemPrompt = `你是用户记忆管理器。基于"已有记忆"和"最新对话"，为电商客服场景更新该用户的记忆列表。

要求：
- 只保留对后续客服有用的稳定事实：称呼、偏好（颜色/尺码/品类）、长期诉求等
- 不要保留一次性问题（如某个订单的即时查询）、寒暄和临时信息
- 已有记忆若无变化则原样保留，新增值得记住的事实就加入
- 最多 ${MAX_MEMORIES} 条，每条一句话
- **只输出 JSON 数组，不要任何其他文字、不要 markdown 格式、不要解释**
- 正确示例：["用户喜欢红色","用户穿L码","用户对坚果过敏"]`;

    const userPrompt = `已有记忆：
${existingTexts.length ? existingTexts.map((t) => `- ${t}`).join('\n') : '（无）'}

最新对话：
用户: ${userInput}
客服: ${finalAnswer}

请输出更新后的记忆列表（JSON 数组）：`;

    const response = await model.invoke(
      [
        ['system', systemPrompt],
        ['human', userPrompt],
      ],
      { source: 'graph-memory-writer', traceId } as any
    );

    const responseText = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);

    console.log(`[memoryWriter] 用户 ${userId} 模型输出：${responseText}`);
    const memories = parseMemoryArray(responseText);
    console.log(`[memoryWriter] 用户 ${userId} 解析记忆：${memories.join(', ')}`);

    const nextTexts = memories.map((t) => t.trim()).filter(Boolean);
    const nextKeys = new Set(nextTexts.map(memoryKey));

    // 写入新增/更新的记忆
    for (const text of nextTexts) {
      await store.put(['memories', userId], memoryKey(text), { text });
    }
    // 删除不再存在的旧记忆
    for (const item of existing) {
      if (!nextKeys.has(item.key)) {
        await store.delete(['memories', userId], item.key);
      }
    }

    console.log(
      `[memoryWriter] 用户 ${userId} 记忆更新：${existingTexts.length} → ${nextTexts.length} 条`
    );
  } catch (err) {
    console.error('[memoryWriter]', err instanceof Error ? err.message : err);
  }
};

/**
 * LangGraph 节点兼容版本（保留给图内调用用，目前未使用）
 * 内部从 config 中提取 store 和 userId，转发给 updateUserMemory
 */
export const memoryWriterNode = async (
  state: GraphStateType,
  config?: { store?: BaseStore; configurable?: { user_id?: string } },
) => {
  const store = config?.store;
  const userId = config?.configurable?.user_id;

  if (!store || !userId) return {};

  await updateUserMemory(
    { userInput: state.userInput, finalAnswer: state.finalAnswer },
    store,
    userId,
  );

  return {};
};
