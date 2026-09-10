// llm/llm.service.ts
// LLM 服务封装
//
// 提供最基础的 predict 方法：传入 prompt，返回模型生成的文本。
// 给评估、分类等不需要流式输出的场景用。
//
// 为什么要单独封装这个服务？
//   - 统一模型配置，不用每个地方都 new ChatOpenAI
//   - 以后换模型、加缓存、加重试，只改这一处
//   - NestJS 风格的依赖注入，方便其他模块使用

import { Injectable } from '@nestjs/common';
import { createModel } from '../models/deepseek.js';
import { HumanMessage } from '@langchain/core/messages';

@Injectable()
export class LlmService {
  // 默认模型实例（非流式，temperature=0 输出最稳定，适合评估、分类等场景）
  private readonly model = createModel({ temperature: 0, streaming: false });

  /**
   * 最简单的调用：输入 prompt 字符串，返回模型回答字符串
   * @param prompt - 给模型的完整提示词
   * @returns 模型生成的文本内容
   *
   * 用法示例：
   *   const result = await this.llm.predict('翻译这句话成英文：你好');
   *   // result = "Hello"
   */
  async predict(prompt: string): Promise<string> {
    const response = await this.model.invoke([new HumanMessage(prompt)]);
    // response.content 是 string 类型（单轮非流式输出的话就是纯文本）
    return typeof response.content === 'string' ? response.content : '';
  }

  /**
   * 用自定义参数临时调用一次，比如想换个更高的温度
   * @param prompt - 提示词
   * @param options - 临时覆盖的模型参数
   */
  async predictWithOptions(
    prompt: string,
    options: { temperature?: number; model?: string },
  ): Promise<string> {
    const tempModel = createModel({
      temperature: options.temperature ?? 0.7,
      streaming: false,
    });
    const response = await tempModel.invoke([new HumanMessage(prompt)]);
    return typeof response.content === 'string' ? response.content : '';
  }
}
