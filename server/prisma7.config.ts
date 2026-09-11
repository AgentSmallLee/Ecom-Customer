// prisma.config.ts
// Prisma 7 新增的核心配置文件
// 数据库连接 URL 在这里配置，不再写在 schema.prisma 的 datasource 里

import 'dotenv/config'    // 加载 .env 文件里的环境变量
import { defineConfig } from 'prisma/config'

export default defineConfig({
  // 指定 schema 文件位置
  schema: 'prisma/schema.prisma',

  // 迁移文件存放目录
  migrations: {
    path: 'prisma/migrations',
  },

  // 数据库连接配置
  // URL 从 .env 文件读取，不要硬编码在这里
  datasource: {
    url: process.env.DATABASE_URL as string,
  },
})