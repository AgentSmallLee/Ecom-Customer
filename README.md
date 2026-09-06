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
- **后端**: Express、LangChain、LangGraph、PostgreSQL
- **AI**: OpenAI / 兼容接口大模型
