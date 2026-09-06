// server/src/graphs/nodes/rag-node.ts
import { ragChain } from '../../chains/rag-chain.ts';
import type { GraphStateType } from '../state.ts';

export const ragNode = async (state: GraphStateType) => {
  const { userInput } = state;
  try {
    const result = await ragChain.invoke({ question: userInput });
    return { ragResult: result };
  } catch (err) {
    console.error('[ragNode]', err instanceof Error ? err.message : err);
    return { ragResult: '查询知识库时出错' };
  }
};
