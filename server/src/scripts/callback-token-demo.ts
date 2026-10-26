/**
 * 演示：RunnableBinding + BaseCallbackHandler 如何配合统计 token
 *
 * 运行：cd server && npx tsx src/scripts/callback-token-demo.ts
 *
 * 核心结论（对应 failover-chat-model.ts 里的坑）：
 *  - 走 RunnableBinding 层（bindTools/bind/pipe）调用模型时，
 *    在 call options 里传的 callbacks 会被 LangChain 回调系统消费，
 *    handleLLMEnd 会收到完整的 LLMResult（含 llmOutput.tokenUsage），可以在回调里统计 token；
 *  - 而 FailoverChatModel 内部为了拿 ChatResult 直接调底层 `llm._generate(...)`，
 *    绕过了 RunnableBinding 的合并逻辑，options.callbacks 不会生效（实测 handleLLMEnd 触发 0 次），
 *    所以 token 只能从 `_generate` 返回的 llmOutput.tokenUsage 里取。
 *
 * 【回调触发机制总结】
 *  触发条件不是"只有 invoke/stream"，而是"必须经过 LangChain 公开 API 层"：
 *   - runManager 由公开 API 层（invoke / stream / batch / generate）用 options.callbacks
 *     调 CallbackManager.configure 创建，并在调用前后 emit handleLLMStart / handleLLMEnd；
 *   - 底层 _generate / _streamResponseChunks 只是"被调用方"：接收 runManager 透传给 SDK，
 *     不消费 options.callbacks，也不主动 emit 回调。
 *   | 调用方式                                          | 回调触发 | 原因                        |
 *   |--------------------------------------------------|---------|----------------------------|
 *   | invoke() / stream() / batch() / generate()       | ✅      | 公开 API 层创建并 emit runManager |
 *   | 直接调 _generate()，handler 塞在 options.callbacks | ❌      | options.callbacks 不被消费（演示C）|
 *   注意：_generate 若"被公开 API 层调用"（如 invoke 内部），基类会在它返回后 emit handleLLMEnd；
 *         只有"手动直调且不传 runManager"才完全不触发（演示 C 的场景）。
 */
import 'dotenv/config';
import { ChatOpenAI } from '@langchain/openai';
import { tool }       from '@langchain/core/tools';
import { HumanMessage } from '@langchain/core/messages';
import { z }          from 'zod';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';

// ─── 1. 自定义回调处理器：在 handleLLMEnd 里统计 token ────────────
class TokenCounter extends BaseCallbackHandler {
  name = 'TokenCounter';
  /** 流式场景 token chunk 计数（只是演示回调触发，不精确） */
  newTokenCount = 0;

  /** 流式场景：每个 token 到达时触发（用于打字机/手动计数） */
  async handleLLMNewToken(_token: string) {
    this.newTokenCount += 1;
  }

  /** 非流式/流式结束：模型完整结果到达，含精确 token 用量 */
  async handleLLMEnd(output: LLMResult) {
    const usage = output.llmOutput?.tokenUsage as
      | { promptTokens?: number; completionTokens?: number; totalTokens?: number }
      | undefined;
    console.log('[handleLLMEnd] 统计到 token 用量:', {
      promptTokens:     usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      totalTokens:      usage?.totalTokens,
    });
  }

  /** 出错了也要能感知 */
  async handleLLMError(err: Error) {
    console.error('[handleLLMError]', err.message);
  }
}

// ─── 2. 一个普通模型（直接用 ChatOpenAI，不走 FailoverChatModel 的降级）───
const model = new ChatOpenAI({
  model:         process.env.PRIMARY_MODEL || 'deepseek-chat',
  apiKey:        process.env.PRIMARY_API_KEY,
  configuration: { baseURL: process.env.PRIMARY_BASE_URL },
  temperature:   0.3,
});

// ─── 3. RunnableBinding 是怎么来的 ────────────────────────────────
//  bindTools()：绑定工具 → 返回 RunnableBinding（函数调用场景）
const orderTool = tool(
  async ({ orderId }) => JSON.stringify({ orderId, status: '已发货' }),
  {
    name:        'getOrderInfo',
    description: '根据订单号查询订单详情',
    schema:      z.object({ orderId: z.string() }),
  },
);
const boundWithTool = model.bindTools([orderTool]); // ← RunnableBinding
//  bindTools() 返回的 RunnableBinding，用 config 也能固定参数；这里直接演示流式用原始 model
//  pipe()：LCEL 串联 → 返回 RunnableSequence（内部 step 仍是 Runnable，回调逐层传播）

// ─── 4. 演示 A：通过 RunnableBinding 非流式调用，callbacks 放 options ──
async function demoNonStreaming() {
  console.log('\n===== 演示A：RunnableBinding(bindTools) + invoke + callbacks =====');
  const handler = new TokenCounter();
  const res = await boundWithTool.invoke(
    '查一下订单 ORD-001 的状态',
    { callbacks: [handler] }, // ← callbacks 从这里传进去，会透传到底层模型
  );
  console.log('工具调用结果:', JSON.stringify(res.tool_calls?.[0]?.args));
}

// ─── 5. 演示 B：流式调用，handleLLMNewToken 逐 token 触发 ───────────
async function demoStreaming() {
  console.log('\n===== 演示B：流式 + handleLLMNewToken + handleLLMEnd =====');
  const handler = new TokenCounter();
  const stream = await model.stream(
    '用一句话介绍你自己',
    { callbacks: [handler] },
  );
  let full = '';
  for await (const chunk of stream) {
    full += typeof chunk.content === 'string' ? chunk.content : '';
  }
  console.log(`[demo] handleLLMNewToken 触发 ${handler.newTokenCount} 次，最终内容: "${full}"`);
}

// ─── 6. 演示 C：验证"直接调 _generate 回调不生效"的对比 ─────────────
async function demoDirectGenerate() {
  console.log('\n===== 演示C：直接调 _generate（模拟 FailoverChatModel 的做法）=====');
  const handler = new TokenCounter();
  // 直接调底层 _generate，把 handler 塞进 options.callbacks —— 不会被消费
  await (model as any)._generate(
    [new HumanMessage('你好')],
    { callbacks: [handler] } as any,
    undefined,
  );
  console.log('[demo] 若上方没有 [handleLLMEnd] 输出，说明 callbacks 未被消费（正是项目里的坑）');
}

const main = async () => {
  await demoNonStreaming();
  await demoStreaming();
  await demoDirectGenerate();
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
