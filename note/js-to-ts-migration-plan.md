# 本项目 JS → TS 全量改造方案

> 盘点当前项目所有 JS 代码，梳理改造涉及的每一处改动和推荐步骤。配合 [[ts-vs-js-for-ai-agent]] 阅读。
>
> **✅ 本方案已于 2026-09-06 实际执行完毕**，实际执行与方案的差异记录在文末「实际执行记录」。

## 一、改造范围盘点

### server（20 个 JS 文件）

| 文件 | 作用 | TS 改造要点 |
|------|------|------------|
| `src/index.js` | Express 入口 | 给 `app.listen` 回调、路由挂载补类型（基本零改动） |
| `src/models/deepseek.js` | ChatOpenAI 封装 | 补 `options` 参数类型 `Partial<ChatOpenAIClientOptions>` |
| `src/models/embedding.js` | Embedding 封装 | 几乎零改动 |
| `src/db/postgres.js` | pg 连接池 | 补 `process.env` 的类型（需配合 env.d.ts） |
| `src/chains/basic-chat.js` | 基础对话 Chain | `formatHistory` 的入参要定义 `ChatMessage` 接口 |
| `src/chains/rag-chain.js` | RAG Chain | 顶层 `await`（ESM 支持，tsconfig 需配好） |
| `src/agents/customer-agent.js` | ReAct Agent | `createReactAgent` 泛型自动推导 |
| `src/tools/order-tools.js` | 三个 zod 工具 | **收益最大**：zod schema 自动推导入参类型 |
| `src/prompts/customer-service.js` | Prompt 模板 | 几乎零改动 |
| `src/data/mock.js` | Mock 数据 | 给 `orders`/`logistics` 定义 `Order`/`LogisticsRecord` 接口 |
| `src/graphs/state.js` | LangGraph 状态 | **收益最大**：`Annotation` 泛型，定义 `GraphStateType` |
| `src/graphs/customer-graph.js` | 图编排 | 节点/边可拿到状态类型 |
| `src/graphs/nodes/*.js`（5 个） | 图节点 | 每个节点函数用 `GraphStateType` 标注入参 |
| `src/routes/*.js`（4 个） | Express 路由 | 补 `req.body` 的类型；`send()` helper 定义 SSE 事件联合类型 |
| `src/scripts/init-db.js`、`ingest.js` | 脚本 | 零/少量改动 |

### client（7 个 JS 文件 + 4 个 Vue SFC）

| 文件 | TS 改造要点 |
|------|------------|
| `vite.config.js` | 改名 `vite.config.ts`，零改动 |
| `src/main.js` | 改名 `.ts`，零改动 |
| `src/router/index.js` | 补 `meta` 类型（vue-router 的 `RouteMeta` 声明合并） |
| `src/composables/*.js`（4 个） | **收益最大**：`Message`、SSE 事件等接口定义 |
| `src/views/*.vue`、`App.vue` | `<script>` 改 `<script setup lang="ts">`，补 ref 泛型 |

### 共享类型（改造时新增）

新建 `shared/types.ts`（或前后端各自维护），定义前后端契约：SSE 事件 `type: 'sources' | 'answer' | 'done' | 'error'`、消息 `{ role, content }` 等。

---

## 二、改动步骤

### 阶段 0：准备（不动代码）

```bash
# server
cd server
npm i -D typescript tsx @types/node @types/express @types/cors

# client（如果 vite 脚手架创建时没选 TS）
cd ../client
npm i -D typescript vue-tsc @vue/tsconfig
```

`tsx` 是关键：它直接运行 `.ts` 文件，不需要预编译，dev 体验和现在完全一致。

### 阶段 1：server 的 tsconfig

新建 `server/tsconfig.json`：

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true,
    "allowImportingTsExtensions": true,   // 允许 import 写 .ts 后缀
    "noEmit": true,                          // 只做类型检查，运行交给 tsx
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

同时新建 `server/src/types/env.d.ts` 处理环境变量：

```ts
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      DEEPSEEK_API_KEY: string;
      DEEPSEEK_BASE_URL?: string;
      MODEL_NAME?: string;
      PORT?: string;
      ZHIPU_API_KEY?: string;
      DASHSCOPE_API_KEY?: string;
      PG_HOST?: string;
      PG_PORT?: string;
      PG_USER?: string;
      PG_PASSWORD?: string;
      PG_DATABASE?: string;
    }
  }
}
export {};
```

### 阶段 2：改 package.json 脚本

```json
{
  "scripts": {
    "dev": "nodemon --exec tsx src/index.ts",
    "start": "tsx src/index.ts",
    "init-db": "tsx src/scripts/init-db.ts",
    "ingest": "tsx src/scripts/ingest.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

> nodemon 需要让它监听 `.ts` 文件：`nodemon --watch src --ext ts --exec tsx src/index.ts`，或在 `nodemon.json` 里配置。

### 阶段 3：按依赖顺序逐目录迁移（重命名 + 补类型）

推荐顺序（被依赖的先迁，迁完一个目录跑一次服务验证）：

```
models → db → data → prompts → tools → chains → agents → graphs → routes → index
scripts（init-db / ingest 最后迁，或顺手一起）
```

**每一步的机械操作**：文件重命名 `.js` → `.ts`，然后把所有 import 路径里的 `.js` 后缀改成 `.ts`（ESM 显式后缀 + `allowImportingTsExtensions`）。

各目录的具体类型工作：

**① `data/mock.ts`** — 最底层，先定义领域类型：

```ts
export interface OrderItem { name: string; qty: number; price: number; }
export interface Order {
  orderId: string; userId: string; status: string;
  createTime: string; amount: number; items: OrderItem[];
  carrier: string | null; trackingNo: string | null;
}
export interface LogisticsRecord { time: string; location: string; desc: string; }

export const orders: Record<string, Order> = { ... };
export const logistics: Record<string, LogisticsRecord[]> = { ... };
```

**② `tools/order-tools.ts`** — zod 自动推导，几乎免费获得类型：

```ts
export const getOrderInfoTool = tool(
  async ({ orderId }) => {       // orderId 自动推导为 string
    ...
  },
  { name: 'getOrderInfo', schema: z.object({...}) }
);
```

**③ `graphs/state.ts`** — 定义状态类型：

```ts
import { Annotation, MessagesAnnotation } from '@langchain/langgraph';

export const GraphState = Annotation.Root({
  ...MessagesAnnotation.spec,
  userInput: Annotation<string>({ reducer: (_, next) => next, default: () => '' }),
  intent: Annotation<'order' | 'knowledge' | 'general'>({
    reducer: (_, next) => next, default: () => 'general',
  }),
  orderResult: Annotation<string | null>({ ... }),
  ragResult: Annotation<string>({ ... }),
  finalAnswer: Annotation<string>({ ... }),
});

export type GraphStateType = typeof GraphState.State;
```

**④ `graphs/nodes/*.ts`** — 每个节点用状态类型：

```ts
import type { GraphStateType } from '../state';

export const intentRouterNode = async (state: GraphStateType) => {
  const { userInput } = state;   // userInput: string，有补全
  ...
  return { intent: final };      // 返回值也被校验为 Partial<GraphStateType>
};
```

注意 `routeByIntent` 的返回值联合类型：`'orderAgent' | 'ragNode' | 'generalChat'`，与 `customer-graph.ts` 里 `addConditionalEdges` 的映射对象 key 对齐。

**⑤ `chains/basic-chat.ts`** — 定义消息类型：

```ts
export interface ChatMessage { role: 'user' | 'assistant'; content: string; }
export const formatHistory = (history: ChatMessage[] = []) => { ... };
```

**⑥ `routes/*.ts`** — SSE 事件联合类型（前后端共享的契约）：

```ts
type SseEvent =
  | { type: 'sources'; sources: SourceInfo[] }
  | { type: 'answer'; content: string }
  | { type: 'done' }
  | { type: 'error'; content: string };

router.post('/query', async (req: Request, res: Response) => {
  const { question } = req.body as { question?: string };
  ...
});
```

### 阶段 4：client 改造

① 新建 `client/tsconfig.json`（或直接扩展 `@vue/tsconfig`）：

```json
{
  "extends": "@vue/tsconfig/tsconfig.dom.json",
  "compilerOptions": {
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "src/**/*.vue"]
}
```

② 新建 `client/src/vite-env.d.ts`：

```ts
/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
```

③ `vite.config.js` → `vite.config.ts`；`main.js` → `main.ts`（`index.html` 里的引用同步改）；`router/index.js` → `index.ts`，并给 meta 加类型：

```ts
import 'vue-router';
declare module 'vue-router' {
  interface RouteMeta { title: string; }
}
```

④ 四个 composables 补类型，例如 `useChat.ts`：

```ts
interface ChatMessage { role: 'user' | 'assistant'; content: string; }
const messages = ref<ChatMessage[]>([]);
const streaming = ref(false);
```

⑤ 四个 `.vue` 文件：`<script setup>` → `<script setup lang="ts">`，给 `ref()` 补泛型、函数入参补类型。

⑥ `package.json` 增加 `"build": "vue-tsc -b && vite build"`。

### 阶段 5：收尾验证

```bash
# server
cd server && npm run typecheck && npm run init-db && npm run ingest && npm run dev

# client
cd client && npx vue-tsc --noEmit && npm run dev
```

前端四个页面各点一遍（基础对话 / Agent / RAG / Graph），确认 SSE 流式输出正常。

---

## 三、容易踩的坑

1. **import 后缀**：ESM + NodeNext 下 import 必须写显式后缀。选 `allowImportingTsExtensions` + `tsx` 运行时，import 直接写 `.ts`，一步到位。
2. **`rag-chain.ts` 的顶层 `await`**：`module` 必须是 ESM（`NodeNext`），且 `package.json` 保持 `"type": "module"`，否则报错。
3. **`pg` 无官方类型**：其实自带（pg 8.x 自带类型声明），但 `process.env.PG_PORT` 是 string，要 `parseInt`——现有代码已经做了，迁 TS 后类型能对上。
4. **express 5 类型变化**：本项目是 express 4，装 `@types/express@^4` 即可，注意版本对齐。
5. **渐进式混用**：tsconfig 加 `"allowJs": true`，可以一个目录一个目录迁，`.ts` 和 `.js` 互相 import 没问题。
6. **`.vue` 文件类型**：不写 `vite-env.d.ts` 里的 `declare module '*.vue'`，`router` 里 import view 会满屏报错。

## 四、工作量估计

- server：约 20 个文件，大部分是"重命名 + 少量注解"，真正的类型设计集中在 `state.ts`、`mock.ts`、SSE 事件三处，半天到一天。
- client：约 11 个文件，composables 和 vue 文件改动多一些，半天。
- 总计 **1～2 天**，可渐进式进行，随时可停、随时可续。

---

## 五、实际执行记录（与方案的差异）

1. **TypeScript 版本固定为 5.9.x**：npm 默认装了 `typescript@7`（新的原生编译器），与 `vue-tsc@3` 不兼容（`./lib/tsc` 子路径未导出），前后端统一降级到 `^5.9.2`。
2. **需要 `@types/pg`**：`pg` 包虽自带类型，但 ESM 入口 `esm/index.mjs` 下 tsc 找不到声明，需显式安装 `@types/pg`。
3. **`@types/express` 必须对齐主版本**：npm 默认装了 `@types/express@5`，与 `express@4` 不匹配，手动固定为 `^4.17.23`。
4. **`msg.tool_calls` 需要类型收窄**：LangChain v1 的 `result.messages` 是 `BaseMessage[]`，`tool_calls` 只存在于 `AIMessage` 上，需 `msg instanceof AIMessage` 守卫后再访问（`order-agent.ts`、`routes/agent.ts` 两处）。
5. **`routes/graph.ts` 的裸对象改为 `AIMessage`**：原代码用 `{ _getType: () => 'ai', content }` 裸对象冒充 AI 消息，类型不兼容，改为直接 `new AIMessage(...)`，行为不变。
6. **消息 content 需统一转字符串**：`BaseMessage.content` 是 `string | MessageContentComplex[]`，新增 `contentToString()` 工具函数处理。
7. **client 增加了 `src/types.ts`**：定义 `ChatMessage`、`ToolStep`、`SourceInfo` 共享契约类型，四个 composable 共用。

验证结果：
- `server`：`tsc --noEmit` ✅、`tsx src/index.ts` 启动 ✅、`/api/chat/health` ✅、SSE 流式对话端到端 ✅
- `client`：`vue-tsc --noEmit` ✅、`vite build` ✅（43 个模块）、dev server ✅
