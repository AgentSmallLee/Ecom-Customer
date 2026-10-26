# LangGraph `graph.stream` 的 streamMode 总结

> 背景：`server/src/agent/agent.service.ts` 中的 ReAct Agent 图。
> 本文件汇总各 streamMode 的输出形态、相互区别与选型建议，示例均来自 `总结/` 下的实际 dump。

---

## 1. 总览表

| streamMode | 每个 chunk 的形态 | 粒度 | token 流式 | 工具步骤事件 | 典型用途 |
|---|---|---|---|---|---|
| `values`（默认） | **完整状态** `{messages:[全部历史...]}` | 每个 super-step 一次 | ✗ | ✗ | 拿最终结果、调试 |
| `updates` | **节点增量** `{agent: {messages:[新消息]}}` | 每个节点一次 | ✗ | ✗ | 追踪"哪个节点产出了什么" |
| `messages` / `messages-tuple` | **逐 token** `[AIMessageChunk, metadata]` | 每个 token/碎片 | ✅ 原生 | ✗ | 打字机效果、原生解析 tool_call_chunks |
| `custom` | **自定义事件** `{type:'token'/'tool_start'/'tool_end',...}` | 节点手动 push 一次是一条 | ✅（靠 writer） | ✅ | 业务自定义事件通道 |
| `debug` | 底层全事件（`on_chain_start` 等） | 事件级 | 部分 | 部分 | 排查框架内部 |

**要点**：`graph.stream()` 本身总是流式的，streamMode 只决定"流里推什么"。

---

## 2. 各模式详细说明

### 2.1 `values`（默认）

推 **全量状态**，每跑完一个 super-step 推一次，越到后面 chunk 越大。

见 [streamMode-values.txt](streamMode-values.txt)，同一个"查单失败"请求推 4 次：

```
{messages:[Human]}                                        → agent 前
{messages:[Human, AIMessage(调工具)]}                     → agent 后
{messages:[Human, AIMessage, ToolMessage]}                → tools 后
{messages:[Human, AIMessage, ToolMessage, AIMessage(最终回答)]} → 结束
```

特点：全量、非增量；**无 token 级输出**（content 是组装好的完整文本）。

### 2.2 `updates`

推 **节点增量**（节点返回值），chunk 按节点名分组。

见 [streamMode-updates.txt](streamMode-updates.txt) 末尾（L447 起），推 3 次：

```
{agent: {messages:[AIMessage(调工具)]}}
{tools: {messages:[ToolMessage(结果)]}}
{agent: {messages:[AIMessage(最终回答)]}}
```

特点：增量小、结构清晰；**无 token 级输出、无自定义事件**。

### 2.3 `messages` / `messages-tuple`

每个 chunk 是一个元组 `[AIMessageChunk, metadata]`，metadata 含 `langgraph_node`、`source`、`traceId`、`thread_id` 等图上下文。

见 [streamMode-messages.txt](streamMode-messages.txt)：

```
[
  AIMessageChunk { content: '如果您', tool_call_chunks: [...], invalid_tool_calls: [...] },
  { langgraph_node: 'agent', source: 'graph-agent-tool-result', traceId: '...', ... }
]
[
  AIMessageChunk { content: '确认', ... },
  { ... }
]
```

特点：逐 token 原生流出，`tool_call_chunks` 原样携带；但**给不了自定义事件**（见 §4）。

### 2.4 `custom`（本项目当前使用）

每个 chunk 是节点通过 `getWriter(config)` 手动 push 的自定义事件。本项目 `AgentStreamEvent` 三类：

| type | 推送位置（agent.service.ts） | 字段 |
|---|---|---|
| `token` | agent 节点 [L117] | `content`: LLM 输出片段（逐块） |
| `tool_start` | agent 节点 [L150] | `name`: 工具名；`input`: 解析后的入参对象 |
| `tool_end` | tools 节点 [L174-181] | `name`: 工具名；`observation`: 工具返回结果（字符串化） |

见 [streamMode-custom.txt](streamMode-custom.txt)，一次完整流程：

```
{type:'token', content:'好的'} {type:'token', content:'亲'} ...
{type:'tool_start', name:'getOrderInfo', input:{orderId:'ORD-001'}}
{type:'tool_end', name:'getOrderInfo', observation:'{"error":"订单 ORD-001 不存在"}'}
{type:'token', ...} ...
```

特点：**载荷格式完全由用户定义**，框架原样透传不做解释——这是唯一能承载 `tool_start`/`tool_end` 等自定义事件的通道。

---

## 3. 三个核心差异维度

1. **增量 vs 全量**：`values` 给全量（越到后面越大）；`updates` 给增量（小）；`messages` 给单 token；`custom` 给业务事件。
2. **token 级 vs 节点级**：`values`/`updates` 只能看到节点跑完后组装好的完整文本；打字机效果必须 `messages` 或 `custom`。
3. **框架生成 vs 用户生成**：`values`/`updates`/`messages` 都是框架自动生成的固定格式；只有 `custom` 是节点代码用 writer 主动 push 的。

---

## 4. 为什么 `messages` 给不了自定义事件

`messages` 和 `custom` 是框架内部**两条不同的通道（channel）**，streamMode 只是选择订阅哪条：

| | `messages` 通道 | `custom` 通道 |
|---|---|---|
| 谁在写入 | 框架自己——拦截节点里 `model.stream()` 的 LLM token 流自动封装 | 用户代码——节点显式调用 `getWriter(config)(payload)` |
| 载荷格式 | 固定契约：`AIMessageChunk` + metadata | 完全开放 |
| 写入端是否可控 | 否（框架内部） | 是（业务代码） |

所以 writer 推的 `tool_start`/`tool_end` 走 custom 通道；只订阅 messages 通道等于没读另一条通道的数据。`messages` 通道的载荷类型被框架写死，无法塞入自定义对象。

---

## 5. LLM 原始 chunk 与 graph.stream 输出的关联与区别

**关联**：LLM chunk 是唯一数据源，`graph.stream` 内容是框架 + 节点代码从它派生的不同形态。

```
modelWithTools.stream()  ──►  LLM 原始 chunk（L103，节点内部）
        │  ① 节点内累加：content 拼接、tool_call_chunks 累加（L112-134）
        │  ② writer 推送：{type:'token',...} / tool_start（L117、L150）──► custom 通道 ──► graph.stream
        │  ③ 组装 AIMessage 返回给图（L154）
        ▼
     图状态/checkpoint ──► 框架按 streamMode 输出 ──► graph.stream（L224）
```

**区别**：

| 维度 | LLM 原始 chunk（L121 `console.log`） | graph.stream 的内容（L232 消费） |
|---|---|---|
| 所在层 | 模型层，agent 节点内部局部流 | 图层，外部可见输出 |
| 生产者 | 聊天模型（FailoverChatModel） | 框架（messages/values/updates）+ 节点 writer（custom） |
| 形态 | `AIMessageChunk`（content、tool_call_chunks、invalid_tool_calls、response_metadata...） | 取决于 streamMode |
| 粒度 | 逐 token/逐碎片，实时 | custom 逐 token（一一对应）；updates/values 节点级 |
| 信息量 | 最全（usage、reasoning_content、无效调用等） | custom 只留业务字段；messages 额外加 metadata |

---

## 6. 相关概念：`tool_calls` 与 `tool_call_chunks`

- **`tool_calls`**：模型表达"我要调用哪些工具"的最终数组，元素为 `ToolCall`：

  ```ts
  { name: string; args: Record<string, unknown>; id: string; type: 'tool_call' }
  ```

  流转：agent 节点构造（L137-145）→ 挂到 `AIMessage`（L154）→ `shouldContinue` 据此路由到 tools 节点（L74）→ `ToolNode` 逐个执行（L168）→ `ToolMessage.tool_call_id` 与调用对应。

- **`tool_call_chunks`**：流式过程里逐块吐出的**字符串碎片**（name/args 都是拼接的），中间产物，需在节点内累加（L120-133）后解析成 `tool_calls`。

| | 来源 | 状态 |
|---|---|---|
| `tool_call_chunks` | 流式逐块碎片 | 中间产物，需累加 |
| `tool_calls` | 拼接解析后的最终对象 | 完整、可直接执行 |

---

## 7. 选型建议

- **前端聊天 UI**：`streamMode: ['messages', 'custom']` 或 `['messages', 'updates']` —— messages 出 token，custom/updates 出工具状态和完整回复。
- **只要最终答案**：`values` 直接取最后一个 chunk。
- **调试图执行路径**：`updates` 最清晰。
- **排查底层 LLM 行为**：`messages`（metadata 丰富）或 `debug`。

**组合模式**：`streamMode` 可传数组，如 `['values', 'custom']`。此时每个 chunk 是元组 `[mode, payload]`，按 mode 分流即可。

```ts
const stream = await this.graph.stream(input, {
  streamMode: ['messages', 'custom'],
  ...config,
});

for await (const event of stream) {
  const [mode, payload] = event as ['messages' | 'custom', unknown];
  if (mode === 'messages') {
    const [msg] = payload as [AIMessageChunk, ...unknown[]];
    if (typeof msg.content === 'string' && msg.content) yield { type: 'token', content: msg.content };
  } else {
    // custom 事件原样透传
    yield payload as Extract<AgentStreamEvent, { type: 'tool_start' | 'tool_end' }>;
  }
}
```

---

## 8. 调试入口速查（agent.service.ts）

| 想打印什么 | 位置 |
|---|---|
| LLM 原始 token chunk | [L121](file:///Users/mac/Downloads/ecom-ai-customer/server/src/agent/agent.service.ts#L121) `console.log(chunk)` |
| 节点增量（图内部） | 节点 `return` 前（agent 节点 L154、tools 节点 L185） |
| graph.stream 输出（按 streamMode） | [L232](file:///Users/mac/Downloads/ecom-ai-customer/server/src/agent/agent.service.ts#L232) for-await 循环里 |

三层数据：**L121 = 模型层原料；节点 return = 图内部增量；stream() 循环 = 外部成品**。
