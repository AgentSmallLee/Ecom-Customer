// server/src/scripts/ingest.ts
// 文档入库脚本，支持增量更新（默认）和全量更新（--full）
//
// 运行方式：
//   pnpm run ingest           # 增量更新（只处理有变更的文件，默认）
//   pnpm run ingest --full    # 全量更新（清空后重新写入所有文档）
//
// 增量更新原理：
//   1. 扫描知识库目录下所有 .md 文件，读取每个文件的 mtime
//   2. 对比数据库中该文档的 last_ingested_at
//   3. 文件有变更 → 先删旧 chunk，再切分写入新 chunk
//   4. 文件已删除 → 从数据库中删除该文档的所有 chunk
//   5. 文件无变更 → 跳过

import { join, dirname, basename } from 'path';
import { readdir, stat } from 'fs/promises';
import { fileURLToPath }           from 'url';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { PGVectorStore }           from '@langchain/community/vectorstores/pgvector';
import { Document }                from '@langchain/core/documents';
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

// 解析命令行参数
const isFullUpdate = process.argv.includes('--full');

/**
 * 确保表结构存在（幂等，可重复执行）
 */
async function ensureSchema(client: any) {
  // 启用 pg_trgm 扩展（用于中文关键词检索，无需分词）
  await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm;');

  await client.query(
    `CREATE TABLE IF NOT EXISTS knowledge_embeddings (
      id           bigserial PRIMARY KEY,
      content      text,
      metadata     jsonb,
      embedding    vector(1024),
      content_tsv  tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
    );`
  );

  // pg_trgm GIN 索引（加速关键词模糊匹配）
  await client.query(
    `CREATE INDEX IF NOT EXISTS knowledge_embeddings_content_trgm_idx
     ON knowledge_embeddings USING GIN (content gin_trgm_ops);`
  );
  // 全文检索 GIN 索引（保留，备用）
  await client.query(
    `CREATE INDEX IF NOT EXISTS knowledge_embeddings_tsv_idx
     ON knowledge_embeddings USING GIN (content_tsv);`
  );
  // 向量 HNSW 索引（加速余弦相似度检索，数据量大时效果明显）
  await client.query(
    `CREATE INDEX IF NOT EXISTS knowledge_embeddings_embedding_idx
     ON knowledge_embeddings
     USING hnsw (embedding vector_cosine_ops);`
  );
  // metadata 上的 GIN 索引（加速按 source/docId 过滤删除，增量更新必备）
  await client.query(
    `CREATE INDEX IF NOT EXISTS knowledge_embeddings_metadata_idx
     ON knowledge_embeddings USING GIN (metadata);`
  );
}

/**
 * 扫描知识库目录，返回 { 文件名: mtime } 映射
 */
async function scanKnowledgeDir(): Promise<Map<string, Date>> {
  const files = await readdir(KNOWLEDGE_DIR);
  const mdFiles = files.filter(f => f.endsWith('.md'));
  const result = new Map<string, Date>();

  for (const file of mdFiles) {
    const stats = await stat(join(KNOWLEDGE_DIR, file));
    // 文件最后修改时间（单位：毫秒）
    result.set(file, stats.mtime);
  }
  return result;
}

/**
 * 从数据库中查询所有已入库的文档及其最后入库时间
 * 从每个 chunk 的 metadata 里的 last_ingested_at 取最大值
 * 没有 last_ingested_at 的老数据，认为是 epoch（永远比文件 mtime 旧，会触发更新）
 */
async function getIngestedDocs(client: any): Promise<Map<string, Date>> {
  const { rows } = await client.query(`
    SELECT metadata->>'source' AS source,
           MAX(COALESCE((metadata->>'last_ingested_at')::timestamptz, '1970-01-01'::timestamptz)) AS last_ingested_at
    FROM knowledge_embeddings
    WHERE metadata ? 'source'
    GROUP BY metadata->>'source'
  `);

  const result = new Map<string, Date>();
  for (const row of rows) {
    if (row.source && row.last_ingested_at) {
      result.set(row.source, new Date(row.last_ingested_at));
    }
  }
  return result;
}

/**
 * 按 source（文件名）删除该文档的所有 chunk
 */
async function deleteDocBySource(vectorStore: PGVectorStore, source: string) {
  // LangChain PGVectorStore 的 delete 支持 filter 过滤 metadata
  await vectorStore.delete({ filter: { source } });
}

/**
 * 加载单个文件，切分，打上 metadata，返回 chunks
 */
async function loadAndSplitFile(fileName: string, ingestedAt: Date): Promise<Document[]> {
  const filePath = join(KNOWLEDGE_DIR, fileName);
  const loader = new TextLoader(filePath);
  const rawDocs = await loader.load();

  const docs = rawDocs.map((doc) => {
    const category = fileName.includes('product') ? 'product'
                  : fileName.includes('policy')  ? 'policy'
                  : 'other';
    return new Document({
      pageContent: doc.pageContent,
      metadata: {
        ...doc.metadata,
        source: fileName,
        category,
        last_ingested_at: ingestedAt.toISOString(),
      },
    });
  });

  return splitter.splitDocuments(docs);
}

const ingest = async () => {
  console.log(`\n📚 知识库入库模式：${isFullUpdate ? '全量更新' : '增量更新'}\n`);

  const client = await pool.connect();
  try {
    // 1. 确保表结构和索引存在
    await ensureSchema(client);

    const vectorStore = await PGVectorStore.initialize(embeddings, PG_CONFIG);
    const now = new Date();

    if (isFullUpdate) {
      // ── 全量更新：清空后重新写入所有文档 ──
      console.log('🔄 全量更新：清空旧数据...');
      await client.query('TRUNCATE knowledge_embeddings;');

      // 加载所有文档
      const loader = new DirectoryLoader(KNOWLEDGE_DIR, {
        '.md': (path) => new TextLoader(path),
      });
      const rawDocs = await loader.load();

      // 归一化 metadata
      const docs = rawDocs.map((doc) => {
        const fileName = basename(doc.metadata.source);
        const category = fileName.includes('product') ? 'product'
                       : fileName.includes('policy')  ? 'policy'
                       : 'other';
        return new Document({
          ...doc,
          metadata: {
            ...doc.metadata,
            source: fileName,
            category,
            last_ingested_at: now.toISOString(),
          },
        });
      });

      console.log(`  共 ${docs.length} 个文档，开始切分...`);
      const chunks = await splitter.splitDocuments(docs);
      console.log(`  切分完成，共 ${chunks.length} 个片段`);

      await PGVectorStore.fromDocuments(chunks, embeddings, PG_CONFIG);
      console.log('✅ 全量入库完成');

    } else {
      // ── 增量更新：只处理有变更的文件 ──
      const [fileMap, ingestedMap] = await Promise.all([
        scanKnowledgeDir(),
        getIngestedDocs(client),
      ]);

      const fileNames   = Array.from(fileMap.keys());
      const ingestedNames = Array.from(ingestedMap.keys());

      // 找出：新增 / 修改 / 删除 的文件
      const added:   string[] = [];
      const updated: string[] = [];
      const deleted: string[] = [];
      const skipped: string[] = [];

      for (const fileName of fileNames) {
        const fileMtime = fileMap.get(fileName)!;
        const lastIngested = ingestedMap.get(fileName);

        if (!lastIngested) {
          added.push(fileName);
        } else if (fileMtime > lastIngested) {
          updated.push(fileName);
        } else {
          skipped.push(fileName);
        }
      }

      for (const fileName of ingestedNames) {
        if (!fileMap.has(fileName)) {
          deleted.push(fileName);
        }
      }

      // 打印变更统计
      console.log('📊 变更统计：');
      console.log(`  新增：${added.length} 个${added.length ? ' → ' + added.join(', ') : ''}`);
      console.log(`  修改：${updated.length} 个${updated.length ? ' → ' + updated.join(', ') : ''}`);
      console.log(`  删除：${deleted.length} 个${deleted.length ? ' → ' + deleted.join(', ') : ''}`);
      console.log(`  跳过：${skipped.length} 个\n`);

      if (added.length === 0 && updated.length === 0 && deleted.length === 0) {
        console.log('🎉 没有变更，无需更新');
        return;
      }

      // 处理删除的文档
      for (const fileName of deleted) {
        console.log(`  🗑️  删除：${fileName}`);
        await deleteDocBySource(vectorStore, fileName);
      }

      // 处理新增和修改的文档（修改 = 先删旧，再插新）
      const toProcess = [...added, ...updated];
      let totalChunks = 0;

      for (const fileName of toProcess) {
        const isNew = added.includes(fileName);
        console.log(`  ${isNew ? '➕ 新增' : '✏️  修改'}：${fileName}`);

        // 修改的文档先删旧的
        if (!isNew) {
          await deleteDocBySource(vectorStore, fileName);
        }

        // 加载 + 切分 + 写入
        const chunks = await loadAndSplitFile(fileName, now);
        await vectorStore.addDocuments(chunks);
        totalChunks += chunks.length;
        console.log(`     → ${chunks.length} 个片段入库`);
      }

      console.log(`\n✅ 增量入库完成，共处理 ${toProcess.length} 个文档，${totalChunks} 个片段`);
    }

  } finally {
    client.release();
  }

  await pool.end();
};

ingest().catch((err) => {
  console.error('❌ 入库失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});
