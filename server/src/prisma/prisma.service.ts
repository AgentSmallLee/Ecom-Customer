// src/prisma/prisma.service.ts

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common'

// ⚠️ Prisma 7 重大变化：
// 不再从 '@prisma/client' 导入，而是从生成的路径导入
// 路径对应 schema.prisma 里 output = "../src/generated/prisma"
import { PrismaClient } from '../generated/prisma/client.js'

// ⚠️ Prisma 7 重大变化：
// 必须引入 Driver Adapter，Prisma 7 移除了内置数据库驱动
// @prisma/adapter-pg 是 PostgreSQL 的适配器
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

@Injectable()
  export class PrismaService extends PrismaClient
    implements OnModuleInit, OnModuleDestroy {

    constructor() {
      // Prisma 7 必须通过 adapter 连接数据库
      // 第一步：创建 pg 连接池（Pool 负责管理数据库连接）
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
      })

      // 第二步：把 pool 包装成 Prisma 认识的 adapter
      const adapter = new PrismaPg(pool)

      // 第三步：把 adapter 传给父类 PrismaClient
      // Prisma 7 的 PrismaClient 必须接收 adapter 参数，否则无法连接数据库
      super({ adapter })
    }

    // 模块初始化时建立数据库连接
    async onModuleInit() {
      await this.$connect()
      console.log('✅ PostgreSQL 18 数据库连接成功（Prisma 7）')
    }

    // 程序退出时断开连接，防止资源泄漏
    async onModuleDestroy() {
      await this.$disconnect()
      console.log('数据库连接已断开')
    }
  }