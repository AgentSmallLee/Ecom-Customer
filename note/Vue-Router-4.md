# Vue Router 4 与当前项目用法

## 一、它是什么

Vue Router 是 Vue 官方的**单页应用（SPA）路由库**。Vue Router 4 是配合 Vue 3 的大版本（Vue 2 对应的是 Router 3）。

作用：在**不刷新页面**的前提下，通过改变 URL 来切换视图组件，并负责：
- URL 与组件的一一映射（route table）
- 视图切换（`router-view` 出口 + 组件渲染）
- 导航（`router-link` 声明式跳转 / `router.push` 编程式跳转）
- 路由元信息（`meta`）、导航守卫、懒加载等

## 二、Vue Router 4 相对 3 的关键变化

| 变化点 | Router 3（Vue2） | Router 4（Vue3） |
|--------|-----------------|------------------|
| 创建方式 | `new VueRouter({...})` | `createRouter({...})`（工厂函数） |
| 接入 | `new Vue({ router })` | `app.use(router)`（插件机制，配合 Vue3 `createApp`） |
| History 模式 | `mode: 'history'` | `history: createWebHistory()`（显式传入 history 对象） |
| 类型支持 | 弱 | 内置完整 TS 类型，支持 `RouteMeta` 模块扩展 |
| Composition API | 无 | `useRouter()` / `useRoute()` 组合式 API |
| 滚动行为 API | 差异较大 | 内部基于 history 状态实现，更统一 |

## 三、本项目如何使用的（全部前端代码）

### 1. 创建路由器 —— `client/src/router/index.ts`

```ts
import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  { path: '/',       component: ChatView,  meta: { title: '基础对话' } },
  { path: '/agent',  component: AgentView, meta: { title: 'Agent 订单查询' } },
  { path: '/rag',    component: RagView,   meta: { title: '知识库问答' } },
  { path: '/graph',  component: GraphView, meta: { title: '多 Agent 中枢' } },
];

export default createRouter({
  history: createWebHistory(),   // HTML5 History 模式，URL 无 #
  routes,
});
```

用到的东西：
- **`createRouter` + `createWebHistory`**：HTML5 History 模式（URL 是 `/agent` 而不是 `/#/agent`）。
- **静态路由表**：4 条顶层路由，对应 4 个视图组件（基础对话 / 订单查询 / 知识库 / 智能中枢）。
- **`meta` 路由元信息**：每条的 `title` 用于后续路由守卫里设置页面标题（本项目只声明了 meta，未写守卫消费它）。
- **`RouteMeta` 类型扩展（模块增强）**：

  ```ts
  declare module 'vue-router' {
    interface RouteMeta {
      title: string;
    }
  }
  ```
  让 `meta.title` 在 TS 下能拿到类型提示——这是 Router 4 + TS 的典型玩法。

### 2. 接入应用 —— `client/src/main.ts:6`

```ts
createApp(App).use(router).mount('#app');
```
以 Vue3 **插件机制**注册，替代 Vue2 的 `new Vue({ router })`。

### 3. 模板中的路由组件 —— `client/src/App.vue`

```html
<nav class="nav-links">
  <router-link to="/">基础对话</router-link>
  <router-link to="/agent">订单查询</router-link>
  <router-link to="/rag">知识库</router-link>
  <router-link to="/graph">智能中枢</router-link>
</nav>
<router-view />
```

- **`<router-link to="...">`**：声明式导航，点击切换路由，无需刷新。
- **`<router-view />`**：路由出口，当前匹配到的组件在这里渲染。
- `App.vue:50` 的 `.nav-links a.router-link-active` 样式：Router 自动给当前激活的链接加 `router-link-active` 类，实现导航高亮（蓝色底）。

### 4. 与后端的关系（值得提一句）

前端 4 个页面各自调 NestJS 后端不同的 API（`/chat/stream`、`/agent/stream`、`/rag/query`、`/graph/stream`），Vite dev server 跑在 5173，后端在 3000。路由只负责**前端页面切换**，不负责 API 分发。

## 四、用到的 vs 没用到的

**用到的**：`createRouter`、`createWebHistory`、静态路由表、`meta`、`RouteMeta` 类型扩展、`app.use(router)`、`router-link`、`router-view`、`.router-link-active`。

**没用到的**（面试可如实说）：
- 动态路由参数（`/order/:id`）、`query`/`params`
- 编程式导航（`useRouter` / `router.push`）——本项目导航全靠 `router-link`
- `useRoute()` 组合式 API
- 导航守卫（`beforeEach` 等）——`meta.title` 声明了但没消费
- 路由懒加载（`component: () => import(...)`）——目前全部静态 import
- `createWebHashHistory`（hash 模式）、嵌套路由（children）

## 五、面试注意点

1. **为什么 4 个页面用路由而非多页（MPA）**：SPA 无刷新切换 + 共享 `App.vue` 里的全局导航栏，符合"客服演示台"的多模式切换场景。
2. **History 模式 vs Hash 模式**：`createWebHistory` 的 URL 干净，但**部署时服务端需做 SPA fallback**（把所有路径 fallback 到 `index.html`），否则刷新 `/agent` 会 404；hash 模式（`/#/agent`）无需服务端配置但 URL 难看。本项目开发用 Vite 自带 fallback，生产部署需注意。
3. **`router-link-active` vs `router-link-exact-active`**：默认给当前激活链接加 `router-link-active`；嵌套路由下前缀也匹配，精确匹配才用 `router-link-exact-active`。
4. **RouteMeta 类型增强**：Router 4 用 `declare module 'vue-router'` 扩展 `RouteMeta`，让 `meta.xxx` 有类型——本项目已实践（`router/index.ts:9-13`）。
5. **Router 4 是插件**：`app.use(router)`，因此天然适配 Vue3 的 Composition API 生态（`useRouter`/`useRoute` 随时可用，本项目暂未用到）。
