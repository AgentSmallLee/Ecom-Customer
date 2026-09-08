# LCEL（LangChain Expression Language）管道语法与执行流程

## 一、什么是 LCEL

LCEL 是 LangChain 提供的一种声明式链式调用语法，核心就是用 `.pipe()` 把多个可运行组件（Runnable）像管道一样串联起来，组成一条处理链。

**核心思想**：输入数据从管道左端流入，依次经过每个组件处理，从右端流出最终结果。

```
输入 → Prompt → Model → OutputParser → 输出
```

---

## 二、基本语法

```typescript
// 用 .pipe() 串联，返回的还是一个 Runnable
const chain = prompt.pipe(model).pipe(parser);

// 等价写法（更直观的管道顺序）
const chain = RunnableSequence.from([prompt, model, parser]);
```

每个 `.pipe()` 里的组件必须是 **Runnable**（可运行对象），比如：
- `PromptTemplate` / `ChatPromptTemplate` —— 格式化提示词
- `BaseChatModel` —— 大模型调用
- `BaseOutputParser` —— 输出解析
- 自定义函数（用 `RunnableLambda` 包装）
- 另一个 chain（chain 可以嵌套）

---

## 三、执行流程

以 `prompt.pipe(model).pipe(parser)` 为例，调用 `chain.invoke({ user_input: "你好" })` 时：

### 1. Prompt 阶段
- 输入：`{ user_input: "你好", chat_history: [...] }`
- 处理：用输入变量填充 prompt 模板，生成 `messages` 数组
- 输出：`[SystemMessage("..."), HumanMessage("你好")]`

### 2. Model 阶段
- 输入：`messages` 数组
- 处理：调用大模型 API，生成回复
- 输出：`AIMessage("你好呀，有什么可以帮您？")`

### 3. Parser 阶段
- 输入：`AIMessage(...)`
- 处理：提取消息里的文本内容
- 输出：`"你好呀，有什么可以帮您？"`（纯字符串）

```
invoke({ user_input: "你好" })
    │
    ▼
┌──────────────┐
│   Prompt     │  把变量填入模板 → messages 数组
└──────────────┘
    │ messages
    ▼
┌──────────────┐
│    Model     │  调用大模型 → AIMessage
└──────────────┘
    │ AIMessage
    ▼
┌──────────────┐
│    Parser    │  提取文本内容 → string
└──────────────┘
    │
    ▼
 "你好呀，有什么可以帮您？"
```

---

## 四、流式执行流程

调用 `chain.stream({ user_input: "你好" })` 时，返回一个异步迭代器，逐 token 产出结果：

```
stream({ user_input: "你好" })
    │
    ▼
┌──────────────┐
│   Prompt     │  同步完成，生成 messages
└──────────────┘
    │
    ▼
┌──────────────┐
│    Model     │  流式返回，一个 token 一个 token 往外吐
└──────────────┘
    │ "你"
    │ "好"
    │ "呀"
    │ ...
    ▼
┌──────────────┐
│    Parser    │  每个 token 都经过 parser，变成字符串
└──────────────┘
    │
    ▼
  异步迭代器，逐块产出 string
```

**关键点**：
- Prompt 和 Parser 是同步的，不产生流
- 真正产生流式输出的是 Model 层
- 整个 chain 的流就是模型流经过 Parser 后的结果

---

## 五、当前项目中 Chat 的使用方式

### 代码位置
`server/src/chains/basic-chat.ts`

### 定义
```typescript
import { StringOutputParser } from '@langchain/core/output_parsers';
import { createModel } from '../models/deepseek.ts';
import { customerServicePrompt } from '../prompts/customer-service.ts';

// 流式模型
const streamingModel = createModel({ temperature: 0.5, streaming: true });

// LCEL 管道：Prompt → Model → Parser
export const customerServiceStreamChain =
  customerServicePrompt.pipe(streamingModel).pipe(new StringOutputParser());
```

三个组件：
1. **`customerServicePrompt`** —— 客服系统提示词模板（含 `chat_history`、`user_input`、`current_time` 等变量）
2. **`streamingModel`** —— DeepSeek 流式模型实例
3. **`StringOutputParser`** —— 把 `AIMessage` 转成纯字符串

### 在图节点中的使用
`server/src/chat/chat.service.ts`

```typescript
.addNode('chat', async (state, config) => {
  // 1. 从 state.messages 里提取历史对话和当前输入
  const history = ...
  const input = history[history.length - 1]?.content || '';
  const pastHistory = history.slice(0, -1);

  // 2. 调用 LCEL chain（流式）
  const stream = await customerServiceStreamChain.stream({
    user_input:   input,
    chat_history: formatHistory(pastHistory),
    current_time: new Date().toLocaleString('zh-CN'),
  });

  // 3. 消费流式输出，同时通过 getWriter 推给 graph 的 custom 流
  let fullOutput = '';
  for await (const chunk of stream) {
    fullOutput += chunk;
    getWriter(config)?.(chunk);
  }

  // 4. 返回完整 AIMessage，更新 state
  return { messages: [new AIMessage(fullOutput)] };
})
```

### 数据流

```
graph.stream({ messages: [HumanMessage("你好")] })
    │
    ├─ checkpointer 加载历史 → state.messages
    │
    ▼
┌──────────────────────────────────────┐
│              chat 节点                │
│                                      │
│  state.messages ──► 提取历史/输入     │
│                        │             │
│                        ▼             │
│              ┌──────────────────┐    │
│              │  LCEL Chain      │    │
│              │  Prompt→Model→Parser │ │
│              └──────────────────┘    │
│                        │             │
│          stream 逐 token 输出        │
│              getWriter 推送 token    │
│                        │             │
│                  收集 fullOutput     │
│                        │             │
│  return { messages: [AIMessage] }    │
└──────────────────────────────────────┘
    │
    ├─ state.messages 自动追加新消息
    ├─ checkpointer 自动持久化
    │
    ▼
  graph.stream (custom 模式) 逐 token 产出 string
```

---

## 六、LCEL 的优势

1. **声明式**：用 `.pipe()` 串起来，结构清晰，一眼看懂数据流向
2. **统一接口**：所有组件都是 Runnable，统一支持 `invoke / stream / batch / streamLog` 等方法
3. **开箱即用的流式**：只要模型支持流式，整条链自动支持流式
4. **易于组合**：chain 可以嵌套，可以和分支、工具调用等组合
5. **自动类型推断**：TypeScript 下输入输出类型自动推导
