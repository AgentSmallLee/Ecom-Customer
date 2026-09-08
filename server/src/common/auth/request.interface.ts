/**
 * 扩展 Express Request 类型
 * 挂载 AuthGuard 解析出的用户信息
 */
import type { Request } from 'express';

export interface AuthenticatedUser {
  userId: string;
  username?: string;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}
