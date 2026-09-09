# order-agent.ts 记忆机制详解

## 核心结论

**`order-agent.ts` 本身没有独立的记忆功能。** 它是大图（GraphModule）中的一个子节点，所有记忆都由外层工作流提供并注入，order-agent 只负责消费。

```
order-agent 本身 ≈ 无状态的纯函数
记忆完全依赖外层图的 state
```

---

## 三层记忆结构

| 记忆层级 | 存储位置 | 内容 | 生产方 | order-agent 消费方式 |
|---|---|---|---|---|
| **短期记忆** | `state.messages` + PostgresSaver | 会话消息历史（最近几轮） | 外层图 checkpointer 自动管理 | 取最近 4 轮格式化为文本 |
| **中期记忆** | `state.summary` | 对话摘要（旧消息压缩） | 外层 `summarize` 节点 | 通过 `buildMemoryContext` 读取 |
| **长期记忆** | PostgresStore（KV 存储） | 用户偏好（跨会话） | 外层 `recallMemories` 节点 + `memory-writer` | 通过 `buildMemoryContext` 读取 |

---

## 注入链路详解

### 完整流程

```
用户发送消息
    ↓
GraphService.graph.stream() 启动
    ↓
┌─────────────────────────────────────────────┐
│  外层图节点依次执行（记忆在 state 中流转）      │
├─────────────────────────────────────────────┤
│                                             │
│  1. recallMemories 节点                     │
│     └─ 从 PostgresStore 按 userId 检索      │
│        写入 state.userMemories              │
│                                             │
│  2. intentRouter 节点                       │
│     └─ 判断为订单问题 → 分发到 orderAgent    │
│                                             │
│  3. orderAgent 节点（本文件）                │
│     ├─ 从 state 读取：                       │
│     │   ├─ messages     ← 短期记忆          │
│     │   ├─ summary      ← 中期记忆          │
│     │   └─ userMemories ← 长期记忆          │
│     ├─ 组装 contextParts                     │
│     │   └─ 拼成 SystemMessage 注入 Agent     │
│     ├─ 调用 createAgent（ReAct 循环）        │
│     └─ 返回 orderResult                      │
│                                             │
│  4. answerSynthesizer 节点                   │
│     └─ 统一生成最终回答                       │
│                                             │
└─────────────────────────────────────────────┘
    ↓
（异步副作用）memory-writer
    └─ 提取新记忆 → 写入 PostgresStore
```

### order-agent 内的注入代码

```ts
// 组件1：对话摘要 + 长期记忆（用户偏好）
const memoryContext = buildMemoryContext(state);

// 组件2：最近 4 轮历史消息
const recentDialogue = formatMessagesAsText((messages || []).slice(0, -1), 4);

// 组装上下文，过滤空内容
const contextParts = [memoryContext, recentDialogue].filter(Boolean);

// 注入为 SystemMessage，放在消息最前面
const inputMessages = contextParts.length
  ? [
      new SystemMessage(`对话上下文（供理解用户指代时参考）：\n${contextParts.join('\n\n')}`),
      new HumanMessage(userInput),
    ]
  : [new HumanMessage(userInput)];
```

---

## 为什么这么设计？

### 优势

1. **职责单一**：order-agent 只专注订单查询，记忆管理交给工作流
2. **全局一致**：所有节点共享同一份记忆，不会出现"节点间记忆不同步"
3. **灵活扩展**：新增记忆类型（如用户画像、商品偏好）只需要加一个节点，所有下游节点自动获得
4. **统一持久化**：checkpointer 和 store 都由外层图管理，子节点无需关心存储细节

### 代价

1. **order-agent 不能独立运行** — 必须嵌入在大图中，依赖 state 注入
2. **每次调用都要重新注入上下文** — 相当于"手动喂记忆"，而不是 Agent 自己记住

---

## 与 AgentService 的对比

| 维度 | order-agent（子节点） | AgentService（独立 Agent） |
|---|---|---|
| **记忆归属** | 外层图管理，节点无状态 | 自己持有 checkpointer，有状态 |
| **记忆方式** | SystemMessage 注入上下文 | checkpointer 自动加载消息历史 |
| **长期记忆** | 外层 recallMemories 注入 | 无 |
| **摘要记忆** | 外层 summarize 注入 | 无（靠 trimMessages 裁剪） |
| **独立性** | 不能独立运行 | 可以独立调用 |

---

## 一句话总结

> `order-agent.ts` 是一个**无状态的子 Agent**，三层记忆（短期/中期/长期）全部由外层工作流准备好，通过 `contextParts` 组装成 SystemMessage 注入进去，它自己只负责"读上下文 → 调工具 → 返回结果"。
