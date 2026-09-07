// server/src/scripts/init-db.ts
// 数据库初始化脚本 — 第一次部署时执行一次即可（幂等，可重复执行）
//
// 运行方式（任选其一，推荐用 pnpm 脚本）：
//   pnpm run init-db          ← 推荐，package.json 中已配置
//   pnpm exec tsx src/scripts/init-db.ts
//   npx tsx src/scripts/init-db.ts
//
// 注意：不要直接执行 tsx src/scripts/init-db.ts，因为 tsx 是项目 devDependency，
//       没有全局安装，直接敲命令会提示 "tsx: command not found"。
//
// 前置条件：
//   1. PostgreSQL 服务已启动
//   2. 已安装 pgvector 扩展（macOS: brew install pgvector）
//   3. .env 中 PG_HOST / PG_PORT / PG_USER / PG_PASSWORD / PG_DATABASE 配置正确
//
// 功能：
//   1. 连接到默认 postgres 库，检查目标数据库是否存在，不存在则创建
//   2. 切换到目标数据库，启用 pgvector 扩展
//   3. 创建 knowledge_embeddings 表（IF NOT EXISTS，幂等）
//   4. 初始化 LangGraph 记忆表：checkpoint（短期记忆）+ store（长期记忆）

import pg from 'pg';
import 'dotenv/config';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { PostgresStore } from '@langchain/langgraph-checkpoint-postgres/store';

const { Pool } = pg;

const PG_HOST     = process.env.PG_HOST     || 'localhost';
const PG_PORT     = parseInt(process.env.PG_PORT || '5432');
const PG_USER     = process.env.PG_USER     || 'mac';
const PG_PASSWORD = process.env.PG_PASSWORD || '';
const PG_DATABASE = process.env.PG_DATABASE || 'ecom_ai';

// 连接到默认的 postgres 数据库（用于创建目标库）
const adminPool = new pg.Pool({
  host:     PG_HOST,
  port:     PG_PORT,
  user:     PG_USER,
  password: PG_PASSWORD,
  database: 'postgres'
});

const init = async () => {
  console.log(`[1/3] 检查数据库 "${PG_DATABASE}" ...`);

  const adminClient = await adminPool.connect();
  try {
    const res = await adminClient.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [PG_DATABASE]
    );

    if (res.rows.length === 0) {
      console.log(`  数据库不存在，正在创建...`);
      // CREATE DATABASE 不能用参数化查询，这里直接拼接（变量来自 .env，可信）
      await adminClient.query(`CREATE DATABASE "${PG_DATABASE}"`);
      console.log(`  ✅ 数据库 "${PG_DATABASE}" 创建成功`);
    } else {
      console.log(`  ✅ 数据库已存在，跳过创建`);
    }
  } finally {
    adminClient.release();
    await adminPool.end();
  }

  // ── 连接到目标数据库，启用扩展 + 建表 ──
  console.log(`[2/3] 启用 pgvector 扩展 ...`);

  const dbPool = new pg.Pool({
    host:     PG_HOST,
    port:     PG_PORT,
    user:     PG_USER,
    password: PG_PASSWORD,
    database: PG_DATABASE,
  });

  const client = await dbPool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector;');
    console.log('  ✅ pgvector 扩展已就绪');

    console.log(`[3/4] 创建 knowledge_embeddings 表 ...`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS knowledge_embeddings (
        id       bigserial PRIMARY KEY,
        content  text,
        metadata jsonb,
        embedding vector(1024)
      );
    `);
    console.log('  ✅ 表已就绪');
  } finally {
    client.release();
  }

  // ── LangGraph 记忆表 ──
  console.log(`[4/4] 初始化 LangGraph 记忆表（checkpointer + store）...`);

  // 短期记忆：会话 checkpoint（共享 dbPool，不要调用 end()）
  const saver = new PostgresSaver(dbPool);
  await saver.setup();
  console.log('  ✅ checkpoint 表已就绪（checkpoints / checkpoint_blobs / checkpoint_writes）');

  // 长期记忆：跨会话用户偏好（自建连接池，用完关闭）
  const connString = `postgres://${encodeURIComponent(PG_USER)}:${encodeURIComponent(PG_PASSWORD)}@${PG_HOST}:${PG_PORT}/${PG_DATABASE}`;
  const store = await PostgresStore.fromConnString(connString);
  try {
    await store.setup();
    console.log('  ✅ store 表已就绪（store / store_vectors）');
  } finally {
    await store.stop();
  }

  await dbPool.end();
  console.log('\n🎉 数据库初始化完成！接下来可以执行 npm run ingest');
};

init().catch((err) => {
  const e = err as NodeJS.ErrnoException;
  console.error('\n❌ 初始化失败：', e.message);
  if (e.code === '28P01') {
    console.error('   → 用户名或密码错误，请检查 .env 中的 PG_USER / PG_PASSWORD');
  } else if (e.code === 'ECONNREFUSED') {
    console.error('   → 无法连接到 PostgreSQL，请确认服务是否启动且地址/端口是否正确');
  } else if (e.code === '42501') {
    console.error('   → 权限不足：当前用户没有 CREATEDB 权限，请使用超级用户或赋予 CREATEDB 角色');
  } else if (e.code === '58P01' || e.message?.includes('vector')) {
    console.error('   → pgvector 扩展未安装，请先安装 pgvector（macOS: brew install pgvector）');
  }
  process.exit(1);
});
