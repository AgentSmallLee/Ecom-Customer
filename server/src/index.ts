// server/src/index.ts
import express     from 'express';
import cors        from 'cors';
import 'dotenv/config';
import chatRouter  from './routes/chat.ts';
import agentRouter from './routes/agent.ts';
import ragRouter   from './routes/rag.ts';
import graphRouter from './routes/graph.ts';

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/api/chat',  chatRouter);
app.use('/api/agent', agentRouter);
app.use('/api/rag',   ragRouter);
app.use('/api/graph', graphRouter);

app.get('/', (_req, res) => {
  res.json({
    service: '红松心选 AI 客服系统',
    version: '1.0.0',
    routes: {
      chat:  'POST /api/chat/stream',
      agent: 'POST /api/agent/stream',
      rag:   'POST /api/rag/query',
      graph: 'POST /api/graph/stream',
    },
  });
});

app.listen(PORT, () => {
  console.log(`\n红松心选 AI 客服服务已启动：http://localhost:${PORT}\n`);
});
