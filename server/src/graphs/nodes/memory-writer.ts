// server/src/graphs/nodes/memory-writer.ts
// 长期记忆写入节点：每轮对话结束后，让 LLM 结合已有记忆和本轮交流，
// 重新生成该用户的记忆列表，diff 写回 Store（新增 put、消失 delete）。
// 纯副作用节点，失败不影响主流程。
import type { BaseStore } from '@langchain/langgraph-checkpoint';
import type { AIMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createModel } from '../../models/model-factory.ts';
import { buildTraceConfig } from '../../llm/trace-context.ts';
import type { GraphStateType } from '../state.ts';

const MAX_MEMORIES = 10;

/** 记忆提取的输出契约：模型按这个 schema 输出，本地再校验一次 */
const MemorySchema = z.object({
  memories: z.array(z.string()).describe('更新后的用户长期记忆列表，每条一句话'),
});

/** 用 function calling 做结构化提取：schema 交给模型侧约束，避免事后解析自由文本 */
//
const saveMemoriesTool = tool(async () => 'ok', {
  name: 'save_memories', // 工具名称
  description: '保存更新后的用户长期记忆列表',
  schema:   MemorySchema, // 定义参数格式
});

// 用 temperature=0 的模型保证输出稳定，并绑定提取工具
const model = createModel({ temperature: 0 }).bindTools([saveMemoriesTool]);

/** 记忆条目使用确定性 key，重复事实 upsert 而不是重复插入 */
const memoryKey = (text: string) => `m_${text.slice(0, 60)}`;

/**
 * 兜底解析：模型没走工具调用时（如降级到静态兜底或直接吐 JSON 文本），
 * 从文本里捞出 JSON 再用同一个 schema 校验
 */
function parseMemoriesFromText(text: string): string[] {
  const candidates = [text.trim()];

  // ```json ... ``` 代码块
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeBlock?.[1]) candidates.push(codeBlock[1].trim());

  // 第一个 { 到最后一个 }、第一个 [ 到最后一个 ]
  const objStart = text.indexOf('{');
  const objEnd   = text.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) candidates.push(text.slice(objStart, objEnd + 1));
  const arrStart = text.indexOf('[');
  const arrEnd   = text.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) candidates.push(text.slice(arrStart, arrEnd + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const list = Array.isArray(parsed) ? parsed : parsed?.memories;
      if (!Array.isArray(list)) continue;

      // 兼容模型自造的 { content: "..." } 结构
      const texts = list
        .map((item) => (typeof item === 'string' ? item : item?.content))
        .filter((item): item is string => typeof item === 'string');

      const result = MemorySchema.safeParse({ memories: texts });
      if (result.success) return result.data.memories;
    } catch { /* 换下一种候选文本继续试 */ }
  }

  return [];
}

/**
 * 更新用户长期记忆
 * @param state - 对话状态（用户输入 + 最终回答）
 * @param store - 长期记忆存储实例
 * @param userId - 用户 ID（用于命名空间隔离）
 * @param traceId - 可选，链路追踪 ID，关联本次用户请求
 * @param threadId - 可选，会话 ID，写入审计日志便于关联
 */
export const updateUserMemory = async (
  state: Pick<GraphStateType, 'userInput' | 'finalAnswer'>,
  store: BaseStore,
  userId: string,
  traceId?: string,
  threadId?: string,
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
- **必须调用 save_memories 工具提交结果**，不要用文字回答
- 若确实无法调用工具，则只输出 JSON 对象：{"memories":["用户喜欢红色"]}，不要任何其他文字`;

    const userPrompt = `已有记忆：
${existingTexts.length ? existingTexts.map((t) => `- ${t}`).join('\n') : '（无）'}

最新对话：
用户: ${userInput}
客服: ${finalAnswer}

请调用 save_memories 提交更新后的记忆列表：`;

    const response = await model.invoke(
      [
        ['system', systemPrompt],
        ['human', userPrompt],
      ],
      buildTraceConfig('graph-memory-writer', { traceId, userId, threadId }) as any
    ) as unknown as AIMessage;

    // 结构化提取：优先取工具调用参数，模型没走工具时退回文本 JSON，两条路都用同一个 schema 校验
    const fromTool = MemorySchema.safeParse(response.tool_calls?.[0]?.args);
    // 校验结果 { success : true , data :   { memories : [ '用户喜欢红色' , ...] } }
    const responseText = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);
     // [{"name":"save_memories","args":{"memories":["用户喜欢红色","用户喜欢吃苹果"]},"type":"tool_call","id":"call_00_2oHvCpjfcHw7wVWmaKnl6296"}] 
    console.log(`[memoryWriter] 用户 ${userId} 模型输出：${responseText || JSON.stringify(response.tool_calls)}`);
    const memories = fromTool.success
      ? fromTool.data.memories
      : parseMemoriesFromText(responseText);
    console.log(`[memoryWriter] 用户 ${userId} 提取记忆(${fromTool.success ? 'tool_call' : 'text'}): ${memories.join(', ')}`);

    const nextTexts = memories.map((t) => t.trim()).filter(Boolean).slice(0, MAX_MEMORIES);
    const nextKeys = new Set(nextTexts.map((t) => memoryKey(t)));

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
