// server/src/chains/rag-chain.ts
import { RunnableSequence, RunnablePassthrough } from '@langchain/core/runnables';
import { StringOutputParser }  from '@langchain/core/output_parsers';
import { ChatPromptTemplate }  from '@langchain/core/prompts';
import { PGVectorStore }       from '@langchain/community/vectorstores/pgvector';
import { createModel }         from '../models/deepseek.ts';
import { embeddings }          from '../models/embedding.ts';
import { pool }                from '../db/postgres.ts';

const PG_CONFIG = {
  pool,
  tableName: 'knowledge_embeddings',
  columns: {
    idColumnName:       'id',
    vectorColumnName:   'embedding',
    contentColumnName:  'content',
    metadataColumnName: 'metadata',
  },
};

// 初始化 VectorStore（模块加载时执行一次）
const vectorStore = await PGVectorStore.initialize(embeddings, PG_CONFIG);
// 创建检索器，用于从向量存储中检索最相关的文档
const retriever = vectorStore.asRetriever({ k: 4 });

const ragPrompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    `你是红松心选电商平台的专业客服助手小购。

请根据以下知识库内容回答用户的问题。
如果知识库中没有相关内容，请如实告知用户，不要编造信息。
回答语气友好，称呼用户为"亲"，回复简洁清晰。

知识库内容：
{context}`,
  ],
  ['human', '{question}'],
]);

const formatDocs = (docs: { pageContent: string }[]) =>
  docs.map((doc) => doc.pageContent).join('\n\n---\n\n');

// 创建模型实例，用于生成回复
const model = createModel({ temperature: 0 });

// 流式模型实例，用于 SSE 流式输出
const streamingModel = createModel({ temperature: 0, streaming: true });

// 标准 RAG Chain LCEL结合并行分支
export const ragChain = RunnableSequence.from([
  {
    context:  (input: { question: string }) => retriever.pipe(formatDocs).invoke(input.question),
    question: (input: { question: string }) => input.question,
  },
  ragPrompt,
  model,
  new StringOutputParser(),
]);

// 带来源信息的 RAG Chain
// retriever.invoke(input.question) 从向量存储中检索最相关的文档，返回Document数组
// formatDocs(input.docs) 格式化文档内容，返回字符串
// ragChainWithSources 接收一个 { question: string } 输入，最终输出 { answer: string, sources: Array 
// }——既有回答，又有回答依据的文档来源。
export const ragChainWithSources = RunnableSequence.from([
  // RunnablePassthrough.assign的作用是把输入的question透传到输入question到输出
  RunnablePassthrough.assign({ docs: (input: { question: string }) => retriever.invoke(input.question) }),
  {
    answer: RunnableSequence.from([
      (input: { docs: { pageContent: string }[]; question: string }) => ({
        context:  formatDocs(input.docs),
        question: input.question,
      }),
      ragPrompt,
      streamingModel,
      new StringOutputParser(),
    ]),
    sources: (input: { docs: { pageContent: string; metadata: { source: string } }[] }) =>
      // input是document数组，每个document有pageContent和metadata，metadata有source字段
      input.docs.map((doc) => ({
        content: doc.pageContent.slice(0, 100) + '...',
        source:  doc.metadata.source,
      })),
  },
]);
