# LangGraph streamMode 流式输出模式详解

## 一、streamMode 是什么

`streamMode` 是 `graph.stream()` 的参数，决定了图的流式输出**以什么粒度、什么内容**往外推送。

简单理解：图执行过程中会产生很多事件（节点开始、模型吐 token、状态更新...），`streamMode` 就是选"你想听哪些事件"。

---

## 二、所有可选模式

| 模式 | 产出内容 | 粒度 | 适用场景 |
|------|---------|------|----------|
| `"values"` | 每次状态更新后的**完整 state** | 状态变化级 | 需要完整状态快照 |
| `"updates"` | 每个节点返回的**状态补丁**（只有变更字段） | 节点级 | 最常用，看每个节点输出了什么 |
| `"messages"` | 模型产生的**消息 token 流**（`AIMessageChunk` 等） | token 级 | 打字机效果（模型调用被图捕获时） |
| `"custom"` | 节点内通过 `getWriter(config).()` **手动推送**的自定义数据 | 完全自定义 | 自定义流内容，灵活度最高 |
| `"debug"` | 调试事件（任务开始/结束、错误等） | 事件级 | 调试图的执行过程 |
| `"checkpoints"` | checkpoint 写入事件 | 持久化级 | 监听状态持久化时机 |
| `"tasks"` | 任务调度事件 | 任务级 | 细粒度任务监控 |
| `"tools"` | 工具调用事件 | 工具级 | 监听工具调用的流式输出 |

> 也可以传数组同时开启多种模式，如 `streamMode: ['updates', 'messages']`

---

## 三、常用模式详解

以一个简单的 Chat 图（只有一个 `chat` 节点）为例，对比不同模式的输出。

### 1. `streamMode: 'values'` —— 完整状态

每次状态变化后，产出**完整的 state**。

```typescript
// 输出示例：
{ messages: [HumanMessage("你好")] }
{ messages: [HumanMessage("你好"), AIMessageChunk("你")] }
{ messages: [HumanMessage("你好"), AIMessageChunk("你好")] }
{ messages: [HumanMessage("你好"), AIMessage("你好呀，有什么可以帮您？")] }
```

特点：
- 每次产出都是完整的 messages 数组
- 越来越长，数据有冗余
- 适合需要拿到完整状态的场景

### 2. `streamMode: 'updates'` —— 节点级更新

**每个节点执行完**，产出一次该节点的返回值（状态补丁）。

```typescript
// 输出示例：
{ chat: { messages: [AIMessage("你好呀，有什么可以帮您？")] } }
```

特点：
- **节点级粒度**，一个节点产一次
- 不是 token 级的，没有打字机效果
- 最常用的模式，适合多节点图看每步输出

### 3. `streamMode: 'messages'` —— token 级消息流

模型每生成一个 token，就产出一个消息 chunk。

```typescript
// 输出示例：
AIMessageChunk { content: "你" }
AIMessageChunk { content: "好" }
AIMessageChunk { content: "呀" }
...
```

特点：
- **token 级粒度**，适合打字机效果
- 前提：模型调用必须被 LangGraph 捕获到（比如直接在图里配置模型，或用 `ToolNode` 等内置节点）
- 如果模型调用包在自定义节点的函数内部，`'messages'` 模式捕获不到

### 4. `streamMode: 'custom'` —— 自定义推送

节点内通过 `getWriter(config).('xxx')` 手动推送，推送什么流里就是什么。

```typescript
// 节点内：
const stream = await model.stream(messages);
for await (const chunk of stream) {
  getWriter(config)?.(chunk.content);  // 手动推送
}

// 输出示例：
"你"
"好"
"呀"
...
```

特点：
- **最灵活**，完全由你控制流的内容和时机
- 可以推送任何类型的数据（字符串、对象都行）
- 需要在节点函数里手动调用 `getWriter(config).()`

---

## 四、当前项目中的使用

### ChatService：`streamMode: 'custom'`

`server/src/chat/chat.service.ts`

**为什么用 `'custom'`？**

因为我们的模型调用是包在 LCEL chain 里、在自定义节点函数内部调用的，LangGraph 捕获不到内部的 token 流，所以 `'messages'` 模式用不了。

改用 `'custom'` 模式，在节点内部通过 `getWriter(config).()` 手动把 token 推出去：

```typescript
.addNode('chat', async (state, config: LangGraphRunnableConfig) => {
  const stream = await customerServiceStreamChain.stream({ ... });

  let fullOutput = '';
  for await (const chunk of stream as unknown as AsyncIterable<string>) {
    if (chunk) {
      fullOutput += chunk;
      getWriter(config)?.(chunk);  // 手动推送 token 到 custom 流
    }
  }

  return { messages: [new AIMessage(fullOutput)] };
})
```

消费端：

```typescript
const stream = await this.graph.stream(
  { messages: [new HumanMessage(message)] },
  { streamMode: 'custom', ...config },
);

for await (const chunk of stream as unknown as AsyncIterable<unknown>) {
  if (typeof chunk === 'string' && chunk) {
    yield chunk;  // 逐 token 透传给前端
  }
}
```

### GraphService：`streamMode: 'updates'`

`server/src/graph/graph.service.ts`

**为什么用 `'updates'`？**

因为 customer-graph 有多个节点（retriever、answerSynthesizer 等），用 `'updates'` 模式可以拿到每个节点的输出，前端可以展示不同阶段的结果。

```typescript
const stream = await graph.stream(
  { userInput: message, messages: [new HumanMessage(message)] },
  { streamMode: 'updates', ...config },
);

for await (const chunk of stream) {
  yield chunk;  // 每个节点输出一次
  if (chunk.answerSynthesizer?.finalAnswer) {
    finalAnswer = chunk.answerSynthesizer.finalAnswer;
  }
}
```

---

## 五、模式选择建议

| 需求 | 推荐模式 |
|------|---------|
| 多节点图，想看每步输出 | `'updates'` |
| token 级打字机效果，模型调用是图内置的 | `'messages'` |
| token 级打字机效果，模型在自定义节点内调用 | `'custom'` |
| 需要完整状态快照 | `'values'` |
| 调试图的执行流程 | `'debug'` |
| 同时需要多种输出 | 数组，如 `['updates', 'messages']` |
