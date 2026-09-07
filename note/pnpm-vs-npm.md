# pnpm 与 npm 对比（选型笔记）

## 一、两者是什么

都是 **JavaScript 包管理器**，负责安装、版本锁定、依赖解析 `package.json` 里声明的依赖。

- **npm**：Node 官方自带，最通用，node_modules 采用**扁平化（hoist）**结构。
- **pnpm**：performance npm 的缩写，用**内容寻址存储 + 硬链接**替代扁平化，更节约磁盘、更快、依赖管理更严格。

锁文件（lockfile）一一对应：npm 生成 `package-lock.json`，pnpm 生成 `pnpm-lock.yaml`，yarn 生成 `yarn.lock`。**锁文件决定"谁说了算"，一个项目应只保留一种**。

## 二、核心差异

| 维度 | pnpm | npm |
|------|------|-----|
| **磁盘占用** | 全局 store + 硬链接，同一包只存一份 | 每个项目各存一份，重复占用 |
| **安装速度** | 并行 + 内容寻址缓存，快 | 较慢 |
| **node_modules 结构** | 非扁平（`.pnpm` + symlink），严格隔离 | 扁平（hoist） |
| **幽灵依赖** | 禁止：只能用 `package.json` 声明过的包 | 存在：未声明的包也能 import，易踩坑 |
| **Monorepo** | 原生 `pnpm-workspace.yaml`，多包管理是设计目标 | `workspaces` 支持较晚、较弱 |
| **生态/趋势** | 现代前端默认（Vite、Next 官方推荐） | 最通用、零额外安装 |
| **原生模块兼容** | symlink 偶发问题（node-gyp 类） | 更稳 |

## 三、核心概念展开

### 1. 幽灵依赖（phantom dependency）

npm 扁平化把依赖"提升"到 `node_modules` 根目录，导致**你 import 了一个 package.json 里没声明的包也能跑**（因为它恰好被某个依赖的依赖提升上来了）。这会有隐患：某天升级某个包、它不再传递那个依赖，你的代码突然就崩了。

pnpm 的 node_modules 只暴露**直接声明的依赖**，间接依赖被隔离在 `.pnpm` 里，import 未声明的包会直接报错——**依赖关系诚实可见**。

### 2. 内容寻址存储（content-addressable store）

pnpm 把每个包按**内容哈希**存进全局 store（`~/.pnpm-store`），各项目里的 `node_modules` 用**硬链接**指向同一份文件。所以 100 个项目装同一个 `vue` 只占一份磁盘空间；npm 则是 100 份拷贝。

### 3. 版本锁定的差异

- npm 用 `package-lock.json`：扁平 JSON，记录精确版本 + 完整依赖树。
- pnpm 用 `pnpm-lock.yaml`：YAML，同样锁定精确版本，但配合硬链接 store 更快落地。

## 四、怎么选（结论）

| 场景 | 推荐 |
|------|------|
| 单人/小项目，不想折腾，跑起来就行 | npm |
| 多包（monorepo）、磁盘紧张、追求依赖规范 | pnpm |
| 依赖里有大量原生模块（node-gyp）且偶发兼容问题 | 优先 npm |
| 面试 / 现代工程化团队 | pnpm（趋势，Vite/Next 官方默认） |

**一句话**：没有绝对好坏，但 **pnpm 是趋势**——磁盘省、速度快、依赖严格、原生支持 monorepo。

## 五、本项目的情况与迁移记录

历史：项目脚手架最初用 pnpm（`client/pnpm-lock.yaml`、`server/pnpm-lock.yaml` 生成于早期），后来某次用 npm 重新安装，**提交的锁文件变成了 `package-lock.json`**，导致"混用"状态：

- `client` / `server`：提交的是 npm 的 `package-lock.json`，node_modules 是 npm 扁平安装
- 根目录：一个冗余的 `package.json`（只含 `@langchain/langgraph-checkpoint-postgres`，实为 server 已有依赖的重复），用 pnpm 装过

判定依据（实测）：
1. `git ls-files` 只跟踪了 `client/package-lock.json`、`server/package-lock.json`，三个 `pnpm-lock.yaml` 均未提交
2. `client`/`server` 的 `node_modules` 无 `.pnpm` 目录、无 symlink → npm 扁平安装
3. 根目录 `node_modules/.pnpm` 存在 → pnpm 安装

后统一为 **pnpm（独立安装，非 monorepo workspace）**，迁移步骤：

1. **改 .gitignore**：`pnpm-lock.yaml` → 改忽略 `package-lock.json`（锁文件改为提交 pnpm 的）
2. **删 npm 锁文件**：`client/package-lock.json`、`server/package-lock.json`
3. **删根目录冗余**：`package.json` / `pnpm-lock.yaml` / `node_modules`（那个 langgraph-checkpoint-postgres 是 server 已有的重复依赖）
4. **加 `packageManager` 字段**：`"packageManager": "pnpm@11.24.0"`，锁定包管理器版本
5. **`pnpm install` 重装**：生成新的 `pnpm-lock.yaml` + pnpm 结构 node_modules
6. **批准 esbuild 构建脚本**：pnpm 11 默认拦截依赖的 postinstall，esbuild 的原生二进制靠它下载，写在 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  esbuild: true
```

### 迁移暴露出的「幽灵依赖」（关键收获）

切换到 pnpm 后，`pnpm typecheck` 立刻报错：

```
Cannot find module '@langchain/langgraph-checkpoint'
Cannot find module '@langchain/textsplitters'
```

这两个包其实是 `@langchain/langgraph` / `@langchain/community` 的**传递依赖**，npm 扁平安装时被提升到顶层，代码 `import` 它们"碰巧能跑"；pnpm 隔离后必须显式声明。修复方式是 `pnpm add` 显式装上：

```json
"@langchain/langgraph-checkpoint": "^1.1.5",
"@langchain/textsplitters": "^1.0.1"
```

**这条本身就是一个活生生的"幽灵依赖"面试案例**：同样的代码，npm 下能跑、pnpm 下崩，原因就是依赖没声明。

## 六、常见面试问题

1. **pnpm 为什么省空间？** — 全局 store 内容寻址 + 硬链接，同内容包只存一份。
2. **什么是幽灵依赖？pnpm 如何避免？** — 见上文第三节，pnpm 只暴露直接依赖。
3. **锁文件的作用？** — 锁定精确版本，保证"别人机器/CI 安装的版本和你一致"，跨环境可复现。
4. **为什么一个项目不能同时有 package-lock.json 和 pnpm-lock.yaml？** — 两个工具各写各的锁文件会互相覆盖、产生不一致，安装时以哪个为准不明，导致 CI 与环境漂移。
5. **npm 7+ 也支持 workspaces 了，和 pnpm 比？** — 能用但扁平化的本质没变，磁盘与幽灵依赖问题依旧；pnpm 的 workspace 是设计原点，更成熟。