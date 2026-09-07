# 红松心选 AI 客服系统

基于 Vue 3 + Express + LangChain/LangGraph 构建的全栈智能客服系统，支持流式对话、Agent 调用与 RAG 知识库检索。

## 项目结构

```
ecom-ai-customer/
├── client/          # 前端（Vue 3 + Vite）
└── server/          # 后端（Express + LangChain + LangGraph）
```

## 功能特性

- 💬 **流式对话** — 基于大模型的实时智能客服对话
- 🤖 **Agent 智能体** — 支持工具调用的多轮对话 Agent
- 📚 **RAG 检索** — 基于知识库的语义检索与回答
- 🧠 **LangGraph 工作流** — 可编排的复杂对话流程
- 🧩 **记忆机制** — 短期记忆（Checkpointer 会话持久化）+ 长期记忆（跨会话用户偏好）+ 摘要压缩（LLM 压缩旧对话控制上下文长度）

## 快速开始

### 后端

#### 1. 安装依赖 & 配置环境变量

```bash
cd server
cp .env.example .env   # 配置 API Key、数据库连接等环境变量
npm install
```

#### 2. 初始化数据库（首次启动必做）

> 确保本地 PostgreSQL 已启动，并且已安装 [pgvector](https://github.com/pgvector/pgvector) 扩展。

```bash
npm run init-db
```

该脚本会自动完成：
- 创建目标数据库（默认 `ecom_ai`，可在 `.env` 中通过 `PG_DATABASE` 修改）
- 启用 `pgvector` 扩展
- 创建 `knowledge_embeddings` 向量表
- 创建 LangGraph 记忆表：`checkpoints` / `checkpoint_blobs` / `checkpoint_writes`（短期记忆）与 `store` / `store_vectors`（长期记忆）

#### 3. 入库知识库（使用 RAG 功能前必做）

```bash
npm run ingest
```

该脚本会读取 `server/src/data/knowledge/` 下的知识库文件（`products.md`、`policies.md`），切分后写入向量数据库。

> 知识库内容更新后，重新执行 `npm run ingest` 即可全量更新。

#### 4. 启动服务

```bash
npm run dev
```

服务启动后访问 http://localhost:3000

### 前端

```bash
cd client
npm install
npm run dev
```

## 技术栈

- **前端**: Vue 3、Vue Router、Vite
- **后端**: NestJS、LangChain、LangGraph、PostgreSQL
- **AI**: OpenAI / 兼容接口大模型

## 记忆机制（Graph 工作流）

Graph 链路实现了三层记忆，均在服务端管理，前端只传 `threadId`（会话）和 `userId`（用户）：

| 记忆类型 | 实现方式 | 存储 |
|---|---|---|
| **短期记忆** | LangGraph `PostgresSaver` Checkpointer，按 `thread_id` 隔离；对话历史持久化在服务端，重启/刷新不丢失 | `checkpoints` 等表 |
| **长期记忆** | LangGraph `PostgresStore`，按用户命名空间存储；每轮由 LLM 提取/更新用户偏好（称呼、颜色尺码偏好等），下轮召回注入 prompt | `store` / `store_vectors` 表 |
| **摘要压缩** | 消息数超过阈值（默认 10）时，由 LLM 把旧摘要与旧消息合并为新摘要，并用 `RemoveMessage` 从状态中删除被压缩的旧消息（保留最近 4 条） | 图状态 `summary` 字段 |

图结构（`server/src/graphs/customer-graph.ts`）：

```
START → recallMemories（召回长期记忆）
      → intentRouter → orderAgent | ragNode | generalChat
      → answerSynthesizer（生成回答并写入 AIMessage 持久化）
      → [消息超阈值] summarize（LLM 压缩旧对话）
      → memoryWriter（LLM 提取用户偏好写入长期记忆）→ END
```

验证方式：
- 同一 `threadId` 连续请求（不带历史）可续接上下文 → 短期记忆生效
- `GET /api/graph/history?threadId=xxx` 查看服务端持久化的消息与摘要
- 换新 `threadId` 后仍记得用户偏好 → 长期记忆生效

> 已部署过旧版本的项目：重新执行 `npm run init-db` 补建记忆表即可。
