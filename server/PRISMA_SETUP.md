# Prisma 接入指南

> 项目使用 Prisma 7.x + PostgreSQL，Prisma Client 生成到 `src/generated/prisma/`。

---

## 一、为什么 `npx prisma init` 很慢？

### 原因

1. **首次下载耗时**：`npx` 首次运行会下载 prisma CLI 包，Prisma 体积较大（含 engine binary），国内网络下很慢。
2. **npx 不走 pnpm 缓存**：项目用 pnpm，但 `npx` 是 npm 的工具，不复用 pnpm 的本地缓存和 lockfile。
3. **Engine 二次下载**：CLI 下载完后，首次运行还要下载平台对应的 Prisma Engine binary。

### 解决方案

用 pnpm 安装并配置国内镜像：

```bash
# 设置 npm 镜像
pnpm config set registry https://registry.npmmirror.com

# 设置 Prisma Engine 二进制国内镜像
export PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma

# 安装（用 pnpm 而不是 npx）
pnpm add @prisma/client@7
pnpm add -D prisma@7
```

---

## 二、为什么选 Prisma 7 而不是 Prisma 5？

### 报错现象

Prisma 5.22.0 在 Node.js v26 上报错：

```
Error: (0 , CSe.isError) is not a function
    at Mm.parse (prisma/build/index.js:1571:330)
```

### 原因

Prisma 5.x 发布时 Node.js 26 还不存在，内部的 JS 代码与 Node 26 的 V8 版本不兼容。
Prisma 官方支持的 Node 版本：`20.19+`、`22.12+`、`24.0+`。

### 解决方案

使用 Prisma 7.x（当前稳定版），虽官方也只写了支持 20/22/24，但实际在 Node 26 上能正常运行。

```bash
pnpm add @prisma/client@7
pnpm add -D prisma@7
```

---

## 三、已有数据库表的情况下如何接入 Prisma？

### 背景

数据库里已经存在 langgraph / langchain 自建的表：
- `checkpoints`、`checkpoint_blobs`、`checkpoint_writes`、`checkpoint_migrations`
- `knowledge_embeddings`
- `store`、`store_migrations`

直接执行 `prisma migrate dev --name init` 会报 **Drift detected**（漂移检测），并要求重置数据库。

### 为什么会漂移？

Prisma migrate 会对比「迁移历史预期的数据库状态」和「实际数据库状态」。
第一次运行时还没有 `_prisma_migrations` 表，Prisma 认为预期状态是空库，但实际库里已有一堆表，所以判定漂移。

### 解决方案：方案 A — Prisma 只管理自己的表

适用于：数据库里的表分属不同系统（langgraph 管 checkpoint、业务脚本管向量表、Prisma 管业务表），互不干扰。

#### 操作步骤

1. **手工创建迁移目录和 SQL**
   ```
   prisma/migrations/
     └── 0000_init/
         └── migration.sql   ← 只写 Prisma 管理的表的建表语句
   ```

2. **手工执行 SQL**
   ```bash
   psql "postgresql://user@localhost:5432/dbname" -f prisma/migrations/0000_init/migration.sql
   ```

3. **标记迁移为已应用**
   ```bash
   pnpm prisma migrate resolve --applied 0000_init
   ```

4. **验证**
   ```bash
   pnpm prisma migrate status
   # 应该输出：Database schema is up to date!
   ```

### 其他可选方案（供参考）

| 方案 | 适用场景 | 优缺点 |
|---|---|---|
| **A. Prisma 只管自己的表**（本项目采用） | 多系统共用一个库，各管各的表 | 简单，不影响现有数据；需要注意命名隔离 |
| **B. Baseline — Prisma 接管所有表** | 想让 Prisma 统一管理全部 schema | 后续变更统一走 Prisma；初次 `db pull` + 合并 schema 较麻烦 |
| **C. 多 Schema 隔离** | 不同系统的表放不同 PostgreSQL schema | 最干净，完全避免漂移；需要修改各系统的 schema 配置 |

---

## 四、后续加新表的流程

### 正常流程（schema 里加 model）

1. 在 `prisma/schema.prisma` 中添加新 model：
   ```prisma
   model User {
     id    String @id @default(cuid())
     name  String
     email String @unique
   }
   ```

2. 创建并应用迁移：
   ```bash
   pnpm prisma migrate dev --name add_user_table
   ```

3. 重新生成 Prisma Client：
   ```bash
   pnpm prisma generate
   ```

> `migrate dev` 会自动执行 generate，一般不需要手动跑。

### 修改已有表的字段

和加新表一样，改 `schema.prisma` → `prisma migrate dev --name xxx`。
Prisma 会自动生成 `ALTER TABLE` 语句。

### 常用命令速查

```bash
# 创建迁移（仅生成文件，不执行）
pnpm prisma migrate dev --name xxx --create-only

# 查看迁移状态
pnpm prisma migrate status

# 重新生成 Prisma Client
pnpm prisma generate

# 打开数据库可视化工具
pnpm prisma studio

# 从数据库反向拉取 schema 到 prisma.schema
pnpm prisma db pull

# 直接把 schema 同步到数据库（不创建迁移记录，原型阶段用）
pnpm prisma db push
```

---

## 五、项目结构

```
server/
├── prisma/
│   ├── schema.prisma          # 数据模型定义
│   └── migrations/            # 迁移历史
│       └── 0000_init/
│           └── migration.sql
├── prisma7.config.ts          # Prisma 7 配置（datasource url 等）
└── src/
    └── generated/
        └── prisma/            # Prisma Client 生成产物（不要手动改）
```

### Prisma 7 vs Prisma 5 的主要区别

| 项 | Prisma 5 | Prisma 7 |
|---|---|---|
| 配置文件 | 写在 schema.prisma 里 | 独立的 `prisma7.config.ts` |
| generator provider | `prisma-client-js` | `prisma-client` |
| datasource url | `url = env("DATABASE_URL")` | 在 config.ts 里配置 |
| NestJS 兼容 | 默认即可 | 需加 `moduleFormat = "cjs"` |

---

## 六、故障排查

### 再次出现 Drift detected

如果其他系统（如 langgraph）新建了表导致 Prisma 报漂移：

```bash
# 确认漂移内容
pnpm prisma migrate status

# 如果只是多了非 Prisma 管理的表，标记当前所有迁移为已应用即可
pnpm prisma migrate resolve --applied <migration_name>
```

### `@types/node` 类型报错（`prisma7.config.ts` 中找不到 `process`）

确保 `tsconfig.json` 的 `include` 包含了 `prisma7.config.ts`：

```json
{
  "include": ["src", "prisma7.config.ts"]
}
```

### Prisma Client 找不到类型

确认 `tsconfig.json` 包含生成目录，或在代码中从正确路径导入：

```ts
import { PrismaClient } from './generated/prisma'
```
