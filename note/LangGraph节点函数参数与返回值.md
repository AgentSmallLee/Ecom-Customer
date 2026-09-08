# LangGraph 节点函数参数与返回值

## 节点函数签名

```typescript
async (state, config) => statePatch
```

StateGraph 的节点函数只有**两个参数**，返回一个状态补丁对象（或 Promise）。

---

## 第一个参数：state

当前图的状态，类型取决于图的状态定义。

### 不同状态定义不同，内容也不同：

| 状态 | 包含字段 | 说明 |
|------|---------|------|
| `MessagesAnnotation.State` | `messages: BaseMessage[] | 只有消息数组 |
| 自定义 Annotation.Root | 自己定义的所有字段 | 比如 intent、finalAnswer 等 |

节点里可以读取 state 的所有字段，但不能直接修改（要通过返回值更新）。

---

## 第二个参数：config

类型：`LangGraphRunnableConfig`

运行时配置，图执行过程中由 LangGraph 传入。

### 常用内容

| 字段/方法 | 说明 |
|---------|------|
| `config.configurable?.thread_id` | 会话 ID（checkpointer 用） |
| `config.configurable?.user_id` | 用户 ID（长期记忆用） |
| `getWriter(config)` | custom 流的写入器，推送自定义事件 |
| `getStore(config)` | 获取 BaseStore（长期记忆存储） |
| `getConfig()` | 异步获取当前 config（用于异步上下文环境） |

> `getWriter` / `getStore` / `getConfig` 是 LangGraph 提供的工具函数，不是 config 本身的属性。

---

## 返回值：状态补丁

节点函数的返回值会被**合并**到 state 中，不是替换。

```typescript
// 返回 messages 通道是追加，不是替换
return { messages: [new AIMessage("...") };

// 自定义字段的 reducer 决定了是替换还是追加
return { intent: "order" };
```

返回值的字段取决于状态定义里每个 channel 的 reducer：
- `messages`（MessagesAnnotation）：追加（append）
- 普通 Annotation（`reducer: (_, next) => next`）：替换

也可以返回空对象 `{}` 表示不更新状态。

---

## 完整示例

```typescript
import {
  MessagesAnnotation,
  StateGraph,
  START,
  END,
  getWriter,
  type LangGraphRunnableConfig,
} from '@langchain/langgraph';
import { AIMessage } from '@langchain/core/messages';

const workflow = new StateGraph(MessagesAnnotation)
  .addNode('chat', async (state, config: LangGraphRunnableConfig) => {
    // 1. 从 state 读取消息
    const messages = state.messages;

    // 2. 从 config 拿 writer，推送自定义流
    const writer = getWriter(config);
    writer?.('some token');

    // 3. 返回状态补丁，更新 state
    return { messages: [new AIMessage('回复内容')] };
  })
  .addEdge(START, 'chat')
  .addEdge('chat', END);
```

---

## 注意点

1. **只有两个参数**：`state` 和 `config`，没有第三个
2. **state 是只读的**：不要直接修改 state，通过返回值更新
3. **返回值是补丁**：追加还是替换，由每个 channel 的 reducer 决定
4. **config 是运行时的**：每次执行时才传入，包含 thread_id 等运行期信息
