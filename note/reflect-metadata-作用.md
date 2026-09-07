---
name: reflect-metadata-作用
description: reflect-metadata 库的作用、与装饰器和 NestJS DI 的关系、以及能否删除
metadata:
  type: reference
---

# reflect-metadata 是什么

`reflect-metadata` 是一个 polyfill 库，在全局 `Reflect` 对象上添加元数据 API：
- `Reflect.defineMetadata(key, value, target)`
- `Reflect.getMetadata(key, target)`
- `Reflect.hasMetadata(key, target)`

它让 TypeScript 装饰器可以在类、方法、参数上存取"元数据"。

## 与 TS 编译选项的关系

`tsconfig.json` 中两个关键选项：
- `experimentalDecorators` —— 启用装饰器语法
- `emitDecoratorMetadata` —— 编译时自动为装饰器注入类型元数据（如 `design:paramtypes`、`design:type`、`design:returntype`）

开启 `emitDecoratorMetadata` 后，TS 会在编译产物里插入 `Reflect.metadata(...)` 调用。运行时需要 `reflect-metadata` 提供这些 API，否则会报 `Reflect.getMetadata is not a function`。

## 在 NestJS 中的角色

NestJS 的**依赖注入（DI）系统完全依赖 reflect-metadata**：
- `@Injectable()` 标记的服务，构造函数参数类型通过 `design:paramtypes` 元数据读取，从而知道要注入哪些依赖
- `@Controller()`、`@Module()` 等装饰器也靠元数据工作
- 类验证器 `class-validator` / `class-transformer` 同样依赖它

## 为什么入口文件 import 了但删掉好像也不报错

`@nestjs/core` 内部已经 `import 'reflect-metadata'` 了，所以只要 NestFactory 被加载，polyfill 就已经生效。

## 能否删除

**不建议删除**，原因：
1. **顺序保障**：`reflect-metadata` 必须在任何使用装饰器的代码加载之前引入。显式写在入口文件最顶部是最稳妥的做法，NestJS 官方脚手架也是这样。
2. **避免隐性 bug**：如果引入了先于 NestJS 加载的第三方库（如某些 class-transformer / class-validator 的用法、TypeORM），隐式依赖的加载顺序可能不对。
3. **依赖一致性**：`package.json` 声明了该依赖，入口处引入相互对应。

## 正确用法

在应用入口文件（如 `main.ts`）的**最顶部**引入：

```ts
import 'reflect-metadata';
```

**为什么在顶部？** 因为 import 语句会被提升到文件最顶部执行，但如果有多个 import，顺序很重要——必须保证 reflect-metadata 在任何用到装饰器的模块之前加载。
