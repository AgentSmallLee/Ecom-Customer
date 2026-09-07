// server/src/types/env.d.ts
// .env 环境变量类型声明
//
// 作用：
//   通过 declare global + interface ProcessEnv 的声明合并（Declaration Merging），
//   给 NodeJS.ProcessEnv 补充项目中用到的环境变量字段，获得以下好处：
//   1. IDE 代码补全 —— 写 process.env. 时自动提示可用的环境变量名
//   2. 类型区分 —— 必选（string）vs 可选（string | undefined）一目了然
//   3. 拼写检查 —— 打错变量名时 TS 会报错
//
// 生效条件：
//   tsconfig.json 的 include 包含了本文件（当前为 "include": ["src"]，已生效）
//
// 注意事项：
//   - 这是 .d.ts 类型声明文件，只影响 TS 静态检查，编译后不产生任何 JS 代码，不影响运行时
//   - 标为必选（string）只是 TS 层面的类型约束，并不代表运行时一定存在
//     （比如 DEEPSEEK_API_KEY 如果 .env 里没配，运行时拿到的仍是 undefined）
//   - 真正要保证环境变量存在，需要在启动时做运行时校验（如 @nestjs/config 的 validate）
//
// 字段约定：
//   - 没有默认值、必须手动配置的 → 写 string（必选）
//   - 有默认值或可省略的       → 写 string?（可选）
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      DEEPSEEK_BASE_URL?: string;
      MODEL_NAME?: string;
      PORT?: string;

      ZHIPU_API_KEY?: string;
      DASHSCOPE_API_KEY?: string;

      PG_HOST?: string;
      PG_PORT?: string;
      PG_USER?: string;
      PG_PASSWORD?: string;
      PG_DATABASE?: string;
    }
  }
}

export {};
