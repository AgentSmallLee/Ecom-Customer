// server/src/rag/rag.service.ts
// RAG 服务：封装带来源信息的 RAG Chain
import { Injectable } from '@nestjs/common';
import { ragChainWithSources } from '../chains/rag-chain.ts';
import { buildTraceConfig } from '../llm/trace-context.ts';

export interface RagSource {
  content: string;
  source: string;
}

export interface RagResult {
  answer: string;
  sources: RagSource[];
}

@Injectable()
export class RagService {
  query(question: string, traceId?: string, userId?: string, threadId?: string): Promise<RagResult> {
    // source / traceId / userId / threadId 放 call options 顶层，FailoverChatModel 从 options 直接读取写审计日志
    return ragChainWithSources.invoke(
      { question },
      buildTraceConfig('rag-chain', { traceId, userId, threadId }) as any
    ) as Promise<RagResult>;
  }

  /** 流式查询：逐 token 返回 answer，sources 在流结束前返回 */
  async *stream(question: string, traceId?: string, userId?: string, threadId?: string): AsyncIterable<RagResult> {
    const stream = await ragChainWithSources.stream(
      { question },
      buildTraceConfig('rag-chain', { traceId, userId, threadId }) as any
    );
    for await (const chunk of stream as unknown as AsyncIterable<RagResult>) {
      yield chunk;
    }
  }
}
