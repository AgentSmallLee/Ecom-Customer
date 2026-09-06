// server/src/agent/agent.service.ts
// Agent 服务：持有 ReAct Agent 单例（DI 生命周期管理）
import { Injectable } from '@nestjs/common';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { createCustomerAgent }       from '../agents/customer-agent.ts';
import type { ChatMessage }          from '../chains/basic-chat.ts';

@Injectable()
export class AgentService {
  // 原来是 routes/agent.ts 的模块级单例，现在由 Nest 容器管理
  private readonly agentApp = createCustomerAgent();

  invoke(message: string, history: ChatMessage[] = []) {
    // 将历史记录转为消息对象（排除最后一条，避免重复）
    const historyMessages = history.slice(0, -1).map((m) =>
      m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)
    );

    return this.agentApp.invoke({
      messages: [...historyMessages, new HumanMessage(message)],
    });
  }
}
