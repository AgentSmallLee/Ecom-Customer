// server/src/graphs/customer-graph.ts
import { StateGraph, START, END }          from '@langchain/langgraph';
import type { BaseCheckpointSaver }        from '@langchain/langgraph-checkpoint';
import { GraphState }                      from './state.ts';
import { intentRouterNode, routeByIntent } from './nodes/intent-router.ts';
import { orderAgentNode }                  from './nodes/order-agent.ts';
import { ragNode }                         from './nodes/rag-node.ts';
import { generalChatNode }                  from './nodes/general-chat.ts';
import { answerSynthesizerNode }           from './nodes/answer-synthesizer.ts';
import { recallMemoriesNode }               from './nodes/recall-memories.ts';
import { summarizeNode, shouldSummarize }  from './nodes/summarize.ts';

/**
 * 构建客服工作流图
 * @param checkpointer - 会话持久化（短期记忆，按 thread_id 隔离）
 *
 * 注：长期记忆（PostgresStore）的写入已从工作流中移出，改为 graph.service.ts
 *     中的异步副作用（fire-and-forget），避免阻塞用户收到最终答案。
 *     记忆召回（recallMemoriesNode）仍在图内，因为后续节点依赖它。
 */
export const buildCustomerGraph = (checkpointer?: BaseCheckpointSaver) => {
  const graph = new StateGraph(GraphState)
    .addNode('recallMemories',    recallMemoriesNode)
    .addNode('intentRouter',      intentRouterNode)
    .addNode('orderAgent',        orderAgentNode)
    .addNode('ragNode',           ragNode)
    .addNode('generalChat',       generalChatNode)
    .addNode('answerSynthesizer', answerSynthesizerNode)
    .addNode('summarize',         summarizeNode)

    .addEdge(START, 'recallMemories')
    .addEdge('recallMemories', 'intentRouter')

    .addConditionalEdges('intentRouter', routeByIntent, {
      orderAgent:  'orderAgent',
      ragNode:     'ragNode',
      generalChat: 'generalChat',
    })

    .addEdge('orderAgent',   'answerSynthesizer')
    .addEdge('ragNode',      'answerSynthesizer')
    .addEdge('generalChat',  'answerSynthesizer')

    // 超过阈值先压缩旧消息为摘要，否则直接结束
    // （长期记忆写入改为图结束后的异步副作用，不在此节点图中）
    .addConditionalEdges('answerSynthesizer', shouldSummarize, {
      summarize: 'summarize',
      end:       END,
    })
    .addEdge('summarize', END);

  return graph.compile({ checkpointer });
};
