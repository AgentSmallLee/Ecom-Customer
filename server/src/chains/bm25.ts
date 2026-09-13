// server/src/chains/bm25.ts
// 中文场景的 Okapi BM25 检索
//
// 为什么不用 @langchain/community 的 BM25Retriever：
//   它把分词写死成空白切分（preprocessFunc 还是 private），文档长度用 /\w+/ 统计，
//   而中文没有空格、CJK 字符也不匹配 \w —— 文档长度会全算成 0，最终得分是 NaN，中文直接用不了。
//   所以这里自己实现一份：查询和文档走同一套 tokenizer，口径一致。
//
// 分词方案：bigram（相邻两字组合），不引 jieba 这类词典依赖。
//   中文 BM25 的常见做法，商品/政策这种短文本上够用；代价是有一定噪声，
//   靠 IDF 压低"的""了"这类高频字组合的权重。

import type { Document } from '@langchain/core/documents';

// Okapi BM25 的两个自由参数
const K1 = 1.2;  // 词频饱和：越大越强调词频，1.2 是常见默认值
const B  = 0.75; // 文档长度归一化：0 表示不归一化，1 表示完全归一化

/** 把文本切成检索用的 term（bigram），汉字/字母/数字都保留 */
export function tokenize(text: string): string[] {
  // 只保留汉字、字母、数字，去掉标点和空白
  const chars = [...text.toLowerCase().replace(/[^\p{Script=Han}\p{L}\p{N}]+/gu, '')];
  if (chars.length <= 1) return chars;

  const tokens: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) {
    tokens.push(chars[i] + chars[i + 1]);
  }
  return tokens;
}

export interface Bm25Hit {
  doc: Document;
  score: number;
}

export interface Bm25Index {
  search(query: string, k: number): Bm25Hit[];
}

/**
 * 构建内存 BM25 索引
 * 一次性算好每篇文档的词频和长度；IDF 按需对查询词现算（查询词很少，开销可忽略）
 */
export function createBm25Index(docs: Document[]): Bm25Index {
  // 每篇文档的 term 词频 + 文档长度（token 数）
  const termFreqs: Map<string, number>[] = [];
  const docLengths: number[] = [];

  for (const doc of docs) {
    const tokens = tokenize(doc.pageContent);
    const freqs = new Map<string, number>();
    for (const token of tokens) freqs.set(token, (freqs.get(token) ?? 0) + 1);
    termFreqs.push(freqs);
    docLengths.push(tokens.length);
  }

  const avgDocLength =
    docLengths.reduce((a, b) => a + b, 0) / (docLengths.length || 1) || 1;

  /** 逆文档频率：越常见的词权重越低，+0.5 平滑避免除零 */
  const idf = (term: string): number => {
    let df = 0;
    for (const freqs of termFreqs) if (freqs.has(term)) df++;
    return Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
  };

  return {
    search(query: string, k: number): Bm25Hit[] {
      // 查询词去重，避免同一个词被重复计分
      const queryTerms = [...new Set(tokenize(query))].map((term) => ({ term, idf: idf(term) }));
      if (queryTerms.length === 0) return [];

      const scored = docs.map((doc, i) => {
        const freqs     = termFreqs[i];
        const docLength = docLengths[i];
        let score = 0;

        for (const { term, idf: termIdf } of queryTerms) {
          const tf = freqs.get(term);
          if (!tf) continue; // 该文档不含这个词，贡献为 0
          score += termIdf * (tf * (K1 + 1)) /
                   (tf + K1 * (1 - B + B * docLength / avgDocLength));
        }

        return { doc, score };
      });

      return scored
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },
  };
}
