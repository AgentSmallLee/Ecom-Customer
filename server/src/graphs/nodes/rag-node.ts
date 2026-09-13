// server/src/graphs/nodes/rag-node.ts
// RAG 知识库检索节点：先做问题改写（结合历史对话把指代/省略补全），再检索
import { ChatPromptTemplate }  from '@langchain/core/prompts';
import { StringOutputParser }  from '@langchain/core/output_parsers';
import { ragChain }            from '../../chains/rag-chain.ts';
import { createModel }         from '../../models/model-factory.ts';
import { buildTraceConfig }    from '../../llm/trace-context.ts';
import { buildMemoryContext }  from '../memory-context.ts';
import { formatMessagesAsText } from '../memory-context.ts';
import type { GraphStateType } from '../state.ts';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';

// 问题改写的 LLM chain：把带指代/省略的问题改写成独立完整的检索问题
const rewritePrompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    `你是电商客服场景的问题改写助手。
根据"对话上下文"和"当前问题"，把用户的当前问题改写成一个独立、完整的检索问题。
要求：
- 补全省略的主语、指代（如"它"、"这个"、"那个"、"那"）
- 如果上下文里有相关信息，结合上下文补全问题
- 如果当前问题本身就很完整独立，不需要改写，原样返回即可
- 只返回改写后的问题文本，不要任何前缀、解释或标点后缀`,
  ],
  [
    'human',
    `对话上下文：
{context}

当前问题：
{question}

请改写为独立完整的检索问题：`,
  ],
]);

const rewriteChain = rewritePrompt
  .pipe(createModel({ temperature: 0 }))
  .pipe(new StringOutputParser());

export const ragNode = async (state: GraphStateType, config: LangGraphRunnableConfig) => {
  const { userInput, messages = [] } = state;
  // 从 configurable 中取审计上下文（入口生成，全链路共享）
  const traceId  = config?.configurable?.traceId   as string | undefined;
  const userId   = config?.configurable?.user_id   as string | undefined;
  const threadId = config?.configurable?.thread_id as string | undefined;
  // 审计上下文 + LangSmith metadata 统一由 buildTraceConfig 生成
  const callOpts = (source: string) => buildTraceConfig(source, { traceId, userId, threadId }) as any;

  try {
    // ── 1. 组装上下文（最近几轮对话 + 摘要 + 长期记忆） ──
    const recentDialogue = formatMessagesAsText(messages.slice(0, -1), 6);
    const memoryContext  = buildMemoryContext(state);
    const contextParts   = [memoryContext, recentDialogue].filter(Boolean);

    let searchQuery = userInput;

    // ── 2. 有上下文时才做改写，单轮对话直接用原问题 ──
    if (contextParts.length > 0) {
      try {
        searchQuery = await rewriteChain.invoke(
          {
            context:  contextParts.join('\n\n'),
            question: userInput,
          },
          callOpts('graph-rag-rewrite')
        );
        // 简单兜底：如果改写结果为空，回退到原问题
        if (!searchQuery.trim()) searchQuery = userInput;
      } catch (rewriteErr) {
        // 改写失败不阻断检索，用原问题继续
        console.warn('[ragNode] 问题改写失败，使用原问题:', rewriteErr instanceof Error ? rewriteErr.message : rewriteErr);
        searchQuery = userInput;
      }
    }

    if (searchQuery !== userInput) {
      console.log(`[ragNode] 问题改写："${userInput}" → "${searchQuery}"`);
    }

    // ── 3. 用改写后的问题检索 ──
    const result = await ragChain.invoke(
      { question: searchQuery },
      callOpts('graph-rag-chain')
    );
    console.log(`[ragNode] 检索结果：${result}`);
    return { ragResult: result };
  } catch (err) {
    console.error('[ragNode]', err instanceof Error ? err.message : err);
    return { ragResult: '查询商品信息时出错' };
  }
};
