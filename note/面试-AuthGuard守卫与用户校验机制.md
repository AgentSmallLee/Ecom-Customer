# 面试：AuthGuard 守卫与用户校验机制

## 一句话结论

- **用户校验**：AuthGuard 统一校验 JWT token，通过后把用户信息挂到 `request.user`，业务层直接用
- **`@UseGuards(AuthGuard)`**：NestJS 装饰器，给接口加一道"门禁"，校验通过才能执行业务逻辑

---

## 一、当前项目的用户校验流程

### 两层结构

```
请求进来
    ↓
【第1层】AuthGuard（守卫）—— 统一校验 token
    ├─ 从 Authorization header 取 token
    ├─ jwt.verify() 验签 + 解析
    ├─ 校验 userId 是否存在
    ├─ 通过 → 把用户信息挂到 request.user
    └─ 不通过 → 抛 401，请求终止
    ↓
【第2层】Controller / Service —— 直接用 req.user.userId
    （不需要再校验，守卫已经保证了）
```

### 关键代码位置

- 守卫实现：`server/src/common/auth/auth.guard.ts`
- 类型定义：`server/src/common/auth/request.interface.ts`（`AuthenticatedRequest`）
- 守卫注册：各业务 module 引入 `AuthModule`
- 使用方式：Controller 方法上加 `@UseGuards(AuthGuard)`

### AuthenticatedUser（payload 核心字段）

```ts
interface AuthenticatedUser {
  userId: string;    // 必须有，业务核心
  username?: string; // 可选，显示用
}
```

---

## 二、@UseGuards(AuthGuard) 详解

### 是什么？

NestJS 的**守卫装饰器**，翻译成大白话：
> "这个接口要先经过 AuthGuard 的检查，检查通过了才能执行后面的逻辑"

### 执行顺序

```
请求 → AuthGuard.canActivate()
          ├─ 返回 true → 执行 Controller 方法
          └─ 返回 false / 抛异常 → 直接返回 403/401
```

### 两种使用粒度

| 粒度 | 写法 | 效果 |
|---|---|---|
| **类级别** | `@UseGuards(AuthGuard)` 写在 Controller 类上 | 整个类的所有接口都要过守卫 |
| **方法级别** | `@UseGuards(AuthGuard)` 写在单个方法上 | 只有这个接口要过守卫 |

当前项目用的是**方法级别**，更灵活——需要登录的接口加，不需要的不加。

### 守卫 vs 中间件的区别

| 维度 | 中间件（Middleware） | 守卫（Guard） |
|---|---|---|
| 执行时机 | 路由解析前 | 路由解析后，Controller 执行前 |
| 能拿到的信息 | request、response | ExecutionContext（知道哪个 Controller 哪个方法） |
| 典型用途 | 日志、CORS、body 解析 | **认证、授权、角色判断** |
| 依赖注入 | 不支持 | 支持（NestJS 体系内） |
| 来源 | Express 原生 | NestJS 特有 |

> **最佳实践**：认证/授权用 Guards，这是 NestJS 的推荐方式。

---

## 三、jwt.verify() 的返回值

### 返回类型

`JwtPayload | string` —— 大部分情况是对象。

`JwtPayload` 包含两部分：
1. **自定义字段**：userId、username、role 等
2. **标准字段**：`exp`（过期时间）、`iat`（签发时间）、`iss`（签发者）等

### 类型断言 + 运行时校验

```ts
const payload = jwt.verify(token, secret) as AuthenticatedUser;
//  ↑ TypeScript 层面断言成 AuthenticatedUser

if (!payload.userId) {
  throw new UnauthorizedException('Token 无效');
}
//  ↑ 运行时再校验一次关键字段，保证安全
```

为什么要双重保险？
- `as` 只是 TypeScript 的类型体操，运行时不做任何检查
- 如果 payload 里没有 userId，TypeScript 发现不了，运行时会出问题
- 加一层运行时校验，保证关键字段存在

---

## 四、面试回答模板

> "用户认证我是用 **NestJS Guard + JWT** 做的。
>
> 具体来说：
> - 封装了一个 `AuthGuard`，统一从 `Authorization` header 里取 Bearer Token
> - 用 `jsonwebtoken` 库做验签和解析，校验通过后把用户信息挂到 `request.user` 上
> - 每个需要登录的接口加 `@UseGuards(AuthGuard)` 装饰器
> - Controller 和 Service 层直接从 `req.user.userId` 取用户身份，不用每个接口都做校验
>
> 这样做的好处是：
> 1. **关注点分离**：认证逻辑和业务逻辑分开，业务层不用关心认证
> 2. **统一管理**：所有接口的认证逻辑集中在 Guard 里，改一处全生效
> 3. **符合 NestJS 最佳实践**：Guard 就是专门用来做权限/认证的，支持依赖注入，比中间件更灵活"

---

## 五、常见面试问题预判

### Q: 为什么用 Guard 不用中间件？
A: Guard 是 NestJS 特有的，执行时机在路由解析之后，能拿到当前执行的 Controller 和方法信息，支持依赖注入，更适合做认证授权这种和路由强相关的逻辑。中间件更适合通用的请求预处理。

### Q: jwt.verify 返回的是什么？能直接用吗？
A: 返回的是 payload 对象，包含自定义字段和 exp/iat 等标准字段。TypeScript 里可以用 `as` 断言成我们需要的类型，但运行时最好再校验一下关键字段（比如 userId）是否存在，防止异常。

### Q: 怎么控制哪些接口需要登录，哪些不需要？
A: 用 `@UseGuards(AuthGuard)` 装饰器控制粒度。需要登录的接口或类加上，不需要的不加。也可以做全局守卫 + 自定义装饰器（比如 `@Public()`）来反向控制。
