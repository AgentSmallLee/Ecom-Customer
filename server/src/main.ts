// server/src/main.ts
// NestJS 入口：取代原 Express 的 index.ts
import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.ts';

const bootstrap = async () => {
  const app = await NestFactory.create(AppModule);

  // 全局路由前缀 /api（根路径 / 保留给服务信息接口）
  app.setGlobalPrefix('api', { exclude: ['/'] });
  app.enableCors();

  const PORT = Number(process.env.PORT) || 3000;
  await app.listen(PORT);
  console.log(`\n红松心选 AI 客服服务已启动：http://localhost:${PORT}\n`);
};

void bootstrap();
