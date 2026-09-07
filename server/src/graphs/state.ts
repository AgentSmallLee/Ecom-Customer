// server/src/graphs/state.ts
import { Annotation, MessagesAnnotation } from '@langchain/langgraph';

/** 意图分类：订单查询 | 知识库问答 | 通用对话 */
export type Intent = 'order' | 'knowledge' | 'general';

/** 一条工具调用步骤 */
export interface ToolStep {
  tool:  string;
  input: unknown;
  obs:   string;
}

/** orderAgent 节点的查询结果 */
export interface OrderResult {
  answer: string;
  steps:  ToolStep[];
}

export const GraphState = Annotation.Root({
  ...MessagesAnnotation.spec,

  userInput: Annotation<string>({
    reducer: (_, next) => next,
    default: () => '',
  }),

  intent: Annotation<Intent>({
    reducer: (_, next) => next,
    default: () => 'general',
  }),

  orderResult: Annotation<OrderResult | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  ragResult: Annotation<string>({
    reducer: (_, next) => next,
    default: () => '',
  }),

  finalAnswer: Annotation<string>({
    reducer: (_, next) => next,
    default: () => '',
  }),

  /** 历史对话的 LLM 压缩摘要（长度控制：旧消息删除后以摘要形式保留上下文） */
  summary: Annotation<string>({
    reducer: (_, next) => next,
    default: () => '',
  }),

  /** 本轮从长期记忆（Store）召回的用户偏好列表 */
  userMemories: Annotation<string[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),
});

/** 图状态类型：所有节点函数的入参类型 */
export type GraphStateType = typeof GraphState.State;
