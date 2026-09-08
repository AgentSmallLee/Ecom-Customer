/**
 * 模型封装
 * 将 DeepSeek 封装为 LangChain ChatModel
 * DeepSeek 兼容 OpenAI 协议，使用 ChatOpenAI 并替换 baseURL 即可
 */
import { ChatOpenAI } from '@langchain/openai';
import 'dotenv/config';

// 定义创建模型的选项接口
interface CreateModelOptions {
  temperature?: number;
  streaming?: boolean;
}

/**
 * 创建 DeepSeek 模型实例
 * @param options - 可覆盖默认参数，如 { temperature: 0, streaming: true }
 */
export const createModel = (options: CreateModelOptions = {}) => {
  console.log('DEEPSEEK_API_KEY', process.env.DEEPSEEK_API_KEY);
  return new ChatOpenAI({
    model: process.env.MODEL_NAME || 'deepseek-v4-flash',
    apiKey: process.env.DEEPSEEK_API_KEY,
    configuration: {
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    },
    temperature: 0.7,
    streaming: false,
    ...options,
  });
};

// 默认导出一个标准实例（非流式）
export const model = createModel();

// 流式实例，用于 SSE 接口
export const streamingModel = createModel({ streaming: true });
