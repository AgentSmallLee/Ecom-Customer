/**
 * JWT 认证守卫
 * - 从 Authorization header 解析 Bearer Token
 * - 校验 token 有效性，解析出用户信息
 * - 将用户信息挂载到 req.user，供后续业务使用
 */
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import type { AuthenticatedUser } from './request.interface.ts';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];
    const secret = process.env.JWT_SECRET || 'ecom-customer-dev-secret';

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('请先登录');
    }

    const token = authHeader.slice(7);

    try {
      const payload = jwt.verify(token, secret) as AuthenticatedUser & jwt.JwtPayload;

      if (!payload.userId) {
        throw new UnauthorizedException('Token 无效');
      }

      request.user = {
        userId:   payload.userId,
        username: payload.username,
      };

      return true;
    } catch (err) {
      // jsonwebtoken 在 ESM 模式下命名导出异常类不可靠，用 name 判断
      const errName = (err as Error)?.name;
      if (errName === 'TokenExpiredError') {
        throw new UnauthorizedException('登录已过期，请重新登录');
      }
      if (errName === 'JsonWebTokenError') {
        throw new UnauthorizedException('Token 无效，请重新登录');
      }
      throw new UnauthorizedException('认证失败');
    }
  }
}

