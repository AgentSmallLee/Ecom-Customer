/**
 * 认证模块
 * 统一导出 AuthGuard，各业务模块直接引入使用
 */
import { Module } from '@nestjs/common';
import { AuthGuard } from './auth.guard.ts';

@Module({
  providers: [AuthGuard],
  exports:   [AuthGuard],
})
export class AuthModule {}
