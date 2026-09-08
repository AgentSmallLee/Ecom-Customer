# Vue3 Composition API（组合式 API）

## 一、它是什么

Composition API 是 Vue 3 引入的一套**用函数组织逻辑**的 API，替代 / 补充 Vue 2 的 Options API（`data` / `methods` / `computed` / `watch` 分块写法）。

核心思想：**关注点分离 → 逻辑组合**。
Options API 按"选项类型"切分代码（一个功能的逻辑散落在 data/methods/生命周期里）；Composition API 按"功能"切分，把某个功能相关的响应式状态 + 方法 + 副作用集中在一个函数里，可以随意提取、复用、迁移。

## 二、核心组成

| 能力 | API | 说明 |
|------|-----|------|
| 组件入口 | `setup()` / `<script setup>` | 逻辑都在这里写，`<script setup>` 是编译期语法糖，顶层变量直接暴露给模板 |
| 响应式状态 | `ref()` | 把基本类型 / 对象包成响应式，模板中自动解包，逻辑中要 `.value` 访问 |
| 响应式对象 | `reactive()` | 对整个对象做深层响应式（本项目中未使用） |
| 计算属性 | `computed()` | 依赖派生的值，带缓存（本项目中未使用） |
| 监听 | `watch()` / `watchEffect()` | 响应式副作用（本项目中未使用） |
| 生命周期 | `onMounted` / `onBeforeUnmount` 等 | 用 `onXxx` 函数代替 Options 的生命周期选项 |
| 自定义组合函数 | 普通函数（命名 `useXxx`） | 组合式 API 的灵魂，官方称为 **Composable** |
| 依赖注入 | `provide` / `inject` | 跨层级传值，替代部分 `$parent` / props 透传 |

## 三、和 Options API 对比

| 维度 | Options API（Vue2） | Composition API（Vue3） |
|------|--------------------|------------------------|
| 组织方式 | 按选项类型分块（data/methods/watch） | 按功能逻辑分组 |
| 逻辑复用 | Mixin（命名冲突、来源不透明） | Composable（纯函数，显式返回） |
| TypeScript | 弱，`this.xxx` 推断困难 | 强，`ref<T>()`、函数返回类型都很好推断 |
| 抽离能力 | 基本只能靠 mixin，跨组件迁移成本高 | 逻辑独立成函数，任意组件引入即用 |
| 心智 | 上手平缓 | 需要理解响应式原理（`.value`、解包） |

## 四、本项目中用到了哪里（全部前端代码）

前端在 `client/` 目录，Vue3 + Vite + TypeScript。Composition API 体现在两处：

### 1. `<script setup lang="ts">` 语法糖 —— 所有 4 个视图组件

```vue
<script setup lang="ts">
import { ref, nextTick } from 'vue';
import { useChat } from '../composables/useChat.ts';

const { messages, streaming, streamText, error, sendMessage, clearMessages } = useChat();
const inputText = ref('');
</script>
```

- `client/src/views/ChatView.vue:107` — 基础对话页
- `client/src/views/AgentView.vue:93` — 订单查询页
- `client/src/views/RagView.vue:68` — 知识库问答页
- `client/src/views/GraphView.vue:87` — 智能客服（全功能模式，多 Agent 工作流）页

每个视图都是同一套模式：**模板里只用从 composable 解构出来的状态与方法，本地小状态用 `ref()` 声明**。
例如 `ChatView.vue` 里 `inputText = ref('')`（输入框内容）、`messagesRef = ref<HTMLElement | null>(null)`（模板引用，配合 `nextTick` 做自动滚动）。

### 2. 自定义 Composable —— `client/src/composables/` 下 4 个组合函数

这是本项目 Composition API 的核心体现：**所有业务逻辑都抽到组件外，组件只剩展示**。

| 文件 | 封装的功能 |
|------|-----------|
| `composables/useChat.ts` | 基础对话：SSE 流式读取、消息历史管理（取最近 10 条防 token 超限） |
| `composables/useAgent.ts` | 订单 Agent：流式、工具调用步骤（tool/input/observation）追踪 |
| `composables/useRag.ts` | 知识库问答：流式、参考来源（sources）展示 |
| `composables/useGraph.ts` | 智能客服：Graph 工作流节点轨迹、意图识别、短期/长期记忆标识（threadId / userId） |

典型结构（`useChat.ts` 的骨架）：

```ts
import { ref, nextTick } from 'vue';

export function useChat() {
  const messages  = ref<ChatMessage[]>([]);  // 响应式状态
  const streaming = ref(false);
  const error     = ref('');

  const sendMessage = async (...) => { ... };  // 方法
  const clearMessages = () => { ... };

  return { messages, streaming, error, sendMessage, clearMessages };  // 显式返回
}
```

关键点：
- 每个 composable 都是**普通函数**，内部用 `ref()` 建响应式状态，返回对象给组件解构。
- 返回的 `ref` 在组件中**解构后仍是响应式**（这是和 `reactive` 的一个关键差异，也是本项目直接解构使用的原因）。
- `useGraph.ts` 额外把 `NODE_LABELS`、`INTENT_LABELS` 这类纯常量也放在 composable 文件里导出，视图直接引用渲染节点轨迹，进一步说明 composable 是"按功能打包代码"的载体。

### 3. 用到的核心 API 盘点

- `ref()` — 所有响应式状态（消息数组、loading、error、当前节点、输入框内容、DOM 引用）
- `nextTick()` — 流式更新后等待 DOM 刷新再滚动到底部（`scrollToBottom`）
- `createApp(App).use(router).mount('#app')` — `main.ts:6` 应用创建入口

**未用到**：`reactive`、`computed`、`watch`、生命周期钩子（`onMounted` 等）、`provide/inject`。
（消息、loading、error 这些全是简单状态，用 `ref` 足够；没有派生状态所以不需要 `computed`。）

## 五、面试可讲的点

1. **为什么用 Composition API 而非 Options**：本项目 4 个页面共享同一套"流式对话 + 历史管理 + 错误提示"逻辑，用 `useChat/useAgent/useRag/useGraph` 分别抽离后，每个页面组件只剩 30~40 行逻辑 + 模板，逻辑跨页面复用、类型安全。
2. **`ref` vs `reactive`**：ref 包基本类型 / 单一值，模板自动解包、逻辑里 `.value`；reactive 包对象深层响应式但解构会丢失响应性，需要 `toRefs`。本项目状态简单，统一用 `ref`。
3. **组合式函数（composable）命名与约定**：`useXxx` 前缀、函数内部用 ref 建状态、return 出状态与方法，组件内解构直接用。
4. **配合 TypeScript**：`ref<T>()` 泛型约束（如 `ref<ChatMessage[]>([])`、`ref<HTMLElement | null>(null)`），比 Options API 的 `this` 推断友好得多。
5. **`<script setup>` 语法糖**：编译期自动把顶层声明暴露给模板，省去 `setup() { return {} }` 样板，且对 TS 更友好。
