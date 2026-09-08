# LangGraph 消息裁剪机制与 RemoveMessage

## 一、为什么要裁剪消息

随着对话轮次增加，`state.messages` 会越来越长，带来两个问题：

1. **Token 成本上升**：每次调用模型都要把所有历史消息塞进去，消息越多，花的 token 越多
2. **可能超出模型上下文窗口**：模型有最大 token 限制，消息太长会被截断或报错

所以需要定期把旧消息删掉，只保留最近的 N 轮对话。

---

## 二、裁剪的实现方式

### 核心思路

不是手动改 `state.messages` 数组，而是利用 LangGraph `MessagesAnnotation` 的消息通道特性——**返回 `RemoveMessage` 可以删除指定 id 的消息**。

### 统一裁剪函数

位置：`server/src/common/memory/thread-utils.ts`

Chat 和 Agent 共用同一个裁剪函数，以 **HumanMessage 数量计轮**，通用且准确。

```typescript
export function trimMessages(
  messages: BaseMessage[],
  maxRounds: number,
): RemoveMessage[] {
  // 找出所有 HumanMessage 的位置
  const humanMsgs = messages.filter((m) => m._getType?.() === 'human');
  if (humanMsgs.length <= maxRounds) return [];

  // 从倒数第 maxRounds 条 HumanMessage 开始保留
  const keepFromIndex = humanMsgs.length - maxRounds;
  const cutoffMsgId = humanMsgs[keepFromIndex]?.id;
  const cutoffIdx = messages.findIndex((m) => m.id === cutoffMsgId);

  if (cutoffIdx <= 0) return [];

  // cutoffIdx 之前的所有消息全部删掉（human + ai + tool 等）
  const toRemove = messages.slice(0, cutoffIdx);
  return toRemove
    .filter((m) => m.id != null)
    .map((m) => new RemoveMessage({ id: m.id! }));
}
```

步骤：
1. 找出所有 HumanMessage，数量超过 `maxRounds` 才需要裁剪
2. 找到**倒数第 N 条 HumanMessage** 的位置（从这条开始保留）
3. 这条消息之前的所有消息（human / ai / tool / ...）全部删掉
4. 每条要删的消息用 `RemoveMessage` 包装，带上消息 `id`

### 为什么用 HumanMessage 计轮

因为一条 HumanMessage 就代表一轮对话的开始，不管中间有多少条 AI 消息、工具消息，轮数都是准确的。

```
简单对话（Chat）：   Human → AI → Human → AI → ...
                    1轮          2轮

带工具的对话（Agent）：Human → AI → Tool → AI → Tool → AI → Human → AI → ...
                        1轮（中间多少条都算一轮）     2轮
```

---

## 三、为什么返回 RemoveMessage 数组，而不是返回新的 messages 数组

这是 LangGraph `MessagesAnnotation` 的**消息通道语义**决定的：

### MessagesAnnotation 的三种消息类型

| 消息类型 | 作用 |
|---------|------|
| `HumanMessage` / `AIMessage` / `SystemMessage` / `ToolMessage` | **追加**到 messages 数组末尾 |
| `RemoveMessage` | **按 id 删除**对应消息 |
| `UpdateMessage` | **按 id 更新**对应消息 |

也就是说，`state.messages` 不是简单的数组赋值，而是一个**消息通道（Message Channel）**，支持追加、删除、更新三种操作。

### 对比

如果直接返回新的 messages 数组：
```typescript
// ❌ 错误：这不是替换，而是又追加一遍！
return { messages: filteredMessages };
```
这会把过滤后的消息**全部追加一遍**，导致重复，因为通道默认是追加语义。

正确做法：
```typescript
// ✅ 正确：返回 RemoveMessage，通道按 id 删除
const removes = trimMessages(messages, maxRounds);
await this.graph.updateState(config, { messages: removes });
```

---

## 四、裁剪调用时机

在每次对话结束后调用（`chat()` / `stream()` / `invoke()` 方法最后）：

```typescript
// 轮次裁剪
await this.trimIfNeeded(config);
```

```typescript
private async trimIfNeeded(config: { configurable: { thread_id: string } }) {
  const state = await this.graph.getState(config);
  const messages = (state?.values?.messages || []) as BaseMessage[];
  const removes = trimMessages(messages, DEFAULT_MAX_ROUNDS);
  if (removes.length > 0) {
    await this.graph.updateState(config, { messages: removes });
  }
}
```

步骤：
1. 从 checkpoint 拿到当前所有消息
2. 调用 `trimMessages` 算出要删哪些
3. 如果有要删的，通过 `updateState` 把 `RemoveMessage` 数组推给消息通道
4. 消息通道自动按 id 删除对应消息，更新 state
5. 更新后的 state 自动写回 checkpointer

---

## 五、完整流程图

```
对话结束
  │
  ▼
graph.getState(config)
  │  拿到当前所有消息
  ▼
trimMessages(messages, maxRounds)
  │  按 HumanMessage 定位裁剪点
  │  算出需要删除的旧消息
  │  包装成 RemoveMessage[]
  ▼
有要删的？─── 否 ──→ 结束
  │
  是
  ▼
graph.updateState(config, { messages: removes })
  │
  ▼
MessagesAnnotation 消息通道
  │  遇到 RemoveMessage → 按 id 删除
  ▼
state.messages 更新，旧消息被删掉
  │
  ▼
checkpointer 自动持久化最新状态
```

---

## 六、Chat 和 Agent 共用同一套裁剪

`chat.service.ts` 和 `agent.service.ts` 都使用同一个 `trimMessages` 函数和相同的 `trimIfNeeded` 模式：

| 服务 | 消息构成 | 裁剪方式 |
|------|---------|---------|
| ChatService | human + ai（简单） | `trimMessages`（按 HumanMessage 计轮） |
| AgentService | human + ai + tool（复杂） | 同一个 `trimMessages`（同样适用） |

统一后的好处：
- 逻辑复用，没有重复代码
- 行为一致，不会出现两边裁剪规则不一样的情况
- 以后改规则只改一个地方

---

## 七、关键注意点

1. **消息必须有 id**：`RemoveMessage` 是按 `id` 删除的，所以每条消息都必须有唯一 id。LangChain 的消息类默认会自动生成 id，一般不用手动管。

2. **裁剪是软删除**：消息从 state 里移除了，但 checkpointer 的历史版本里可能还留着旧 checkpoint（取决于 checkpointer 的实现和配置）。

3. **一轮 = 一条 HumanMessage**：以 HumanMessage 数量计轮，不管中间有多少条 AI / Tool 消息，轮数都是准确的。这种方式对简单对话和带工具的对话都适用。

4. **裁剪的是"前面"的消息**：保留最后 N 轮，删除最早的消息，保证最新的对话上下文不丢。
