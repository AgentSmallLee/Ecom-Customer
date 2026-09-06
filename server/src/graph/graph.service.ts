// server/src/graph/graph.service.ts
// LangGraph 工作流服务：持有编译后的图单例（DI 生命周期管理）
import { Injectable } from '@nestjs/common';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { buildCustomerGraph }       from '../graphs/customer-graph.ts';
import type { ChatMessage }         from '../chains/basic-chat.ts';

@Injectable()
export class GraphService {
  // 原来是 routes/graph.ts 的模块级 lazy 单例，现在由 Nest 容器管理
  private graph: ReturnType<typeof buildCustomerGraph> | null = null;

  private getGraph(): ReturnType<typeof buildCustomerGraph> {
    if (!this.graph) this.graph = buildCustomerGraph();
    return this.graph;
  }

  /** 以 updates 模式流式执行工作流 */
  stream(message: string, history: ChatMessage[] = []) {
    const historyMessages = history.map((m) =>
      m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)
    );

    return this.getGraph().stream(
      {
        userInput: message,
        messages:  [...historyMessages, new HumanMessage(message)],
      },
      { streamMode: 'updates' }
    );
  }
}
