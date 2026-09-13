// server/src/evaluation/eval-all.ts
// 一键跑完整评估：召回率（Recall@K）+ 准确率（Precision@K）+ 生成质量
//
// 用途：版本迭代时跑一次，结果按时间戳追加到 eval-history.json，
// 并自动和上一次的结果对比打印 Δ，用来判断改动是提升还是回退。
//
// 用法（推荐用 pnpm 脚本）：
//   pnpm eval-all                              # 召回跑 3 种模式，准确率跑 hybrid，生成全跑
//   pnpm eval-all -- --recall-modes hybrid     # 召回只跑 hybrid（更快）
//   pnpm eval-all -- --precision-modes all     # 准确率也跑 3 种模式（慢，LLM 调用量大约 3 倍）
//   pnpm eval-all -- --ks 1,3,5                # 指定 K 值
//   pnpm eval-all -- --only recall,generation  # 只跑其中几段
//   pnpm eval-all -- --limit 5                 # 只跑前 5 题（冒烟验证用，省额度）
//
// 注意：准确率最费额度（每道题每个 K 都要单独判相关性），跑之前确认预算。

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { closeVectorStore } from '../chains/rag-chain.ts';
import { evaluateMode as evaluateRecall, type Mode, type EvalItem } from './eval-recall.ts';
import { evaluateMode as evaluatePrecision } from './eval-precision.ts';
import { runGenerationEval, type GenerationSummary } from './eval-generation.ts';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const EVAL_FILE   = join(__dirname, './eval-set.json');
// 历史存档：每跑一次追加一条，不覆盖，方便回看趋势与对比
const HISTORY_FILE = join(__dirname, './eval-history.json');

const ALL_MODES: Mode[] = ['vector', 'keyword', 'hybrid'];

// 单次评估的记录
interface EvalRecord {
  time: string;
  cases: number;                                      // 本次跑了多少道题（配合 --limit 时看这个）
  ks: number[];
  recall: Record<string, Record<string, number>>;     // 模式 -> K -> 召回率
  precision: Record<string, Record<string, number>>;  // 模式 -> K -> 准确率
  generation?: GenerationSummary;
}

// ────────────────────────────────────────────
// 解析命令行参数
// ────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  let ks: number[] = [1, 3, 5, 10];
  let recallModes: Mode[] = ALL_MODES;
  let precisionModes: Mode[] = ['hybrid']; // 准确率默认只跑 hybrid，全跑额度消耗太大
  let only = ['recall', 'precision', 'generation'];
  let limit = 0; // 0 表示不限制

  const parseModes = (value: string): Mode[] =>
    value === 'all' ? ALL_MODES : value.split(',').filter((m): m is Mode => ALL_MODES.includes(m as Mode));

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ks' && args[i + 1]) {
      ks = args[i + 1].split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      i++;
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--recall-modes' && args[i + 1]) {
      recallModes = parseModes(args[i + 1]);
      i++;
    } else if (args[i] === '--precision-modes' && args[i + 1]) {
      precisionModes = parseModes(args[i + 1]);
      i++;
    } else if (args[i] === '--only' && args[i + 1]) {
      only = args[i + 1].split(',').map(s => s.trim());
      i++;
    }
  }

  return { ks, recallModes, precisionModes, only, limit };
}

// ────────────────────────────────────────────
// 把记录拍平成「指标名 -> 数值」，方便做回归对比
// ────────────────────────────────────────────
function flatten(record: EvalRecord): Record<string, number> {
  const out: Record<string, number> = {};

  for (const [mode, byK] of Object.entries(record.recall)) {
    for (const [k, value] of Object.entries(byK)) out[`Recall@${k} (${mode})`] = value;
  }
  for (const [mode, byK] of Object.entries(record.precision)) {
    for (const [k, value] of Object.entries(byK)) out[`Precision@${k} (${mode})`] = value;
  }
  if (record.generation) {
    out['生成·综合分'] = record.generation.overallScore;
    out['生成·合格率'] = record.generation.passRate;
    out['生成·忠实度'] = record.generation.avgFaithfulness;
    out['生成·相关性'] = record.generation.avgAnswerRelevance;
    out['生成·完整性'] = record.generation.avgCompleteness;
  }

  return out;
}

// 打印本次结果，并与上一次对比打印 Δ
function printComparison(current: EvalRecord, previous?: EvalRecord) {
  const now  = flatten(current);
  const prev = previous ? flatten(previous) : {};

  console.log(`\n${'='.repeat(72)}`);
  console.log('  📊 评估结果' + (previous ? `（对比基线：${previous.time}）` : '（首次运行，无基线）'));
  console.log('='.repeat(72));
  console.log(`  ${'指标'.padEnd(28)}${'本次'.padEnd(12)}${'上次'.padEnd(12)}Δ`);
  console.log(`  ${'-'.repeat(70)}`);

  for (const [label, value] of Object.entries(now)) {
    const before = prev[label];
    let delta = '-';
    if (before !== undefined) {
      const diff = value - before;
      const arrow = diff > 0.0005 ? '↑' : diff < -0.0005 ? '↓' : '=';
      delta = `${diff >= 0 ? '+' : ''}${diff.toFixed(4)} ${arrow}`;
    }
    console.log(
      `  ${label.padEnd(28)}${value.toFixed(4).padEnd(12)}` +
      `${(before !== undefined ? before.toFixed(4) : '-').padEnd(12)}${delta}`
    );
  }
  console.log('');
}

// ────────────────────────────────────────────
// 主函数
// ────────────────────────────────────────────
async function main() {
  const { ks, recallModes, precisionModes, only, limit } = parseArgs();
  let evalSet: EvalItem[] = JSON.parse(readFileSync(EVAL_FILE, 'utf-8'));

  // 按数量限制（冒烟验证/省额度用）
  if (limit > 0 && limit < evalSet.length) {
    evalSet = evalSet.slice(0, limit);
  }

  console.log(`\n🚀 RAG 全量评估`);
  console.log(`  评测集：${evalSet.length} 个问题`);
  console.log(`  K 值：${ks.join(', ')}`);
  console.log(`  召回模式：${recallModes.join(', ')}`);
  console.log(`  准确率模式：${precisionModes.join(', ')}`);
  console.log(`  执行范围：${only.join(', ')}`);

  const record: EvalRecord = {
    time: new Date().toISOString(),
    cases: evalSet.length,
    ks,
    recall: {},
    precision: {},
  };

  // ── 1. 召回率 ──
  if (only.includes('recall')) {
    for (const mode of recallModes) {
      const summary = await evaluateRecall(evalSet, mode, ks);
      record.recall[mode] = summary.recallByK;
    }
  }

  // ── 2. 准确率 ──
  if (only.includes('precision')) {
    for (const mode of precisionModes) {
      const summary = await evaluatePrecision(evalSet, mode, ks);
      record.precision[mode] = summary.precisionByK;
    }
  }

  // ── 3. 生成质量 ──
  if (only.includes('generation')) {
    const { summary } = await runGenerationEval(evalSet);
    record.generation = summary;
  }

  // ── 4. 追加历史 + 与上次对比 ──
  const history: EvalRecord[] = existsSync(HISTORY_FILE)
    ? JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'))
    : [];
  const previous = history[history.length - 1];

  history.push(record);
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');

  printComparison(record, previous);
  console.log(`  💾 本次结果已追加到：${HISTORY_FILE}（共 ${history.length} 次记录）`);

  // 收尾：释放向量库占用的连接并关闭连接池，不然进程不会退出
  await closeVectorStore();
  console.log('\n✅ 全量评估完成\n');
}

main().catch(err => {
  console.error('❌ 评估失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});
