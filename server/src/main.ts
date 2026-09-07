// server/src/main.ts
// NestJS 入口
import 'reflect-metadata'; // 装饰器元数据支持(NestJS 依赖)
import 'dotenv/config'; // 加载环境变量
import { NestFactory } from '@nestjs/core'; // NestJS 核心工厂类
import { AppModule } from './app.module.ts'; // 根模块

// 异步引导函数
const bootstrap = async () => {
  // 创建 NestJS 应用实例
  // 1. 引入 AppModule（根模块）
  // 2. 调用 NestFactory.create() 方法创建应用实例
  const app = await NestFactory.create(AppModule);

  // 全局路由前缀 /api（根路径 / 保留给服务信息接口）
  app.setGlobalPrefix('api', { exclude: ['/'] });
  // 启用 CORS（跨域资源分享）
  app.enableCors();

  // 启动应用
  // 1. 调用 app.listen(PORT) 方法启动应用
  // 2. 等待应用启动完成
  const PORT = Number(process.env.PORT) || 3000;
  await app.listen(PORT);
  console.log(`\n红松心选 AI 客服服务已启动：http://localhost:${PORT}\n`);
};

void bootstrap();
