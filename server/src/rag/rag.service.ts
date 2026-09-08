// server/src/rag/rag.service.ts
// RAG 服务：封装带来源信息的 RAG Chain
import { Injectable } from '@nestjs/common';
import { ragChainWithSources } from '../chains/rag-chain.ts';

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
  query(question: string): Promise<RagResult> {
    return ragChainWithSources.invoke({ question }) as Promise<RagResult>;
  }

  /** 流式查询：逐 token 返回 answer，sources 在流结束前返回 */
  async *stream(question: string): AsyncIterable<RagResult> {
    const stream = await ragChainWithSources.stream({ question });
    for await (const chunk of stream as unknown as AsyncIterable<RagResult>) {
      yield chunk;
    }
  }
}
