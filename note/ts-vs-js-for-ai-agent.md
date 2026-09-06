# AI Agent 项目：TypeScript vs JavaScript 技术选型

> 结合本项目（LangChain + LangGraph + Express 的电商 AI 客服系统）的实际代码，分析 AI Agent 项目应该选 TS 还是 JS。

## 结论先行

**推荐 TypeScript，尤其是团队协作和长期维护的项目。**

- 如果是**个人学习、快速原型验证**（比如跟着教程做 demo），JS 完全够用，上手快、心智负担低。
- 如果是**要长期迭代、多人协作、会接入生产环境**的 Agent 项目，TS 的收益会随项目复杂度线性放大。

---

## 为什么 AI Agent 项目特别适合 TS

AI Agent 开发有几个区别于普通 Web 项目的特点，这些特点恰好命中 JS 的痛点：

### 1. 数据结构复杂且层层嵌套

Agent 项目里到处都是复杂的数据结构：图状态（Graph State）、工具的输入输出 schema、LLM 的结构化输出、检索到的 Document、消息历史……以本项目为例：

```js
// server/src/graphs/state.js — LangGraph 的图状态
export const GraphState = Annotations.Root({ ... });
```

用 JS 时，一个字段拼错了（比如 `mesages` 少个 s）、一处返回结构不一致，往往要到运行时深处才报错，而且报错信息是 "Cannot read properties of undefined"，很难定位。TS 在编写阶段就能标红。

### 2. LangChain / LangGraph 本身是类型驱动的框架

LangChain 的核心抽象（`Runnable`、`BaseMessage`、`StructuredTool`）都定义了严格的泛型接口。用 TS 时：

- `tool()` 函数可以直接用 zod schema 推导出工具的输入类型
- `RunnableSequence` 的输入输出类型能自动串联推导
- IDE 补全能直接告诉你某个 node 接收什么状态、该返回什么

用 JS 调这些库，等于放弃了库作者专门设计的"类型护栏"，只能靠文档和试错。

### 3. Agent 是"多步黑盒"，出了错很难调试

一次 Agent 调用链是：LLM 生成 → 解析 → 工具执行 → 结果回填 LLM → 再生成……中间任何一步的数据形状不对，整个链条就崩了。JS 只能靠 `console.log` 一层层打；TS 把其中**结构性的错误**（类型不匹配、缺字段）在编译期就消灭掉，让你只需调试真正的**逻辑错误**。

### 4. 重构时的安全网

Agent 项目的重构频率很高：改 prompt 结构、加工具、调整图的节点和边。TS 下改一个 State 字段名，所有引用处立刻报错，改完即正确；JS 下则是全局搜索 + 祈祷没漏。

---

## LangChain 官方本身就有 TS 版本（重要论据）

很多人以为 TS 需要"额外找类型包"，但对于 LangChain 生态来说恰恰相反：

1. **LangChain.js 本身就是用 TypeScript 写的**。官方 JS/TS 生态（`langchain`、`@langchain/core`、`@langchain/openai`、`@langchain/langgraph`、`@langchain/community`……）的源码就是 TS，npm 上发布的是**编译产物自带 `.d.ts` 类型声明**——也就是说本项目 `package.json` 里装的那些包，类型支持是官方原生的、开箱即用的，不需要 `@types/xxx`。

2. **官方文档双轨并行**。LangChain 官方文档对每个示例都提供 Python / JS / TS 三种 tab，其中 TS 版本的示例大量使用了泛型、zod schema 类型推导等写法，说明官方推荐姿势就是 TS。

3. **LangGraph.js 的类型设计更深**。`StateGraph` 的 state 类型可以一路贯穿到每个节点的入参、条件路由的返回值上，用 TS 编写相当于直接使用框架的"完整形态"。

4. **zod schema 双向复用**。LangChain 的 `tool()` 接受 zod schema，在 TS 下这个 schema 既能做运行时校验，又能直接推导出工具入参的静态类型，一份代码两用。

> 换句话说：**在这些库里，TS 不是"额外的可选层"，而是框架的第一公民**。用 JS 反而像是把官方精心设计的类型系统主动关掉了。

## TS 的成本（诚实的另一面）

| 成本 | 说明 |
|------|------|
| **初始配置** | `tsconfig.json`、构建流程（`tsx`/`ts-node` 或先编译再运行），比 JS 直接 `node xxx.js` 麻烦 |
| **学习曲线** | 泛型、类型体操对新手有门槛；LangChain 的类型推导报错信息有时很难读懂 |
| **与动态数据的摩擦** | LLM 输出本质是不可信的运行时数据，仍需 zod 等运行时校验配合，类型不是银弹 |
| **迭代速度** | 写 demo 时类型约束确实会拖慢"先跑起来再说"的速度 |

## JS 的适用场景

- 跟教程学习 LangChain / LangGraph 概念（绝大多数教程是 JS）
- 一次性脚本、快速验证一个 prompt 思路
- 个人小项目，代码量 < 几千行

---

## 针对本项目的具体建议

本项目目前是纯 JS（ESM），如果迁移到 TS，收益最大的几处：

1. **`server/src/graphs/state.js`** — LangGraph 的 `Annotations` 配合 TS 泛型，每个节点收到的 state 都有完整类型提示。
2. **`server/src/tools/order-tools.js`** — 工具的 zod schema 能直接推导出 TS 类型，工具函数签名天然类型安全。
3. **`server/src/chains/rag-chain.js`** — `RunnableSequence` 的类型串联能校验 chain 每一步的输入输出。
4. **前后端接口契约** — client（Vue 3）也可以用 TS，前后端共享类型定义，SSE 事件的 `type: 'sources' | 'answer' | 'done' | 'error'` 这类联合类型可以统一维护。

### 渐进式迁移路径（如果要做）

> 详细的逐文件改造方案见 [[js-to-ts-migration-plan]]。

```
1. 安装依赖：npm i -D typescript tsx @types/node
2. 新文件用 .ts，旧文件保持 .js（allowJs: true），互不干扰
3. 按目录逐步迁移：models → db → tools → chains → graphs → routes → index
4. dev 脚本改为：nodemon --exec tsx src/index.ts
```

---

## 一句话总结

> **JS 决定了你写得多快，TS 决定了三个月后你还能不能看懂自己写的 Agent。**
>
> Agent 项目数据结构复杂、调用链长、重构频繁，恰好是类型系统发挥价值最大的地方。学习阶段用 JS 没问题；一旦项目要认真做下去，尽早切 TS。
