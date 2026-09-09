// server/src/models/embedding.ts
// 方式一（推荐）：智谱 AI — 注册地址 https://open.bigmodel.cn
// 方式二：阿里云百炼  https://bailian.console.aliyun.com
// 两种方式只有 modelName / openAIApiKey / baseURL 三个字段不同，其余代码一样
import { OpenAIEmbeddings } from '@langchain/openai';
import 'dotenv/config';

// 方式一：智谱 AI（默认）
// export const embeddings = new OpenAIEmbeddings({
//   modelName:  'embedding-3',
//   openAIApiKey: process.env.ZHIPU_API_KEY,
//   configuration: {
//     baseURL: 'https://open.bigmodel.cn/api/paas/v4',
//   },
// });

// 方式二：阿里云百炼（注释掉方式一，取消注释此段）
export const embeddings = new OpenAIEmbeddings({
  modelName:    'qwen3.7-text-embedding',
  openAIApiKey: process.env.DASHSCOPE_API_KEY,
  configuration: {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  batchSize:20 // 对齐
});
