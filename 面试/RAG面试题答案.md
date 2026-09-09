# RAG 面试题答案

> 基于本项目（电商AI客服）的真实实现，结合企业级实践整理。

---

## 目录

1. [RAG 需要的表是什么时候创建的？](#1-rag-需要的表是什么时候创建的)
2. [文档是什么时候切分、向量化、入库的？](#2-文档是什么时候切分向量化入库的)
3. [知识库如果需要更新，你们是怎么做的？](#3-知识库如果需要更新你们是怎么做的)
4. [真实企业项目中，也是部署时建表，然后切分向量化入库吗？](#4-真实企业项目中也是部署时建表然后切分向量化入库吗)
5. [PGVectorStore.fromDocuments() 都做了什么？](#5-pgvectorstorefromdocuments-都做了什么)
6. [表的字段是固定的吗？](#6-表的字段是固定的吗)

---

## 1. RAG 需要的表是什么时候创建的？

### 项目现状

RAG 的向量表是通过**独立的数据库初始化脚本**在项目首次部署时创建的，不是应用启动时自动建的。

- **脚本位置**：`server/src/scripts/init-db.ts`
- **执行方式**：`pnpm run init-db`
- **执行时机**：第一次部署时手动执行一次，脚本是幂等的（`IF NOT EXISTS`），可重复执行

### 建表的完整流程

1. 连接到默认的 `postgres` 数据库，检查目标数据库（`ecom_ai`）是否存在，不存在则创建
2. 切换到目标数据库，启用 **pgvector** 扩展（`CREATE EXTENSION IF NOT EXISTS vector`）
3. 创建 `knowledge_embeddings` 表：
   ```sql
   CREATE TABLE IF NOT EXISTS knowledge_embeddings (
     id       bigserial PRIMARY KEY,
     content  text,
     metadata jsonb,
     embedding vector(1024)
   );
   ```
4. 初始化 LangGraph 记忆表：
   - 短期记忆：`checkpoints` / `checkpoint_blobs` / `checkpoint_writes`（会话 checkpoint）
   - 长期记忆：`store` / `store_vectors`（跨会话用户偏好）

### 为什么不放在应用启动时自动建？

- 建库需要 CREATEDB 权限，pgvector 扩展需要超级用户权限，应用运行时用的是普通用户
- 数据库初始化属于运维操作，和业务代码解耦更清晰
- 多实例部署时并发建表可能出问题
- 幂等脚本方便 CI/CD 流水线调用

### 生产环境的做法

生产环境一般用**数据库迁移工具**管理 schema，比如 Flyway、Liquibase、Prisma Migrate，建表 SQL 作为迁移脚本版本化管理，发版时自动执行。

---

## 2. 文档是什么时候切分、向量化、入库的？

### 项目现状

文档的切分、向量化、入库是通过**独立的离线入库脚本**批量完成的，属于**离线预处理**流程。

- **脚本位置**：`server/src/scripts/ingest.ts`
- **执行方式**：`pnpm run ingest`
- **执行时机**：首次部署时（`init-db` 之后）执行一次，知识库更新时重新执行

### 完整流程

```
加载文档 → 文档切分 → 清空旧数据 → 向量化 + 入库
```

1. **加载文档**：从 `server/src/data/knowledge/` 读取 `products.md` 和 `policies.md`
2. **文档切分**：用 LangChain 的 `RecursiveCharacterTextSplitter`
   - `chunkSize: 500`（每个片段约500字符）
   - `chunkOverlap: 50`（相邻片段重叠50字符，保证语义不被切断）
   - 递归字符切分优先按段落、句子、单词顺序切，语义完整性更好
3. **清空旧数据**：`TRUNCATE knowledge_embeddings`（全量更新策略）
4. **向量化 + 入库**：
   - Embedding 模型：阿里云百炼 `qwen3.7-text-embedding`（也支持智谱 AI embedding-3）
   - 向量维度：1024 维
   - 通过 `PGVectorStore.fromDocuments()` 批量写入

### 为什么选择离线批量？

- 电商知识库（商品、政策）更新频率不高，不需要实时索引
- 离线批量处理可以控制成本，embedding API 调用集中完成
- 全量替换简单可靠，避免增量更新的一致性问题
- 查询时直接做向量相似度检索，延迟低

---

## 3. 知识库如果需要更新，你们是怎么做的？

### 项目现状：全量替换

目前用的是**全量替换**方式：
1. 运营修改 `data/knowledge/` 下的 markdown 文件
2. 重新执行 `pnpm run ingest`
3. 脚本内部先 `TRUNCATE` 清空表，再重新切分、向量化、写入

**适合我们的原因**：
- 知识库内容不多，全量跑一次几十秒
- 更新频率低（商品、政策几周才更新一次）
- 简单可靠，没有一致性问题

### 演进方案

如果业务发展了，可以按以下层级逐步优化：

#### 优化 1：从全量到增量

- 给每个文档加 `doc_id` 和 `updated_at`，只处理变更的文档
- 用内容 hash 去重，相同内容不重复向量化
- 删除的文档软删除（加 `is_deleted` 标记）
- 更新速度快，适合知识库变大的场景

#### 优化 2：从手动到自动化

- 运营在 CMS / 飞书文档里直接编辑
- 文档发布后通过 **webhook 触发单篇入库**，或走消息队列（Kafka/RabbitMQ）异步处理
- 入库流程独立成服务，有失败重试、死信队列
- 运营自助更新，不需要研发介入

#### 优化 3：加索引和混合检索

- 数据量上来后，pgvector 建 **HNSW 索引**（`USING hnsw (embedding vector_cosine_ops)`）
- 加上**混合检索**：向量相似度 + BM25 关键词检索，用 RRF 算法融合
- 检索准确率提升，尤其是专有名词多的场景

#### 优化 4：质量保障体系

- **Embedding 缓存**：相同内容不重复调 API，省钱
- **批量 + 限流**：embedding API 有 QPS 限制，批量调用 + 令牌桶限流
- **Chunk 质量校验**：过滤太短、重复、全是标点的 chunk
- **版本回滚**：每次入库打版本号，出问题快速回退

### 不同场景的更新策略对比

| 更新策略 | 适用场景 | 优点 | 缺点 |
|---|---|---|---|
| 全量替换（当前方案） | 文档少、更新频率低 | 简单可靠 | 量大了慢，有 downtime |
| 增量更新 | 中等规模，定期更新 | 效率高 | 要处理一致性 |
| 消息队列异步 | 更新频繁，对时效性有要求 | 解耦、可扩展 | 架构复杂 |
| 实时入库 | UGC、用户上传即搜 | 时效性最高 | 成本高、写入慢 |

---

## 4. 真实企业项目中，也是部署时建表，然后切分向量化入库吗？

### 建表：基本都是部署时做的

各家公司做法比较统一：
- **生产环境**：通过数据库迁移工具（Flyway、Liquibase、Alembic、Prisma Migrate）管理，建表 SQL 版本化，发版时自动执行
- **初创/小团队**：手动执行 SQL 脚本或用 ORM sync
- **不在应用启动时自动建表的原因**：
  - DDL 操作风险高，需要审批和回滚方案
  - 建表/加字段可能锁表，影响线上服务
  - 多实例部署时并发建表可能出问题
  - 遵循基础设施即代码（IaC）理念，数据库变更和代码发布解耦

### 文档入库：取决于场景，大致分三种

#### 方案一：全量离线批量入库

- **适用**：知识库更新频率低（几天到几周）、文档量不大（几千到几万篇）
- **做法**：定时任务（每天凌晨）或发布流水线触发全量同步
- **数据来源**：CMS、Wiki、产品文档库（Confluence、飞书）

#### 方案二：增量近实时入库（最常见的企业方案）

- **适用**：知识库随时更新、用户需要尽快搜到新内容、文档量较大（十万级以上）
- **做法**：
  - 消息队列 + 消费端：文档变更发消息到 Kafka/RabbitMQ，消费者异步处理
  - Webhook 触发：CMS 文档变动时调用 webhook 触发单篇入库
  - 定时增量同步：每 5 分钟/每小时拉取最近更新的文档
  - 去重逻辑：根据文档 ID 或内容 hash 判断是否需要重新向量化

#### 方案三：实时入库

- **适用**：用户上传的内容必须立即可检索、UGC 场景
- **做法**：一般是异步 + 状态机（上传 → 排队处理中 → 处理完成可检索），完全同步体验差
- **缺点**：对写入性能影响大，成本高

### 真实企业还会有的东西

1. **Embedding 缓存**：相同内容不重复调 API
2. **批量 + 限流控制**：应对 embedding API 的 QPS 限制
3. **质量校验**：检查 chunk 质量，过滤垃圾数据
4. **混合检索**：向量 + 关键词结合
5. **多租户/权限控制**：检索时按用户权限过滤
6. **版本管理**：文档更新保留历史版本或软删除
7. **监控告警**：入库失败率、检索延迟等指标

---

## 5. PGVectorStore.fromDocuments() 都做了什么？

### 整体流程

```
fromDocuments(docs, embeddings, config)
    │
    ├─ 1. initialize()    ── 初始化连接 + 确保表存在
    │       ├─ new PGVectorStore()       构造实例，解析配置
    │       ├─ _initializeClient()       从连接池拿一个客户端
    │       └─ ensureTableInDatabase()   建表（IF NOT EXISTS）+ 启用 vector 扩展
    │
    └─ 2. addDocuments()  ── 文档向量化并写入
            ├─ 提取所有 pageContent
            ├─ embeddings.embedDocuments()   批量调用 embedding API
            └─ addVectors()                  分批 INSERT 写入 pgvector 表
```

### 第一步：initialize() — 初始化

1. **构造函数**：解析配置（表名、列名映射、距离策略、批量大小），处理数据库连接池
2. **获取数据库连接**：从 pool 中 connect 一个客户端
3. **确保表存在**（`ensureTableInDatabase`）：
   - 执行 `CREATE EXTENSION IF NOT EXISTS vector;`
   - 执行 `CREATE TABLE IF NOT EXISTS 表名 (...)`
   - 默认建的表主键是 `uuid` 类型，我们项目手动建的是 `bigserial`，因为 `IF NOT EXISTS` 不会覆盖已有表

### 第二步：addDocuments() — 向量化 + 写入

1. **批量生成 embedding**：
   - 把所有 chunk 的 `pageContent` 抽出来
   - 调用 `embeddings.embedDocuments(texts)` 一次性发给 embedding 模型
   - 返回二维数组：`[[0.1, 0.2, ...], [0.3, 0.4, ...], ...]`

2. **分批写入数据库**（`addVectors`）：
   - 把向量数组转成 pgvector 字符串格式：`"[0.1, 0.2, ...]"`
   - 过滤掉 `\0` 空字符（PostgreSQL 不支持 NUL 字符）
   - 每 500 条拼成一个 `INSERT ... VALUES (...), (...), ...` 批量插入
   - 减少数据库往返次数，提升写入性能

生成的 SQL 大致如下：
```sql
INSERT INTO knowledge_embeddings ("content", "embedding", "metadata")
VALUES ($1, $2, $3), ($4, $5, $6), ...  -- 最多 500 行一批
```

### 关键细节

- **批量写入优化**：不是单条插入，每 500 条一批，减少数据库往返
- **向量格式**：pgvector 的向量在 SQL 里是字符串形式 `[x, y, z, ...]`
- **null 字符过滤**：`replace(/\0/g, "")`，PostgreSQL 的 text 类型不支持 `\0`
- **幂等建表**：`IF NOT EXISTS`，表已存在不会报错
- **没有事务包裹**：分批写入各自独立，中间失败前面的已提交，不会回滚

---

## 6. 表的字段是固定的吗？

### LangChain PGVectorStore 的表结构：基本固定，可配置列名

#### 四个核心字段是必须的

| 字段 | 默认列名 | 类型 | 作用 |
|---|---|---|---|
| ID | `id` | `uuid`（默认） | 主键 |
| 内容 | `text` | `text` | 存储 chunk 的文本内容 |
| 元数据 | `metadata` | `jsonb` | 存来源、分类等额外信息 |
| 向量 | `embedding` | `vector(N)` | 向量数据 |

#### 列名可配置，类型不可改

通过 `columns` 配置自定义列名：
```ts
columns: {
  idColumnName:       'id',
  vectorColumnName:   'embedding',
  contentColumnName:  'content',
  metadataColumnName: 'metadata',
}
```

但**四个字段的类型和数量是固定的**，LangChain 只认这四列。额外加的字段 LangChain 会忽略。

#### 可选字段：collection_id

如果配置了 `collectionTableName` 和 `collectionName`，会多一个 `collection_id` 字段，用于多集合/多租户隔离。

### 我们项目和默认的区别

| 字段 | LangChain 默认 | 我们项目 |
|---|---|---|
| id 类型 | `uuid` + `gen_random_uuid()` | `bigserial`（自增整数） |
| content 列名 | `text` | `content`（通过 columns 配置） |

能正常工作是因为：插入时不指定 id，数据库自动生成；列名通过配置告诉 LangChain。

### 真实生产中的表结构设计

在 LangChain 默认四列的基础上扩展业务字段：

```sql
CREATE TABLE knowledge_embeddings (
  id          bigserial PRIMARY KEY,
  doc_id      text NOT NULL,           -- 文档 ID（如 CMS 文章 ID）
  chunk_index int NOT NULL,            -- 第几个 chunk，用于排序定位
  title       text,                    -- 文档标题，方便展示
  source      text,                    -- 来源（冗余，不用从 metadata 取）
  category    text,                    -- 分类（商品/政策/帮助文档）
  content     text,
  metadata    jsonb,
  embedding   vector(1024),
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  is_deleted  boolean     DEFAULT false  -- 软删除
);
```

#### 为什么要把部分 metadata 抽成单独列？

- **查询更快**：对 `category`、`doc_id` 建索引，过滤比 jsonb 快
- **方便增量更新**：有了 `doc_id`，更新文档时先删旧的再插新的
- **软删除**：不用真删数据，出问题可以恢复

#### 索引设计

```sql
-- 向量索引（数据量大了必须加）
CREATE INDEX ON knowledge_embeddings USING hnsw (embedding vector_cosine_ops);

-- 业务过滤索引
CREATE INDEX ON knowledge_embeddings (category);
CREATE INDEX ON knowledge_embeddings (doc_id);
CREATE INDEX ON knowledge_embeddings (source);

-- jsonb 索引（如果 metadata 过滤多）
CREATE INDEX ON knowledge_embeddings USING gin (metadata);
```

#### 超大规模：表分区

百万级以上，可以按 `category` 或 `created_at` 做表分区，检索时只扫对应分区。

### 一句话总结

LangChain 要求的**四个核心字段是固定的**（id、content、metadata、embedding），列名可配置但类型和数量不能变。真实生产中会在基础上**扩展业务字段**（doc_id、分类、软删除、时间戳）和索引，LangChain 不认识的字段会忽略，不影响读写。
