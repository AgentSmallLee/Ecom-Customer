// server/src/graphs/customer-graph.ts
import { StateGraph, START, END }          from '@langchain/langgraph';
import type { BaseCheckpointSaver }        from '@langchain/langgraph-checkpoint';
import type { BaseStore }                  from '@langchain/langgraph-checkpoint';
import { GraphState }                      from './state.ts';
import { intentRouterNode, routeByIntent } from './nodes/intent-router.ts';
import { orderAgentNode }                  from './nodes/order-agent.ts';
import { ragNode }                         from './nodes/rag-node.ts';
import { generalChatNode }                  from './nodes/general-chat.ts';
import { answerSynthesizerNode }           from './nodes/answer-synthesizer.ts';
import { recallMemoriesNode }               from './nodes/recall-memories.ts';
import { summarizeNode, shouldSummarize }  from './nodes/summarize.ts';
import { memoryWriterNode }                from './nodes/memory-writer.ts';

/**
 * 构建客服工作流图
 * @param checkpointer - 会话持久化（短期记忆，按 thread_id 隔离）
 * @param store        - 跨会话长期记忆（按用户命名空间隔离）
 */
export const buildCustomerGraph = (
  checkpointer?: BaseCheckpointSaver,
  store?: BaseStore
) => {
  const graph = new StateGraph(GraphState)
    .addNode('recallMemories',   recallMemoriesNode)
    .addNode('intentRouter',     intentRouterNode)
    .addNode('orderAgent',       orderAgentNode)
    .addNode('ragNode',          ragNode)
    .addNode('generalChat',      generalChatNode)
    .addNode('answerSynthesizer', answerSynthesizerNode)
    .addNode('summarize',        summarizeNode)
    .addNode('memoryWriter',     memoryWriterNode)

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

    // 超过阈值先压缩旧消息为摘要，再写长期记忆
    .addConditionalEdges('answerSynthesizer', shouldSummarize, {
      summarize:    'summarize',
      memoryWriter: 'memoryWriter',
    })
    .addEdge('summarize', 'memoryWriter')
    .addEdge('memoryWriter', END);

  return graph.compile({ checkpointer, store });
};
