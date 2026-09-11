# 两种 Agent 实现对比：AgentService vs OrderAgentNode

## 概述

项目中存在两个 ReAct 智能体实现，分别位于不同模块，定位和职责不同，但底层复用同一套订单工具。

| 实现 | 文件 | 所属模块 | 定位 |
|---|---|---|---|
| AgentService | `src/agent/agent.service.ts` | AgentModule | 完整的端到端客服智能体 |
| OrderAgentNode | `src/graphs/nodes/order-agent.ts` | GraphModule（节点） | 工作流中的订单查询子节点 |

---

## 核心对比

### 1. 架构定位

| 维度 | AgentService | OrderAgentNode |
|---|---|---|
| **层级** | 独立服务（模块级） | 图中的一个节点（节点级） |
| **职责范围** | 处理所有客服问题（闲聊 + 订单 + ...） | 只处理订单查询这一件事 |
| **最终回答** | 自己生成最终回答 | 只查询数据，最终回答由 `answerSynthesizer` 节点统一生成 |
| **架构模式** | 单 Agent 模式（一个 Agent 搞定一切） | 工作流编排 + 子 Agent 模式 |
| **上游调用** | HTTP 接口直接调用 | 由 `intentRouter` 意图路由分发到本节点 |

### 2. 实现方式

| 维度 | AgentService | OrderAgentNode |
|---|---|---|
| **构建方式** | 手写 `StateGraph` 搭建 ReAct 循环 | 调用 `createAgent`（langchain 包）封装 API |
| **图结构** | `agent ↔ tools` 两节点循环 | 内部也是类似循环（被封装不可见） |
| **代码量** | 多（~240 行），控制力强 | 少（~70 行），开箱即用 |
| **灵活度** | 高，可自定义每个环节 | 中，受限于封装 API |
| **模型参数名** | `model.bindTools(tools)` 手动绑定 | `model`（createAgent 自动绑定） |
| **提示词参数名** | `SystemMessage` 手动拼到 messages 前 | `systemPrompt`（createAgent 统一处理） |

### 3. 流式输出

| 维度 | AgentService | OrderAgentNode |
|---|---|---|
| **流式模式** | `streamMode: 'custom'` | 非流式，`invoke` 一次性返回 |
| **Token 推送** | 逐 token 推送（手写 `writer` 逻辑） | 无（外层图的 answerSynthesizer 负责流式） |
| **工具事件** | `tool_start` / `tool_end` 事件 | 无独立事件，提取 steps 返回 state |

### 4. 记忆与状态

| 维度 | AgentService | OrderAgentNode |
|---|---|---|
| **会话记忆** | 自带 checkpointer，独立管理历史 | 无独立记忆，靠外层图的 state |
| **命名空间** | `agent` 命名空间 | 共享外层 `graph` 命名空间 |
| **消息裁剪** | 自己维护 `trimIfNeeded` | 外层图的 `summarize` 节点负责 |
| **长期记忆** | 无 | 外层 `recallMemories` 节点注入 |

### 5. 工具层

| 维度 | AgentService | OrderAgentNode |
|---|---|---|
| **订单工具** | `createOrderTools(userId)` | `createOrderTools(userId)` |
| **工具来源** | 同一文件 `src/tools/order-tools.ts` | 同一文件 `src/tools/order-tools.ts` |
| **用户绑定** | 每次调用从 `config.configurable.user_id` 取 | 每次调用从 `config.configurable.user_id` 取 |

> ✅ **工具层已完全复用**，不存在重复实现。

---

## 代码结构对比

### AgentService（手写 ReAct 循环）

```ts
// src/agent/agent.service.ts
const workflow = new StateGraph(MessagesAnnotation)
  .addNode('agent', callModel)      // LLM 推理节点
  .addNode('tools', callTools)      // 工具执行节点
  .addEdge(START, 'agent')
  .addConditionalEdges('agent', shouldContinue, {
    tools: 'tools',                  // 有 tool_calls → 去工具节点
    [END]: END,                      // 没有 → 结束
  })
  .addEdge('tools', 'agent');        // 工具结果回喂 LLM，继续循环
```

### OrderAgentNode（封装版 ReAct）

```ts
// src/graphs/nodes/order-agent.ts
// 使用 langchain 包的 createAgent（封装好的 ReAct Agent）
const agentApp = createAgent({
  model,
  tools,
  systemPrompt: `你是订单查询助手...`,
});

const result = await agentApp.invoke({ messages: inputMessages });
// ↑ 内部自动循环：思考 → 调工具 → 看结果 → 再思考 → ... → 最终回答
```

> **说明**：`createAgent` 来自 `langchain` 包，是封装好的 ReAct Agent。
> 主要参数：`model`、`tools`、`systemPrompt`，输入输出为 messages 格式。

---

## 为什么有两套？（演进路径）

```
ChatModule (基础对话)
    ↓
AgentModule (加工具，单 Agent 搞定一切)
    ↓
RagModule (加知识库)
    ↓
GraphModule (工作流编排，把所有能力整合起来)
              ↓
         内含 order-agent 节点
         （专门负责订单查询的子 Agent）
```

- **AgentModule** 是早期版本，演示"单 Agent + 工具"的架构
- **OrderAgentNode** 是演进后的版本，作为大图中的一个专业节点
- GraphModule 是集大成者，其他模块可看作"独立能力单元"或"历史版本"

---

## 需要统一吗？

**不需要统一，理由：**

1. **工具层已复用** — `createOrderTools` 只有一份，没有重复维护
2. **定位不同** — 一个是独立全功能 Agent，一个是工作流里的子节点，各司其职
3. **架构并存有价值** — 两种范式可以对比参考，也方便不同场景调用

### 两者关系

```
                   ┌─────────────────────────────┐
                   │     GraphModule (主路径)      │
                   │ 意图路由 → 分发 → 统一合成回答  │
                   └──────┬──────────┬──────────┬──┘
                          │          │          │
                   ┌──────▼──┐  ┌───▼────┐ ┌───▼─────┐
                   │orderAgent│ │  RAG   │ │ 闲聊    │
                   └──────┬───┘ └────────┘ └─────────┘
                          │
                   ┌──────▼──────────┐
                   │ createOrderTools│ ← 工具层复用
                   └─────────────────┘

  ┌────────────┐  ┌──────────────┐  ┌────────────┐
  │ ChatModule │  │ AgentModule  │  │ RagModule  │  ← 独立模块，可单独调用
  └────────────┘  └──────────────┘  └────────────┘
         │                │
    纯对话 LLM         单 Agent
    (无工具)          (全套工具)
```

---

## 一句话总结

> 两者都是 ReAct 智能体，共用同一套订单工具；AgentService 是"独立全功能版"，OrderAgentNode 是"工作流里的专业子节点"。工具层已复用，架构定位不同，不需要统一。
