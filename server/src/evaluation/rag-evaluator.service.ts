// evaluation/rag-evaluator.service.ts
// RAG 生成质量自动评估服务
//
// 核心思路：LLM-as-Judge —— 用大模型当评委，给生成的回答打分。
// 三个维度都用 LLM 评估，口径统一，语义判断准确。
//
// 评估的三个维度：
//   1. 忠实度（faithfulness）：回答是不是基于上下文，有没有幻觉
//   2. 相关性（answerRelevance）：回答有没有答非所问
//   3. 完整性（completeness）：该说的要点都说全了吗（基于 answerKeywords）
//
// 使用方式：
//   const evaluator = new RagEvaluatorService(llmService);
//   const result = await evaluator.evaluateOne({
//     question: '蓝牙耳机多少钱',
//     answer: '蓝牙耳机 X1 Pro 是 899 元。',
//     contexts: ['蓝牙耳机 X1 Pro，价格 899 元...'],
//     answerKeywords: ['价格 899 元', '产品名 蓝牙耳机 X1 Pro'],
//     category: 'product',
//   });

import { Injectable } from '@nestjs/common';
import { LlmClientService } from '../llm/llm-client.service.js';

// ────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────

// 单条评估用例（输入）
interface EvalCase {
  question: string;          // 用户问题
  answer: string;            // RAG 系统生成的回答
  contexts: string[];        // 检索到的上下文片段
  answerKeywords?: string[]; // 答案要点关键词（人工标注），用于算完整性
  category?: 'product' | 'policy' | 'none'; // 分类，用于无答案问题特殊处理
}

// 单条评估结果（输出）
interface EvalResult {
  faithfulness: number;      // 忠实度 0-1，回答是否都有上下文依据
  answerRelevance: number;   // 相关性 0-1，回答是否针对问题
  completeness: number;      // 完整性 0-1，答案要点命中了多少
  avgScore: number;          // 综合分 = 三个维度的平均（无答案类除外）
}

// 批量评估报告
interface EvalReport {
  totalCases: number;                           // 总用例数
  avgFaithfulness: number;                      // 平均忠实度
  avgAnswerRelevance: number;                   // 平均相关性
  avgCompleteness: number;                      // 平均完整性
  overallScore: number;                         // 总体平均分
  passRate: number;                             // 合格率（综合分 >= 0.8 的比例）
  byCategory: Record<string, {                  // 按分类统计
    count: number;
    avgScore: number;
    avgFaithfulness: number;
    avgCompleteness: number;
  }>;
  badCases: Array<{                             // 低分案例，方便人工排查
    question: string;
    avgScore: number;
    faithfulness: number;
    completeness: number;
    answer: string;
  }>;
}

@Injectable()
export class RagEvaluatorService {
  constructor(private readonly llm: LlmClientService) {}

  // ────────────────────────────────────────────
  // 批量评估入口
  // ────────────────────────────────────────────
  async evaluate(cases: EvalCase[]): Promise<{ results: EvalResult[]; report: EvalReport }> {
    const results: EvalResult[] = [];

    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      process.stdout.write(`  [${i + 1}/${cases.length}] ${c.question.slice(0, 20)}... `);

      const result = await this.evaluateOne(c);
      results.push(result);

      console.log(`综合分=${result.avgScore.toFixed(2)}`);
    }

    const report = this.buildReport(results, cases);
    return { results, report };
  }

  // ────────────────────────────────────────────
  // 评估单个用例
  // ────────────────────────────────────────────
  async evaluateOne(c: EvalCase): Promise<EvalResult> {
    // 无答案问题走特殊逻辑
    if (c.category === 'none') {
      return this.evaluateNoneCase(c);
    }

    // 正常问题：三个指标并发评估，节省时间
    const [faithfulness, answerRelevance, completeness] = await Promise.all([
      this.evalFaithfulness(c.answer, c.contexts),
      this.evalAnswerRelevance(c.question, c.answer),
      // 完整性：有 answerKeywords 就用 LLM 评估，没有就默认 1（不扣分）
      c.answerKeywords && c.answerKeywords.length > 0
        ? this.evalCompleteness(c.answer, c.answerKeywords)
        : Promise.resolve(1),
    ]);

    // 综合分 = 忠实度、相关性、完整性 三个的平均值
    const avgScore = (faithfulness + answerRelevance + completeness) / 3;

    return {
      faithfulness,
      answerRelevance,
      completeness,
      avgScore,
    };
  }

  // ────────────────────────────────────────────
  // 无答案问题的评估逻辑
  // ────────────────────────────────────────────
  // 无答案问题的核心判断：系统有没有老老实实说"不知道"（拒答能力）
  //
  // 为什么不把完整性算进综合分？
  //   无答案问题本来就没有"标准答案要点"，完整性这个概念不适用。
  //   它的核心是"会不会拒答"，而不是"回答得全不全"。
  //   所以综合分只算忠实度和相关性两个维度。
  private evaluateNoneCase(c: EvalCase): EvalResult {
    // 简单规则：回答里包含拒答关键词，就算拒答成功
    const refuseKeywords = ['不知道', '抱歉', '对不起', '没有', '不提供', '不在', '无法'];
    const isRefused = refuseKeywords.some(kw => c.answer.includes(kw));

    const faithfulness = isRefused ? 1.0 : 0.0; // 拒答了就没胡说，忠实度满分
    const answerRelevance = isRefused ? 0.8 : 0.5; // 拒答也算回应了问题
    const completeness = 1.0; // 无答案问题完整性默认满分，不参与评分

    // 综合分只算忠实度和相关性（完整性对无答案问题无意义）
    const avgScore = (faithfulness + answerRelevance) / 2;

    return {
      faithfulness,
      answerRelevance,
      completeness,
      avgScore,
    };
  }

  // ────────────────────────────────────────────
  // 1. 忠实度评估（Faithfulness）
  // ────────────────────────────────────────────
  // 判断回答中的每一句话是否都能在上下文中找到依据。
  // 这是生成质量最重要的指标之一，直接衡量幻觉程度。
  //
  // 注意：电商客服场景下，模型经常会"顺便补充"相关产品信息
  // （比如问价格，回答里顺带提一下材质、颜色等），只要这些补充
  // 信息确实来自上下文，就不算幻觉，忠实度不应该因此扣分。
  private async evalFaithfulness(answer: string, contexts: string[]): Promise<number> {
    const contextText = contexts.join('\n---\n');
    const prompt = `你是一个严谨的事实核查员。请逐条检查回答中的每一个信息点，判断是否都能在给定的上下文中找到依据。

评估原则：
1. 只要回答中的每个事实陈述都能在上下文中找到对应依据，就算忠实，不论回答是否"多嘴"补充了其他信息
2. 回答可以包含比问题更多的相关信息（例如问价格时顺便介绍功能），只要这些信息都来自上下文，就不扣分
3. 只有确实编造了上下文中完全没有的信息，才扣分
4. 语气词、礼貌用语（如"亲"、"哦"、"呢"）不参与评估

【上下文】
${contextText}

【回答】
${answer}

【评分标准】
- 1.0 分：回答中所有事实陈述都能在上下文中找到依据，没有任何编造
- 0.8 分：绝大部分有依据，只有个别非常次要的细节略有偏差（不影响核心信息）
- 0.5 分：大部分有依据，但有明显的编造内容（核心信息基本正确，有一两个点是编的）
- 0.2 分：只有少量内容有依据，大部分是编造的
- 0.0 分：回答完全是编造的，或者核心事实就是错的

请只输出一个 0.0 到 1.0 之间的数字，不要输出其他任何文字。`;

    const raw = await this.llm.predict(prompt, 'eval-faithfulness');
    return this.extractScore(raw);
  }

  // ────────────────────────────────────────────
  // 2. 答案相关性评估（Answer Relevance）
  // ────────────────────────────────────────────
  // 判断回答是否真正回答了用户的问题，有没有答非所问。
  private async evalAnswerRelevance(question: string, answer: string): Promise<number> {
    const prompt = `你是一个评估员。请判断以下回答是否针对问题给出了相关的答案。

【问题】
${question}

【回答】
${answer}

【评分标准】
- 1.0 分：回答完全针对问题，直接给出了答案
- 0.8 分：基本相关，有少量无关内容
- 0.5 分：部分相关，但主要内容没回答到点子上
- 0.2 分：大部分不相关
- 0.0 分：完全答非所问

请只输出一个 0.0 到 1.0 之间的数字，不要输出其他任何文字。`;

    const raw = await this.llm.predict(prompt, 'eval-relevance');
    return this.extractScore(raw);
  }

  // ────────────────────────────────────────────
  // 3. 完整性评估（Completeness）
  // ────────────────────────────────────────────
  // 用 LLM 评估回答是否覆盖了所有答案要点（answerKeywords）。
  //
  // 为什么用 LLM 而不是规则匹配？
  //   中文的语义匹配靠规则很难做准——"商家承担"和"红松心选承担"意思一样，
  //   但关键词匹配就是命中不了。LLM 能理解语义，打分更准确，
  //   也更接近人类评估的标准（和 ragas 的思路一致）。
  //
  // 输入：回答 + 答案要点列表
  // 输出：0-1 的分数，1.0 表示所有要点都覆盖到了
  private async evalCompleteness(answer: string, keywords: string[]): Promise<number> {
    if (!keywords || keywords.length === 0) return 1;

    const pointsText = keywords.map((k, i) => `${i + 1}. ${k}`).join('\n');
    const prompt = `你是一个严谨的评估员。请判断以下回答是否覆盖了所有需要回答的要点。

【回答要点】（以下是回答应该覆盖的信息点）
${pointsText}

【待评估回答】
${answer}

【评分标准】
- 1.0 分：回答覆盖了所有要点，没有遗漏
- 0.8 分：覆盖了大部分要点，只有个别次要信息缺失
- 0.5 分：覆盖了约一半的要点
- 0.2 分：只覆盖了少量要点
- 0.0 分：完全没有覆盖任何要点

注意：只要回答表达了相同的意思就算覆盖，不要求措辞完全一致。
请只输出一个 0.0 到 1.0 之间的数字，不要输出其他任何文字。`;

    const raw = await this.llm.predict(prompt, 'eval-completeness');
    return this.extractScore(raw);
  }

  // ────────────────────────────────────────────
  // 从模型输出中提取分数
  // ────────────────────────────────────────────
  // 模型可能输出 "0.8"、"得分：0.8"、"0.8分"、"我认为是 0.8" 等各种格式，
  // 用正则把第一个出现的小数抠出来，保证稳定拿到分数。
  private extractScore(raw: string): number {
    if (!raw) return 0;
    // 匹配 0.0 ~ 1.0 之间的小数，也兼容 0、1 这种整数
    const match = raw.match(/(\d+\.?\d*)/);
    if (!match) return 0;
    let score = parseFloat(match[1]);
    // 越界保护：分数必须在 0~1 之间
    if (score > 1) score = 1;
    if (score < 0) score = 0;
    return score;
  }

  // ────────────────────────────────────────────
  // 生成评估报告
  // ────────────────────────────────────────────
  private buildReport(results: EvalResult[], cases: EvalCase[]): EvalReport {
    const avg = (arr: number[]) =>
      arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;

    const avgFaithfulness = avg(results.map(r => r.faithfulness));
    const avgAnswerRelevance = avg(results.map(r => r.answerRelevance));
    const avgCompleteness = avg(results.map(r => r.completeness));

    const overallScore = avg(results.map(r => r.avgScore));
    const passRate = results.filter(r => r.avgScore >= 0.8).length / results.length;

    // 按分类统计
    const byCategory: EvalReport['byCategory'] = {};
    const categories = [...new Set(cases.map(c => c.category || 'unknown'))];
    for (const cat of categories) {
      const indices = cases.map((c, i) => c.category === cat ? i : -1).filter(i => i >= 0);
      const catResults = indices.map(i => results[i]);
      byCategory[cat] = {
        count: catResults.length,
        avgScore: avg(catResults.map(r => r.avgScore)),
        avgFaithfulness: avg(catResults.map(r => r.faithfulness)),
        avgCompleteness: avg(catResults.map(r => r.completeness)),
      };
    }

    // 找出 bad case（综合分 < 0.6 的），方便人工排查
    const badCases = results
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.avgScore < 0.6)
      .sort((a, b) => a.r.avgScore - b.r.avgScore)
      .slice(0, 10) // 最多列出最差的 10 个
      .map(({ r, i }) => ({
        question: cases[i].question,
        avgScore: r.avgScore,
        faithfulness: r.faithfulness,
        completeness: r.completeness,
        answer: cases[i].answer,
      }));

    return {
      totalCases: results.length,
      avgFaithfulness,
      avgAnswerRelevance,
      avgCompleteness,
      overallScore,
      passRate,
      byCategory,
      badCases,
    };
  }
}
