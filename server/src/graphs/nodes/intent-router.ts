// server/src/graphs/nodes/intent-router.ts
import { createModel }        from '../../models/model-factory.ts';
import { buildTraceConfig }    from '../../llm/trace-context.ts';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { formatMessagesAsText } from '../memory-context.ts';
import type { GraphStateType, Intent } from '../state.ts';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';

const intentPrompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    `你是一个意图分类器。

根据用户的问题，返回以下三个分类之一，只返回分类词，不要有任何其他内容：

- order：用户询问订单状态、物流信息、退款进度等需要查询订单数据的问题
- knowledge：用户询问商品介绍、规格参数、售后政策、退换货规则等可从知识库获取的问题
- general：其他类型的对话、闲聊、无法归类的问题

只输出一个词：order 或 knowledge 或 general`,
  ],
  ['human', '{userInput}'],
]);

// LCEL执行链
const chain = intentPrompt.pipe(createModel({ temperature: 0 })).pipe(new StringOutputParser());
// 有效的意图分类词
const VALID_INTENTS = ['order', 'knowledge', 'general'];
// 验证意图分类词是否有效，白名单校验
const isValidIntent = (s: string): s is Intent =>
  (VALID_INTENTS as string[]).includes(s);

// 节点函数
export const intentRouterNode = async (state: GraphStateType, config: LangGraphRunnableConfig) => {
  const { userInput, messages } = state;
  // 从 configurable 中取审计上下文（入口生成，全链路共享）
  const traceId  = config?.configurable?.traceId   as string | undefined;
  const userId   = config?.configurable?.user_id   as string | undefined;
  const threadId = config?.configurable?.thread_id as string | undefined;

  // 附带最近几轮对话，让"那它发货了吗"这类指代式追问也能正确分类，最大4轮
  const recentDialogue = formatMessagesAsText((messages || []).slice(0, -1), 4);
  // 把输入和最近的几轮对话合并，供模型理解
  const input = recentDialogue
    ? `${userInput}\n\n（最近对话，供理解指代参考）\n${recentDialogue}`
    : userInput;
  console.log('[intentRouter] 输入:', input);
  // 审计上下文 + LangSmith metadata 统一由 buildTraceConfig 生成
  // （metadata 供 LangSmith 按用户/会话筛选；模型侧仍读顶层字段，两者都在同一个 config 里）
  const raw    = await chain.invoke(
    { userInput: input },
    // invoke的第二个参数是RunnableConfig
    buildTraceConfig('graph-intent-router', { traceId, userId, threadId }) as any
  );
  const intent = raw.trim().toLowerCase();
  const final  = isValidIntent(intent) ? intent : 'general';
  console.log(`[intentRouter] "${userInput}" → ${final}`);
  // 返回值即状态更新：LangGraph 会把 { intent } 按 intent channel 的 reducer 合并进 state，
  // 条件边 routeByIntent 在节点返回后才执行，读取到的就是更新后的 state.intent
  return { intent: final };
};

type RouteTarget = 'orderAgent' | 'ragNode' | 'generalChat';

const ROUTE_MAP: Record<Intent, RouteTarget> = {
  order:    'orderAgent',
  knowledge: 'ragNode',
  general:  'generalChat',
};

// 路由函数，根据意图分类词选择目标节点名称，返回的是节点名称
export const routeByIntent = (state: GraphStateType): RouteTarget =>
  ROUTE_MAP[state.intent] || 'generalChat';
