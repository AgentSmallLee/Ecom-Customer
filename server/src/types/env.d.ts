// server/src/types/env.d.ts
// .env 环境变量类型声明
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      DEEPSEEK_API_KEY: string;
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
