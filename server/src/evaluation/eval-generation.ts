// server/src/evaluation/eval-generation.ts
// RAG 生成质量批量评估脚本
//
// 用法：
//   pnpm eval-generation                  # 跑完整评测集
//   pnpm eval-generation -- --limit 10    # 只跑前 10 题（快速验证）
//   pnpm eval-generation -- --category product  # 只跑商品查询类
//
// 流程：
//   1. 读取评测集（eval-set.json）
//   2. 对每个问题，调用 RAG 生成回答（走完整的检索 + 生成链路）
//   3. 用 RagEvaluatorService 给生成的回答打分
//   4. 输出评估报告（总分、分类统计、bad case）
//
// 注意：
//   - 每道题要调 3 次 LLM（忠实度 + 相关性 + 完整性），48 题大概要 3-5 分钟
//   - 会消耗 API 额度，跑之前确认一下

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ragChainWithSources } from '../chains/rag-chain.ts';
import { RagEvaluatorService } from './rag-evaluator.service.ts';
import { createModel } from '../models/model-factory.ts';
import { buildTraceConfig } from '../llm/trace-context.ts';
import { pool } from '../db/postgres.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_FILE = join(__dirname, './eval-set.json');
// 评估结果存档路径，方便后续对比不同版本的效果
const RESULT_FILE = join(__dirname, './generation-result.json');

// 评测集条目类型
interface EvalItem {
  question: string;
  category: 'product' | 'policy' | 'none';
  answerKeywords: string[];
}

// ────────────────────────────────────────────
// 解析命令行参数
// ────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  let limit = 0; // 0 表示不限制，跑全部
  let category: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--category' && args[i + 1]) {
      category = args[i + 1];
      i++;
    }
  }

  return { limit, category };
}

// ────────────────────────────────────────────
// 主函数
// ────────────────────────────────────────────
async function main() {
  const { limit, category } = parseArgs();

  // 加载评测集
  let evalSet: EvalItem[] = JSON.parse(readFileSync(EVAL_FILE, 'utf-8'));

  // 按分类过滤
  if (category) {
    evalSet = evalSet.filter(item => item.category === category);
  }

  // 按数量限制
  if (limit > 0 && limit < evalSet.length) {
    evalSet = evalSet.slice(0, limit);
  }

  console.log(`\n📚 RAG 生成质量评估`);
  console.log(`  评测集：${evalSet.length} 个问题`);
  if (category) console.log(`  分类过滤：${category}`);
  console.log(`  评估指标：忠实度 / 相关性 / 完整性`);
  console.log(`  注意：每道题调 3 次 LLM 打分，请耐心等待\n`);

  // 初始化评估服务
  const llm = createModel({ temperature: 0 });
  const evaluator = new RagEvaluatorService(llm);

  // ── 第一步：批量生成回答 ──
  console.log('🚀 第一步：调用 RAG 生成回答...\n');

  // 存储每个问题的生成结果（回答 + 上下文）
  const generated = await Promise.all(
    evalSet.map(async (item, i) => {
      process.stdout.write(`  [${i + 1}/${evalSet.length}] ${item.question.slice(0, 20)}... `);
      const result = await ragChainWithSources.invoke(
        { question: item.question },
        buildTraceConfig('eval-generation') as any
      );
      console.log('✅ 生成完成');
      return {
        question: item.question,
        answer: result.answer as string,
        contexts: result.sources.map((s: { content: string }) => s.content),
      };
    })
  );

  // ── 第二步：调用评估服务打分 ──
  console.log('\n🧐 第二步：LLM 评委打分...\n');

  // 组装评估用例，把 answerPoints 和 category 传进去
  const evalCases = evalSet.map((item, i) => ({
    question: item.question,
    answer: generated[i].answer,
    contexts: generated[i].contexts,
    answerKeywords: item.answerKeywords,
    category: item.category,
  }));

  const { results, report } = await evaluator.evaluate(evalCases);

  // ── 第三步：输出报告 ──
  console.log('\n' + '='.repeat(60));
  console.log('  📊 生成质量评估报告');
  console.log('='.repeat(60));

  console.log(`\n  总用例数：${report.totalCases}`);
  console.log(`  总体平均分：${report.overallScore.toFixed(4)}`);
  console.log(`  合格率（≥0.8）：${(report.passRate * 100).toFixed(1)}%`);

  console.log(`\n  各维度得分：`);
  console.log(`    忠实度 Faithfulness  : ${report.avgFaithfulness.toFixed(4)}`);
  console.log(`    相关性 Relevance     : ${report.avgAnswerRelevance.toFixed(4)}`);
  console.log(`    完整性 Completeness  : ${report.avgCompleteness.toFixed(4)}`);

  // 分类统计
  console.log(`\n  📂 分类统计：`);
  for (const [cat, stat] of Object.entries(report.byCategory)) {
    const catName =
      cat === 'product' ? '商品查询' :
      cat === 'policy'  ? '政策查询' :
      cat === 'none'    ? '无答案'   : cat;
    console.log(
      `    ${catName.padEnd(6)} (${stat.count}题)  ` +
      `均分=${stat.avgScore.toFixed(2)}  ` +
      `忠实=${stat.avgFaithfulness.toFixed(2)}  ` +
      `完整=${stat.avgCompleteness.toFixed(2)}`
    );
  }

  // Bad Cases
  if (report.badCases.length > 0) {
    console.log(`\n  ⚠️  Bad Cases（最差 ${report.badCases.length} 个）：`);
    report.badCases.forEach((bc, idx) => {
      console.log(`\n    ${idx + 1}. ${bc.question}`);
      console.log(`       综合分：${bc.avgScore.toFixed(2)}  ` +
                  `忠实度：${bc.faithfulness.toFixed(2)}  ` +
                  `完整性：${bc.completeness.toFixed(2)}`);
      // 回答截取前 80 字预览
      const answerPreview = bc.answer.replace(/\n/g, ' ').slice(0, 80);
      console.log(`       回答：${answerPreview}${bc.answer.length > 80 ? '...' : ''}`);
    });
  }

  // ── 保存结果到文件 ──
  const outputData = {
    evalTime: new Date().toISOString(),
    totalCases: report.totalCases,
    overallScore: report.overallScore,
    passRate: report.passRate,
    details: evalSet.map((item, i) => ({
      question: item.question,
      category: item.category,
      answer: generated[i].answer,
      scores: results[i],
    })),
  };

  writeFileSync(RESULT_FILE, JSON.stringify(outputData, null, 2), 'utf-8');
  console.log(`\n  💾 详细结果已保存到：${RESULT_FILE}`);

  // 收尾
  await pool.end();
  console.log('\n✅ 评估完成\n');
}

main().catch(err => {
  console.error('❌ 评估失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});
