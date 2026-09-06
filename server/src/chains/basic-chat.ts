/**
 * Chain 链式调用
 * 使用 LCEL（LangChain Expression Language）管道语法
 * 将 Prompt → Model → OutputParser 串联
 *
 * LCEL 数据流：
 *   输入对象 → Prompt 格式化 → messages 数组 → Model 调用 → AIMessage → Parser 提取 → 字符串
 */
import { StringOutputParser } from '@langchain/core/output_parsers';
import { createModel } from '../models/deepseek.ts';
import {
  customerServicePrompt,
  generalChatPrompt,
} from '../prompts/customer-service.ts';

// ─── 红松心选客服 Chain（非流式）───────────────────────────────────
const model = createModel({ temperature: 0.5 });
const parser = new StringOutputParser();

export const customerServiceChain = customerServicePrompt.pipe(model).pipe(parser);

// ─── 红松心选客服 Chain（流式）────────────────────────────────────
const streamingModel = createModel({ temperature: 0.5, streaming: true });

export const customerServiceStreamChain =
  customerServicePrompt.pipe(streamingModel).pipe(parser);

// ─── 通用对话 Chain（演示用）────────────────────────────────────
export const generalChatChain = generalChatPrompt.pipe(model).pipe(parser);

// ─── 工具函数：格式化历史消息 ────────────────────────────────────
/** 前端传来的消息格式 */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * 将前端传来的 { role, content } 数组转换为 LangChain 消息格式
 * LangChain 支持 human / assistant / system 三种 role
 */
export const formatHistory = (history: ChatMessage[] = []) => {
  return history
    .map((msg): ['human' | 'assistant', string] | null => {
      if (msg.role === 'user') return ['human', msg.content];
      if (msg.role === 'assistant') return ['assistant', msg.content];
      return null;
    })
    .filter((msg): msg is ['human' | 'assistant', string] => msg !== null);
};
