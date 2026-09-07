# pnpm dev 执行流程详解

> 本项目是前后端分离的 monorepo 结构，前端在 `client/`（Vue 3 + Vite），后端在 `server/`（NestJS + tsx + nodemon）。
> `pnpm dev` 需要分别在两个目录执行，流程完全不同。

---

## 一、前端：`client/pnpm dev` → `vite`

### 脚本定义
```json
// client/package.json
"dev": "vite"
```

### 完整执行流程

```
pnpm dev
  │
  ├─ 1. pnpm 解析脚本，找到 node_modules/.bin/vite
  │
  ├─ 2. Vite 启动 Dev Server（ESM 原生开发服务器）
  │     │
  │     ├─ 2.1 读取 vite.config.ts
  │     │      └─ 加载 @vitejs/plugin-vue（编译 .vue SFC）
  │     │      └─ server.port = 5173
  │     │
  │     ├─ 2.2 预构建依赖（依赖预打包 / optimizeDeps）
  │     │      └─ 扫描 index.html 和源码中的 import
  │     │      └─ 将 vue、vue-router 等 CommonJS/UMD 包转成 ESM
  │     │      └─ 结果缓存到 node_modules/.vite/deps/
  │     │      └─ 下次启动直接读缓存，秒开
  │     │
  │     ├─ 2.3 启动 HTTP 服务器，监听 5173 端口
  │     │      └─ 基于 Connect（Node 中间件框架）
  │     │
  │     └─ 2.4 启动 WebSocket（HMR 热更新通道）
  │            └─ 文件变更 → WebSocket 推送 → 浏览器局部更新
  │
  ├─ 3. 浏览器请求 index.html
  │     └─ Vite 将 HTML 作为入口模块处理
  │     └─ 注入 HMR 客户端脚本（/@vite/client）
  │
  ├─ 4. 按需编译（请求时才编译，不是全量打包）
  │     └─ 浏览器请求 main.ts → Vite 即时编译并返回
  │     └─ 遇到 .vue 文件 → plugin-vue 拆成 template/script/style 三部分分别编译
  │     └─ 遇到 TypeScript → esbuild 转译（去掉类型，不做类型检查）
  │     └─ 类型检查由 vue-tsc 单独负责（build 时才执行，dev 时跳过以加速）
  │
  └─ 5. 运行时 HMR
        └─ Vite 用 chokidar 监听文件系统
        └─ .vue 文件变更 → HMR 更新对应组件，状态保留
        └─ .ts 文件变更 → 看是否可 HMR，不行则整页刷新
```

### 关键特性
- **无需打包**：利用浏览器原生 ESM，开发环境不做 bundle，启动极快
- **esbuild 转译**：TS 转 JS 用 esbuild（Go 写的），比 tsc 快 10~100 倍
- **依赖预构建**：第三方依赖提前打包成 ESM + 缓存，避免大量请求瀑布流
- **HMR 热更新**：修改文件后浏览器局部更新，不刷新、不丢状态

### 注意事项
- `dev` 模式 **不做类型检查**，类型错误不会阻塞页面渲染
- 类型检查要执行 `pnpm typecheck` 或 `pnpm build` 时才会跑 `vue-tsc --noEmit`

---

### 浏览器访问 localhost:5173 是如何拿到 index.html 的？

这是很多人忽略但面试常问的细节。完整链路如下：

```
浏览器地址栏输入 localhost:5173
  │
  ├─ 1. DNS 解析
  │     └─ localhost → 127.0.0.1（本地回环地址）
  │
  ├─ 2. TCP 三次握手，建立到 127.0.0.1:5173 的连接
  │
  ├─ 3. 浏览器发送 HTTP 请求
  │     └─ GET / HTTP/1.1
  │     └─ Host: localhost:5173
  │     └─ Accept: text/html, ...
  │
  ├─ 4. Vite Dev Server 接收请求（基于 Connect 中间件框架）
  │     │
  │     ├─ 4.1 中间件链逐个处理请求
  │     │      ├─ Vite 内置的历史中间件（historyApiFallback）
  │     │      ├─ 静态文件中间件（查找项目根目录的文件）
  │     │      └─ 转换中间件（对非原生资源做编译）
  │     │
  │     └─ 4.2 请求路径 "/" 匹配到 "index.html"
  │            └─ Vite 规定 index.html 是项目的入口 HTML
  │            └─ 位置：项目根目录（不是 public/，也不是 src/）
  │
  ├─ 5. Vite 对 index.html 做「HTML 转换」（关键步骤！）
  │     │
  │     ├─ 5.1 解析 <script type="module" src="/src/main.ts">
  │     │      └─ 这是入口脚本，Vite 会追踪它构建模块依赖图
  │     │
  │     ├─ 5.2 注入 HMR 客户端脚本
  │     │      └─ 在 <head> 中插入 <script type="module" src="/@vite/client"></script>
  │     │      └─ 这个脚本负责和 Vite 的 WebSocket 通信，实现热更新
  │     │
  │     ├─ 5.3 注入 importmap（如果配置了）
  │     │
  │     └─ 5.4 执行 Vite 插件的 transformIndexHtml 钩子
  │            └─ @vitejs/plugin-vue 会在这里处理一些全局注入
  │
  ├─ 6. 返回转换后的 HTML
  │     └─ HTTP 200 OK
  │     └─ Content-Type: text/html
  │
  └─ 7. 浏览器解析 HTML
        ├─ 遇到 <div id="app"></div> → 渲染空节点
        ├─ 遇到 /@vite/client 脚本 → 发起请求，建立 WebSocket
        └─ 遇到 /src/main.ts 脚本 → 发起请求，Vite 编译后返回，Vue 应用启动
```

#### 关键点拆解

**为什么 index.html 在根目录，而不是 public/ 里？**
- Vite 的设计理念：**index.html 是构建入口的一部分**，不是静态资源
- Vite 会解析其中的 `<script type="module">`，顺着入口脚本构建整个模块依赖图
- 而 `public/` 目录里的文件是原样复制，不经任何处理

**为什么返回的不是磁盘上原汁原味的 index.html？**
- Vite 会对 HTML 做转换，注入 `/@vite/client`（HMR 客户端）
- 你可以在浏览器 DevTools → Network → `localhost` → Response 里看到多了一行注入的脚本
- 磁盘上的文件并没有被修改，是**响应时动态注入**的

**请求 `/src/main.ts` 时又发生了什么？**
- 浏览器请求 `GET /src/main.ts`
- Vite 收到请求 → 读取文件 → esbuild 转译 TS → 返回 ESM 格式的 JS
- 浏览器解析返回的 JS，遇到 `import { createApp } from 'vue'` → 再发起 `GET /node_modules/.vite/deps/vue.js`（预构建产物）
- 遇到 `import App from './App.vue'` → 再发起 `GET /src/App.vue` → Vite 编译 SFC 后返回
- 以此类推，**按需请求、按需编译**，这就是 Vite 启动快的核心原因

---

### index.html 的文件名是固定的吗？哪里限制的？

**答案：不是完全固定，但默认是 `index.html`，而且有约定大于配置的意味。** 限制来自 Vite 内部的两个中间件和 Rollup 构建配置。

#### 1. 开发环境：htmlFallbackMiddleware（历史回退中间件）

Vite 源码中的 `htmlFallbackMiddleware` 函数逻辑：

```js
// vite 内部简化逻辑
function htmlFallbackMiddleware(root, spaFallback) {
  return (req, res, next) => {
    const pathname = decodeURIComponent(req.url.split('?')[0]);

    // 如果路径对应目录下有 index.html，就重写到它
    const filePath = path.join(root, pathname, "index.html");
    if (fs.existsSync(filePath)) {
      req.url = url + "index.html";  // 例如 /about/ → /about/index.html
      return next();
    }

    // SPA 模式：找不到对应文件时，统一回退到 /index.html
    // （交给前端路由处理，比如 vue-router 的 history 模式）
    if (spaFallback) {
      req.url = "/index.html";
    }
    next();
  };
}
```

这继承自 Web 服务器的**老传统**：
- Apache / Nginx 默认把 `DirectoryIndex index.html` 作为目录默认页
- Vite 只是延续了这个约定

#### 2. 开发环境：indexHtmlMiddleware（HTML 转换中间件）

```js
function indexHtmlMiddleware(root, server) {
  return async (req, res, next) => {
    const url = cleanUrl(req.url);
    // 只要请求以 .html 结尾，就走 HTML 转换流程
    // （注入 HMR 客户端、执行 transformIndexHtml 钩子等）
    if (url?.endsWith(".html") && req.headers["sec-fetch-dest"] !== "script") {
      // 读取 HTML 文件 → 转换 → 返回
      const html = await transformIndexHtml(url, fs.readFileSync(filePath, 'utf-8'), ...);
      res.end(html);
    }
  };
}
```

关键点：**只要是以 `.html` 结尾的文件都会被处理**，不一定非叫 `index.html`。比如你可以有 `login.html`、`admin.html`，直接访问 `/login.html` 就能拿到。

#### 3. 生产构建：Rollup 的 input 配置

`vite build` 底层用 Rollup 打包，Vite 默认把 `index.html` 作为 Rollup 的入口：

```js
// vite 内部默认配置（简化）
const defaultBuildConfig = {
  rollupOptions: {
    input: {
      main: resolve(config.root, 'index.html'),  // ← 默认入口
    }
  }
}
```

**多页面应用（MPA）时可以改**：

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin/index.html'),
        login: resolve(__dirname, 'login.html'),
      }
    }
  }
});
```

#### 4. 能不能完全改掉？比如叫 `app.html`？

**可以，但不推荐，因为要改很多地方：**

```ts
// vite.config.ts
export default defineConfig({
  build: {
    rollupOptions: {
      input: { main: resolve(__dirname, 'app.html') }
    }
  }
});
```

然后访问 `localhost:5173/app.html` 才能看到页面。访问根路径 `/` 不会自动回退到 `app.html`，因为 SPA 回退的目标是写死的 `/index.html`。

> 想让根路径也返回自定义 HTML？你得自己写一个 Vite 插件，在中间件链最前面拦截 `/` 请求，重写到你的自定义路径。

#### 结论

| 层面 | 是否固定 | 怎么改 |
|------|---------|--------|
| **目录默认页名** | 约定俗成叫 `index.html` | 改不了，是 Web 服务器的通用约定 |
| **SPA 回退目标** | 固定 `/index.html` | 需自定义中间件/插件 |
| **构建入口文件名** | 默认 `index.html` | `build.rollupOptions.input` 可改 |
| **其他 HTML 页面** | 完全自由 | 随便建，直接访问路径即可 |
| **Dev Server 根路径 `/`** | 返回 `index.html` | 同上，需自定义中间件 |

**一句话总结**：`index.html` 不是 Vite 发明的，是从 Apache/Nginx 时代延续下来的 Web 传统。Vite 只是默认遵循这个约定，你要改也能改，但代价是要自己处理很多细节，不符合「约定优于配置」的理念。

---

#### 和传统打包工具（Webpack）的区别

| 维度 | Vite（原生 ESM） | Webpack（打包后） |
|------|-----------------|------------------|
| 启动时 | 只启动服务器，不打包 | 全量打包所有模块，再启动服务器 |
| 访问首页 | 返回 HTML + 入口脚本，浏览器按需加载 | 返回打包好的 bundle.js |
| 首屏请求数 | 多（每个模块一个请求） | 少（一个或几个 bundle） |
| 启动速度 | 极快（秒级） | 慢（随项目规模线性增长） |
| 冷启动后首屏 | 稍慢（请求瀑布流） | 快（已经打包好了） |

---

## 二、后端：`server/pnpm dev` → `nodemon --watch src --ext ts --exec tsx src/main.ts`

### 脚本定义
```json
// server/package.json
"dev": "nodemon --watch src --ext ts --exec tsx src/main.ts"
```

### 完整执行流程

```
pnpm dev
  │
  ├─ 1. pnpm 解析脚本，执行 nodemon 命令
  │
  ├─ 2. nodemon 启动（文件监听器）
  │     └─ 监听目录：src/
  │     └─ 监听扩展名：.ts
  │     └─ 变更时重启子进程
  │
  ├─ 3. nodemon 拉起子进程：tsx src/main.ts
  │     │
  │     ├─ 3.1 tsx 加载入口文件 src/main.ts
  │     │      └─ tsx = esbuild + Node.js，运行时直接编译 TS
  │     │      └─ 不需要 tsc 预编译，也不生成 .js 文件
  │     │      └─ 支持 ESM（"type": "module"）和 .ts 扩展名导入
  │     │
  │     ├─ 3.2 执行 src/main.ts 顶层代码
  │     │      ├─ import 'reflect-metadata'   // 装饰器元数据支持（NestJS 依赖）
  │     │      ├─ import 'dotenv/config'      // 加载 .env 到 process.env
  │     │      └─ import AppModule 等依赖     // tsx 按需编译所有导入的 .ts
  │     │
  │     ├─ 3.3 NestFactory.create(AppModule)
  │     │      ├─ 初始化 NestJS 容器（IoC 容器）
  │     │      ├─ 扫描 AppModule 的 imports / controllers / providers
  │     │      ├─ 依赖注入：实例化所有 provider（RagChain、GraphModule 等）
  │     │      │   └─ 包括 LangChain 链、LangGraph 图、向量存储等重量级依赖
  │     │      └─ 注册所有路由（Controller 装饰器 → Express 路由）
  │     │
  │     ├─ 3.4 全局配置
  │     │      ├─ app.setGlobalPrefix('api')  // 所有接口加 /api 前缀
  │     │      └─ app.enableCors()           // 允许跨域（前端 5173 → 后端 3000）
  │     │
  │     └─ 3.5 app.listen(3000)
  │            └─ 底层启动 Express HTTP 服务器
  │            └─ 监听 3000 端口
  │            └─ 打印启动日志
  │
  └─ 4. 运行时文件监听（nodemon）
        └─ 修改 src/ 下的 .ts 文件 → nodemon 检测到变更
        └─ 杀掉当前子进程（tsx + Node）
        └─ 重新执行 tsx src/main.ts（全量重启）
        └─ 注意：是整进程重启，不是 HMR，所以状态会丢
```

### 关键组件分工

| 工具 | 职责 | 为什么用它 |
|------|------|-----------|
| **nodemon** | 监听文件变化，自动重启进程 | Node 原生没有热重载，需要外部工具 |
| **tsx** | 直接运行 TypeScript，无需编译 | 基于 esbuild，比 ts-node 快很多 |
| **NestJS** | 提供模块化架构、依赖注入、路由装饰器 | 企业级后端框架 |
| **dotenv/config** | 加载 .env 文件到环境变量 | 配置与代码分离 |
| **reflect-metadata** | 装饰器元数据反射 | NestJS 依赖注入的基础 |

### 注意事项
- **没有类型检查**：和 Vite 一样，tsx 只转译不做类型检查
- **整进程重启**：nodemon 是杀进程重启，不是热替换，每次改代码都会重新初始化所有模块（包括重新建数据库连接池、重新编译 LangGraph 等）
- `tsconfig.json` 中 `noEmit: true` + `allowImportingTsExtensions: true` 是为了和 tsx 的运行行为对齐（只检查类型，不生成文件，允许 `.ts` 后缀导入）

---

## 三、前后端对比

| 维度 | 前端 (Vite) | 后端 (nodemon + tsx) |
|------|------------|---------------------|
| **启动速度** | 极快（依赖预构建缓存后秒开） | 中等（NestJS 初始化 + DI 扫描需要时间） |
| **热更新方式** | HMR（模块级热替换，不刷新） | 整进程重启（杀了再启） |
| **TS 处理** | esbuild 转译，类型检查单独跑 | tsx (esbuild) 转译，类型检查单独跑 |
| **端口** | 5173 | 3000 |
| **入口** | index.html → main.ts | src/main.ts |
| **跨域** | 浏览器侧，需要后端开 CORS | 服务端，已启用 `enableCors()` |

---

## 四、常见问题

### Q: 为什么后端不用 HMR？
Node.js 的模块缓存机制决定了热替换非常复杂，NestJS 的 DI 容器也需要重新初始化。业内后端开发普遍接受"改代码 → 重启进程"的模式，重启速度在可接受范围内。

### Q: 为什么不用 ts-node？
tsx 基于 esbuild，速度比 ts-node（基于 TypeScript 编译器）快一个数量级，且零配置支持 ESM。

### Q: pnpm 在其中起什么作用？
pnpm 只做两件事：
1. 管理依赖（安装到 node_modules，用符号链接管理）
2. 执行脚本（`pnpm dev` → 找到对应 package.json 里的 scripts.dev 并执行）
真正的运行逻辑是 Vite 和 nodemon/tsx 负责的。
