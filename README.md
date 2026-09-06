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

```bash
cd server
cp .env.example .env   # 配置 API Key 等环境变量
npm install
npm run dev
```

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
