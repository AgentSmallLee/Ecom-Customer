# LCEL：RunnablePassthrough.assign 与并行分支（RunnableParallel）对比

## 一、两种写法

### 写法 A：RunnablePassthrough.assign

```ts
RunnableSequence.from([
  RunnablePassthrough.assign({
    docs: (input: { question: string }) => retriever.invoke(input.question),
  }),
  {
    answer: ...,
    sources: ...,
  },
]);
```

**核心行为**：保留原始输入的所有字段，再追加新字段。输入有什么，输出就有什么，再加上 assign 的字段。

```
输入 { question }
  → 透传 { question } + 新增 { docs }
  → 输出 { question, docs }
```

---

### 写法 B：并行分支（对象字面量 = RunnableParallel）

```ts
RunnableSequence.from([
  {
    docs:     (input: { question: string }) => retriever.invoke(input.question),
    question: (input: { question: string }) => input.question,
  },
  {
    answer: ...,
    sources: ...,
  },
]);
```

**核心行为**：每个字段都显式声明，并行执行后组装成新对象。输出结构完全由你定义的 key 决定。

```
输入 { question }
  → docs 分支 + question 分支 并行执行
  → 输出 { question, docs }
```

---

## 二、对比表

| 维度 | RunnablePassthrough.assign | 并行分支（对象字面量） |
|---|---|---|
| **数据透传** | 自动透传所有输入字段 | 每个字段都要显式声明 |
| **输出结构** | 输入字段 + 新增字段 | 完全由 key 定义，想输出什么写什么 |
| **代码量** | 字段多时更简洁 | 字段少时清晰，字段多了啰嗦 |
| **可读性** | 输出字段不直观，需要往上看输入 | 输出结构一目了然 |
| **灵活性** | 只能追加字段，不能删减 | 可自由增删字段，完全控制输出 |
| **风格统一** | 独立风格 | 与 `ragChain` 等标准 LCEL 写法一致 |

---

## 三、使用场景

### ✅ 推荐用 `Passthrough.assign` 的场景

1. **输入字段多，只追加少量新字段**
   - 比如输入有 10 个字段，只想再加 1 个，用 assign 不用一个个写透传

2. **需要完整保留上游数据**
   - 下游还需要用到原始输入的很多字段，assign 自动透传最省事

3. **链式调用中间步骤**
   - 在一条长链中间逐步丰富数据，每一步都默认保留之前的所有字段

### ✅ 推荐用并行分支的场景

1. **想明确控制输出结构**
   - 只需要特定的几个字段，不想把上游所有字段都带下去

2. **字段数量少**
   - 比如就 2-3 个字段，显式写出来更清晰，读代码的人一眼就知道输出有什么

3. **链的入口处**
   - 第一步把原始输入转换成链内部需要的结构，显式定义更清楚

4. **需要和项目风格保持一致**
   - 项目里其他 chain 都用并行分支写法，保持统一

---

## 四、实际项目中的选择建议

在本项目（ecom-ai-customer）中：

- `ragChain` 用的是**并行分支**写法
- `ragChainWithSources` 当前用的是 **Passthrough.assign + 并行分支** 混合写法

如果追求风格统一，可以把 `ragChainWithSources` 的第一步也改成并行分支：

```ts
export const ragChainWithSources = RunnableSequence.from([
  {
    docs:     (input: { question: string }) => retriever.invoke(input.question),
    question: (input: { question: string }) => input.question,
  },
  {
    answer: RunnableSequence.from([
      (input) => ({ context: formatDocs(input.docs), question: input.question }),
      ragPrompt,
      model,
      new StringOutputParser(),
    ]),
    sources: (input) => input.docs.map(doc => ({
      content: doc.pageContent.slice(0, 100) + '...',
      source:  doc.metadata.source,
    })),
  },
]);
```

**两种写法最终效果完全一样，选择哪种主要看团队风格和可读性偏好。**

---

## 五、记忆口诀

> **追加用 assign，重组用对象**
>
> - 想在原有基础上**加东西** → `Passthrough.assign`
> - 想**重新定义**输出有什么 → 并行分支（对象字面量）
