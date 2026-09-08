# LCEL：RunnableSequence 与 RunnableParallel 详解

## 一、RunnableSequence（顺序执行）

### 是什么

把多个 Runnable **按顺序串联**起来，上一个的输出是下一个的输入，形成一条处理链。

### 两种等价写法

```typescript
// 写法一：.pipe() 管道语法（最常用）
const chain = prompt.pipe(model).pipe(parser);

// 写法二：RunnableSequence.from 数组语法
import { RunnableSequence } from '@langchain/core/runnables';
const chain = RunnableSequence.from([prompt, model, parser]);
```

两者底层都是 `RunnableSequence`，**功能完全等价**，只是语法不同。

### 区别与适用场景

| 写法 | 适用场景 | 特点 |
|------|---------|------|
| `.pipe()` | 静态链，结构固定 | 链式调用，从左到右读，直观 |
| `RunnableSequence.from([])` | 动态链，运行时才知道有几步 | 数组形式，循环里 push 方便 |

### 动态组装示例

```typescript
const steps = [prompt];

if (useRetriever) {
  steps.push(retriever);
}

steps.push(model, parser);

const chain = RunnableSequence.from(steps);
```

---

## 二、RunnableParallel（并行执行）

### 是什么

用一个**对象**来表示多个并行分支，每个属性值都是一个函数或 Runnable，它们会**同时执行**，最后把所有分支的结果组装成一个新对象，传给下一个组件。

```typescript
{
  context:  (input) => retriever.pipe(formatDocs).invoke(input.question),
  question: (input) => input.question,
}
```

这个对象会被 LangChain 自动包装成 `RunnableParallel`。

### 数据流

```
输入: { question: "退换货政策是什么？" }
    │
    ├── context 分支 ──→ retriever 检索文档 ──→ "文档1 文档2..."
    │
    └── question 分支 ──→ 直接透传 ──→ "退换货政策是什么？"
    │
    ▼
输出: { context: "文档1 文档2...", question: "退换货政策是什么？" }
```

### 为什么属性名是 context / question

因为下一个组件（通常是 PromptTemplate）的模板变量名就叫 `context` 和 `question`，必须**一一对应**才能正确填充：

```
prompt 模板：
  请根据以下内容回答用户问题。
  知识库内容：{context}
  用户问题：{question}
```

并行对象的属性名 = prompt 模板的变量名。

### 分支数任意

不一定是两个分支，可以任意多个，取决于下一环需要多少输入变量：

```typescript
{
  context:     (i) => retrieve(i.query),
  question:    (i) => i.query,
  userProfile: (i) => getUserProfile(i.userId),
  language:    (i) => i.lang || 'zh-CN',
}
```

---

## 三、组合使用（最常见的 RAG 链结构）

实际项目中经常把 Sequence 和 Parallel 组合使用，最典型的就是 RAG 链：

```typescript
export const ragChain = RunnableSequence.from([
  // 第一步：并行分支（RunnableParallel）
  // 同时做：检索文档 + 透传问题
  {
    context:  (input: { question: string }) => retriever.pipe(formatDocs).invoke(input.question),
    question: (input: { question: string }) => input.question,
  },
  // 第二步：填充 prompt
  ragPrompt,
  // 第三步：调用模型
  model,
  // 第四步：解析输出
  new StringOutputParser(),
]);
```

### 完整数据流

```
输入: { question: "xxx" }
    │
    ▼
┌─────────────────────────────────┐
│  RunnableParallel               │
│  context: 检索文档              │
│  question: 透传问题             │
└──────────────┬──────────────────┘
               ▼
      { context: "...", question: "..." }
               │
               ▼
          ragPrompt（填模板）
               │
               ▼
            model 调用
               │
               ▼
        StringOutputParser
               │
               ▼
         纯文本答案字符串
```

---

## 四、执行原理：上一个的输出怎么变成下一个的输入

### 核心：统一的 invoke 接口

所有 LCEL 组件都是 **Runnable**，都有统一的 `invoke(input)` 方法。链条内部就是一个**接力循环**——把上一步的返回值当作下一步的入参，依次调用。

### 伪代码实现

```typescript
// RunnableSequence.invoke 的大致逻辑：
async invoke(input) {
  let current = input;
  for (const step of this.steps) {
    current = await step.invoke(current);  // 上一步输出 = 下一步输入
  }
  return current;
}
```

### 实际执行过程（以 prompt → model → parser 为例）

```typescript
const chain = prompt.pipe(model).pipe(parser);
chain.invoke({ user_input: "你好", chat_history: [...] });
```

| 步骤 | 组件 | 输入 | 输出 |
|------|------|------|------|
| 第 1 步 | prompt | `{ user_input: "你好", chat_history: [...] }` | `[SystemMessage, HumanMessage]` |
| 第 2 步 | model | `[SystemMessage, HumanMessage]` | `AIMessage("你好呀")` |
| 第 3 步 | parser | `AIMessage("你好呀")` | `"你好呀"` |

最终返回字符串 `"你好呀"`。

### 流式执行也是同样的原理

`stream()` 也是接力，只不过每一步返回的是**异步迭代器**，不是最终值：

```
第 1 步：prompt 同步产出 messages（不产生流）
第 2 步：model 流式产出 AIMessageChunk（真正的流源头）
第 3 步：parser 逐个接收 chunk，转成字符串后往下传

最终返回一个字符串异步迭代器
```

### RunnableParallel 呢？

并行分支也一样——每个分支独立调用自己的 `invoke(input)`，所有分支完成后把结果拼成对象，作为下一步的输入：

```typescript
// RunnableParallel.invoke 的大致逻辑：
async invoke(input) {
  const results = {};
  for (const [key, runnable] of Object.entries(this.branches)) {
    results[key] = await runnable.invoke(input);  // 每个分支都拿到同一个 input
  }
  return results;
}
```

---

## 五、快速记忆

| 概念 | 作用 | 写法 |
|------|------|------|
| RunnableSequence | **顺序**执行，上一个的输出是下一个的输入 | `.pipe()` 或 `RunnableSequence.from([])` |
| RunnableParallel | **并行**执行多个分支，结果组装成对象 | 对象字面量 `{ key: fn, ... }` |

**一句话总结：**
> 数组/管道 = 串起来按顺序跑；对象 = 拆成多个分支并行跑，最后拼成一个对象往下传。

**执行原理：**
> 所有组件都是 Runnable，统一有 `invoke(input)` 方法，链条内部就是循环调用，上一步的返回值 = 下一步的入参。
