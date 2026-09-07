# Vite 与当前项目用法

## 一、它是什么

Vite 是 Vue 官方团队出品的**下一代前端构建工具**（法语 "快" 的意思），目前也是 Vue 官方脚手架 `create-vue` 的默认构建器。它解决传统打包器（Webpack）在大项目里"启动慢、改一下热更新等半天"的痛点。

两个核心设计：
1. **开发环境：原生 ESM + 按需编译**。不预先打包整个项目，浏览器直接请求一个个 ES Module 文件，Vite 只对当前用到的文件做即时转译（esbuild），所以启动秒开、HMR 毫秒级。
2. **生产环境：Rollup 打包**。`vite build` 用 Rollup 做 tree-shaking 与产物优化，产出可用于部署的静态文件。

## 二、核心概念

| 概念 | 说明 |
|------|------|
| Dev Server | 开发服务器，直接托管源码（按需编译 + HMR） |
| HMR | 热更新：改代码只替换改动的模块，不刷新页面、不丢状态 |
| 预构建依赖 | 用 esbuild 把 node_modules 里的依赖预打包成 ESM（如 Vue），浏览器不用逐个解析 |
| `index.html` 入口 | Vite 以项目根目录的 `index.html` 为入口，`<script type="module">` 指向 `main.ts` |
| Rollup 打包 | 生产构建工具，负责 tree-shaking、代码分割、压缩 |
| 插件 | `@vitejs/plugin-vue` 让 Vite 认识 `.vue` 单文件组件 |
| 环境变量 | `import.meta.env`（`import.meta.env.DEV` / `.PROD` 等） |

## 三、当前项目如何使用的

前端在 `client/` 目录，Vite 5 + Vue3 + TS。

### 1. 配置文件 —— `client/vite.config.ts`（全部内容）

```ts
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],          // 让 Vite 能编译 .vue 单文件组件
  server: {
    port: 5173,              // 开发服务器端口
  },
});
```

用到的：
- **`@vitejs/plugin-vue`**：核心插件，处理 SFC 的 `<template>` / `<script>` / `<style scoped>` 编译。
- **`server.port: 5173`**：固定开发端口（后端 NestJS 跑在 3000，前后端分离开发）。
- `defineConfig`：类型友好的配置封装（TS 提示）。

### 2. 脚本 —— `client/package.json`

```json
"scripts": {
  "dev": "vite",                    // 启动开发服务器（HMR）
  "build": "vue-tsc --noEmit && vite build",   // 先类型检查，再打包
  "preview": "vite preview",        // 本地预览打包产物
  "typecheck": "vue-tsc --noEmit"   // 仅类型检查
}
```

- `dev` → `vite`：起本地 dev server，配 `@vitejs/plugin-vue`，改代码热更新。
- `build` → **`vue-tsc --noEmit && vite build`**：生产构建前先跑一遍 TS 类型检查（`vue-tsc`），过了才让 `vite build` 打包。这是 Vue3 + TS 项目的标准搭配——**Vite 本身不检查类型，只做转译**，类型检查靠 `vue-tsc`。
- `preview` → `vite preview`：本地起一个静态服务器预览 `dist/` 产物，验证生产构建结果。

### 3. 入口 —— `client/index.html`

```html
<div id="app"></div>
<script type="module" src="/src/main.ts"></script>
```

Vite 以它为应用入口：浏览器以原生 ES Module 加载 `/src/main.ts`，Vite dev server 拦截请求、即时转译 `.vue`/`.ts` 后返回。`<div id="app">` 就是 `main.ts` 里 `mount('#app')` 挂载的节点。

### 4. 类型相关 —— `vite-env.d.ts` 与 `tsconfig.json`

`client/src/vite-env.d.ts`：
```ts
/// <reference types="vite/client" />
declare module '*.vue' {
  // 让 TS 能 import .vue 文件（否则 import App from './App.vue' 会报错）
  const component: DefineComponent<...>;
  export default component;
}
```

`client/tsconfig.json` 里与 Vite 直接相关的配置：
- **`"moduleResolution": "bundler"`**：按打包器语义解析模块（Vite 的解析方式）。
- **`"allowImportingTsExtensions": true`**：允许 `import ... from '../composables/useChat.ts'` 这种**带 `.ts` 后缀的导入**（本项目处处这么写，依赖此配置）。
- **`"noEmit": true`**：TS 只做类型检查，不产出 JS——编译交给 Vite/esbuild。
- **`"types": ["vite/client"]`**：引入 Vite 客户端类型（`import.meta.env` 等）。

### 5. 运行模式与前后端联调

- 开发：`cd client && npm run dev` → 前端在 **5173**，后端 NestJS 在 **3000**。
- 前端代码里直接 `fetch('http://localhost:3000/api/...')` 调后端（见各 `useXxx` composable 的 `API_BASE`）。
- **vite.config.ts 没配 `proxy`**：即 dev server 没有做跨域代理转发，前后端靠浏览器直连 + 后端 CORS 联调（而非 Vite proxy）。
- 产物：`vite build` 输出到 `client/dist/`（Vite 默认输出目录）。

## 四、用到的 vs 没用到的

**用到的**：dev server（`vite`）、`vite build`（含 `vue-tsc` 前置检查）、`vite preview`、`@vitejs/plugin-vue`、`defineConfig`、`server.port`、`import.meta.env` 类型（vite-env）、`.ts` 后缀导入、`moduleResolution: bundler`。

**没用到的**：
- `proxy`（开发代理）、`base`（部署路径）、`alias`（路径别名，如 `@/` 指向 `src/`）
- 环境变量文件（`.env`）与 `import.meta.env.VITE_*`
- 代码分割 / 动态导入（`vite build` 的 rollupOptions 全默认）
- `vite-plugin-vue-devtools`、ESLint 等工程化插件

## 五、面试注意点

1. **Vite 快在哪**：开发时"按需编译 + 原生 ESM"，不用像 Webpack 那样全量打包；依赖用 esbuild（Go 写的）预构建，比 JS 打包器快一个数量级。
2. **dev 与 build 不是同一套工具**：开发用 esbuild 转译（快），生产用 Rollup 打包（优）——面试常问这个点。
3. **Vite 不检查类型**：类型检查靠 `vue-tsc`，所以 `build` 脚本是 `vue-tsc --noEmit && vite build` 两步。说"Vite 自带类型检查"是错的。
4. **`.ts` 后缀导入**：Vite 生态允许带后缀导入（`allowImportingTsExtensions`），本项目所有 composable 导入都这么写——和其他打包器的"后缀省略"约定相反，易被问。
5. **前后端分离**：前端 5173 / 后端 3000，用 `server.port` 固定端口、浏览器直连 API（未配 proxy）。
