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
}
