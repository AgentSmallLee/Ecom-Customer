// server/src/chat/chat.service.ts
// 基础对话服务：封装 basic-chat 的两个 Chain
import { Injectable } from '@nestjs/common';
import {
  customerServiceChain,
  customerServiceStreamChain,
  formatHistory,
  type ChatMessage,
} from '../chains/basic-chat.ts';

@Injectable()
export class ChatService {
  /** 普通对话（一次性返回） */
  async chat(message: string, history: ChatMessage[] = []): Promise<string> {
    return customerServiceChain.invoke({
      user_input: message,
      chat_history: formatHistory(history),
      current_time: new Date().toLocaleString('zh-CN'),
    });
  }

  /** 流式对话：返回异步迭代器，逐块吐出文本 */
  stream(message: string, history: ChatMessage[] = []) {
    return customerServiceStreamChain.stream({
      user_input: message,
      chat_history: formatHistory(history),
      current_time: new Date().toLocaleString('zh-CN'),
    });
  }
}
