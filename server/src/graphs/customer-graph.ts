// server/src/graphs/customer-graph.ts
import { StateGraph, START, END }          from '@langchain/langgraph';
import { GraphState }                      from './state.ts';
import { intentRouterNode, routeByIntent } from './nodes/intent-router.ts';
import { orderAgentNode }                  from './nodes/order-agent.ts';
import { ragNode }                         from './nodes/rag-node.ts';
import { generalChatNode }                  from './nodes/general-chat.ts';
import { answerSynthesizerNode }           from './nodes/answer-synthesizer.ts';

export const buildCustomerGraph = () => {
  const graph = new StateGraph(GraphState)
    .addNode('intentRouter',      intentRouterNode)
    .addNode('orderAgent',        orderAgentNode)
    .addNode('ragNode',           ragNode)
    .addNode('generalChat',       generalChatNode)
    .addNode('answerSynthesizer', answerSynthesizerNode)

    .addEdge(START, 'intentRouter')

    .addConditionalEdges('intentRouter', routeByIntent, {
      orderAgent:  'orderAgent',
      ragNode:     'ragNode',
      generalChat: 'generalChat',
    })

    .addEdge('orderAgent',   'answerSynthesizer')
    .addEdge('ragNode',      'answerSynthesizer')
    .addEdge('generalChat',  'answerSynthesizer')
    .addEdge('answerSynthesizer', END);

  return graph.compile();
};
