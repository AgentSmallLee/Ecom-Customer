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
});

/** 图状态类型：所有节点函数的入参类型 */
export type GraphStateType = typeof GraphState.State;
