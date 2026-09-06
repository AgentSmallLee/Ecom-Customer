// server/src/routes/graph.ts
import express                from 'express';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { buildCustomerGraph } from '../graphs/customer-graph.ts';
import type { ChatMessage } from '../chains/basic-chat.ts';
import type { GraphStateType } from '../graphs/state.ts';

const router = express.Router();

type CompiledGraph = ReturnType<typeof buildCustomerGraph>;

let graph: CompiledGraph | null = null;
const getGraph = (): CompiledGraph => {
  if (!graph) graph = buildCustomerGraph();
  return graph;
};

router.post('/stream', async (req, res) => {
  const { message, history = [] } = req.body as { message?: string; history?: ChatMessage[] };

  if (!message) return res.status(400).json({ error: 'message 不能为空' });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (type: string, data: Record<string, unknown>) =>
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  try {
    const g = getGraph();

    const historyMessages = history.map((m) =>
      m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)
    );

    const stream = await g.stream(
      {
        userInput: message,
        messages:  [...historyMessages, new HumanMessage(message)],
      },
      { streamMode: 'updates' }
    );

    for await (const update of stream) {
      const [nodeName, nodeState] = Object.entries(update as Record<string, Partial<GraphStateType>>)[0]!;
      if (!nodeName) continue;

      send('node', { node: nodeName, intent: nodeState?.intent || null });

      if (nodeState?.orderResult?.steps?.length) {
        send('steps', { steps: nodeState.orderResult.steps });
      }

      if (nodeState?.finalAnswer) {
        send('answer', { content: nodeState.finalAnswer });
      }
    }

    send('done', {});
    res.end();
  } catch (err) {
    console.error('[Graph Error]', err instanceof Error ? err.message : err);
    send('error', { content: '处理请求时出错，请重试' });
    res.end();
  }
});

export default router;
