// server/src/scripts/ingest.ts
// 文档入库脚本，执行一次即可，知识库更新时重新执行
// 运行：tsx src/scripts/ingest.ts

import { join, dirname, basename } from 'path';
import { fileURLToPath }           from 'url';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { PGVectorStore }           from '@langchain/community/vectorstores/pgvector';
import { DirectoryLoader }         from '@langchain/classic/document_loaders/fs/directory';
import { TextLoader }              from '@langchain/classic/document_loaders/fs/text';
import { embeddings }              from '../models/embedding.ts';
import { pool }                    from '../db/postgres.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 知识库目录（自动扫描该目录下所有 .md 文件，不用写死文件名）
const KNOWLEDGE_DIR = join(__dirname, '../data/knowledge');

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

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize:    100,
  chunkOverlap: 10,
});

const ingest = async () => {
  console.log('开始处理文档...');

  // 1. 用 DirectoryLoader 批量加载知识库目录下所有 .md 文件
  const loader = new DirectoryLoader(KNOWLEDGE_DIR, {
    '.md': (path) => new TextLoader(path),
  });
  const rawDocs = await loader.load();

  // 2. 归一化 metadata：source 只保留文件名（TextLoader 默认是完整路径）
  const docs = rawDocs.map((doc) => {
    const fileName = basename(doc.metadata.source);
    return {
      ...doc,
      metadata: {
        ...doc.metadata,
        source: fileName,
        // 从文件名推断分类，方便后续按分类过滤
        category: fileName.includes('product') ? 'product'
               : fileName.includes('policy')  ? 'policy'
               : 'other',
      },
    };
  });
  console.log(`加载完成，共 ${docs.length} 个文档：`);
  docs.forEach((doc) => console.log(`  - ${doc.metadata.source} [${doc.metadata.category}]`));

  // 2. 切分
  const chunks = await splitter.splitDocuments(docs);
  console.log(`切分完成，共 ${chunks.length} 个片段`);

  // 清空旧数据（全量更新场景）
  const client = await pool.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS knowledge_embeddings (
        id       bigserial PRIMARY KEY,
        content  text,
        metadata jsonb,
        embedding vector(1024)
      );`
    );
    await client.query('TRUNCATE knowledge_embeddings;');
  } finally {
    client.release();
  }

  await PGVectorStore.fromDocuments(chunks, embeddings, PG_CONFIG);

  console.log('入库完成');
  await pool.end();
};

ingest().catch((err) => {
  console.error('入库失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});
