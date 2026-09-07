// server/src/graphs/nodes/memory-writer.ts
// 长期记忆写入节点：每轮对话结束后，让 LLM 结合已有记忆和本轮交流，
// 重新生成该用户的记忆列表，diff 写回 Store（新增 put、消失 delete）。
// 纯副作用节点，失败不影响主流程。
import { z } from 'zod';
import { getStore } from '@langchain/langgraph';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';
import { createModel } from '../../models/deepseek.ts';
import type { GraphStateType } from '../state.ts';

const MAX_MEMORIES = 10;

const memorySchema = z.object({
  memories: z.array(z.string()).max(MAX_MEMORIES),
});

// 注意：DeepSeek 不支持 json_schema response_format，
// 这里显式走 function calling 方式的结构化输出
const structuredModel = createModel({ temperature: 0 }).withStructuredOutput(memorySchema, {
  method: 'functionCalling',
});

/** 记忆条目使用确定性 key，重复事实 upsert 而不是重复插入 */
const memoryKey = (text: string) => `m_${text.slice(0, 60)}`;

export const memoryWriterNode = async (
  state: GraphStateType,
  config?: LangGraphRunnableConfig
) => {
  const store = getStore(config);
  const userId = config?.configurable?.user_id as string | undefined;

  if (!store || !userId) return {};
  const { userInput, finalAnswer } = state;
  if (!userInput || !finalAnswer) return {};

  try {
    const existing = await store.search(['memories', userId], { limit: MAX_MEMORIES });
    const existingTexts = existing
      .map((item) => String(item.value?.text ?? ''))
      .filter(Boolean);

    const { memories } = await structuredModel.invoke([
      [
        'system',
        `你是用户记忆管理器。基于"已有记忆"和"最新对话"，为电商客服场景更新该用户的记忆列表。
要求：
- 只保留对后续客服有用的稳定事实：称呼、偏好（颜色/尺码/品类）、长期诉求等
- 不要保留一次性问题（如某个订单的即时查询）、寒暄和临时信息
- 已有记忆若无变化则原样保留，新增值得记住的事实就加入
- 最多 ${MAX_MEMORIES} 条，每条一句话`,
      ],
      [
        'human',
        `已有记忆：\n${existingTexts.length ? existingTexts.map((t) => `- ${t}`).join('\n') : '（无）'}\n\n最新对话：\n用户: ${userInput}\n客服: ${finalAnswer}`,
      ],
    ]);

    const nextTexts = (memories ?? []).map((t) => t.trim()).filter(Boolean);
    const nextKeys  = new Set(nextTexts.map(memoryKey));

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

  return {};
};
