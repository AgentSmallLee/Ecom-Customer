// server/src/evaluation/eval-recall.ts
// RAG 召回率（声明级 Recall@K）评估脚本
//
// 用法（推荐用 pnpm 脚本）：
//   pnpm eval-recall -- --mode all         # 三种模式一起对比（推荐）
//   pnpm eval-recall                       # 混合检索，评测所有 K 值（默认）
//   pnpm eval-recall -- --mode vector       # 纯向量检索
//   pnpm eval-recall -- --mode keyword      # 纯关键词检索
//   pnpm eval-recall -- --mode hybrid       # 混合检索
//   pnpm eval-recall -- --k 5               # 只评测指定 K 值
//   pnpm eval-recall -- --ks 1,3,5,10       # 评测多个 K 值
//
// 声明级召回率（对齐 RAGAS Context Recall）是什么？
//   把每道题的 answerKeywords（答案要点/claims）当作"该回来的信息"，
//   逐条判断 top-K 检索结果是否覆盖了这个要点，得分 = 被覆盖的要点数 ÷ 该题要点总数。
//   通俗说：标准答案有 10 个要点，检索覆盖 5 个，召回率就是 50%。
//   相比"top-K 整体能否回答"的 Hit@K，声明级粒度更细，能定位具体漏了哪个要点。
//
// 命中判断标准：
//   用 LLM 语义判断 top-K 结果是否覆盖某个要点（纯问题 + 该要点 + 上下文）
//   无答案问题（category=none）：一条都没召回才算命中（说明检索系统没乱召回）

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { vectorSearch, keywordSearch, hybridSearch, closeVectorStore } from '../chains/rag-chain.ts';
import { createModel } from '../models/model-factory.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_FILE = join(__dirname, './eval-set.json');

// 支持的检索模式
export type Mode = 'vector' | 'keyword' | 'hybrid';

// 评测集每一项的类型定义
export interface EvalItem {
  question: string;          // 用户问题
  category: 'product' | 'policy' | 'none'; // 问题分类，用于分类统计
  answerKeywords: string[];   // 答案要点（生成质量评估用，召回评估不依赖）
}

// 单个模式的召回结果（供 eval-all 汇总与回归对比使用）
export interface RecallSummary {
  mode: Mode;
  recallByK: Record<number, number>;                      // K -> 总体召回率
  categoryRecall: Record<string, Record<number, number>>; // 分类 -> K -> 召回率
}

// ────────────────────────────────────────────
// 解析命令行参数
// ────────────────────────────────────────────
// 支持的参数：
//   --mode vector|keyword|hybrid|all   检索模式，默认 hybrid
//   --k 5                              只评测单个 K 值
//   --ks 1,3,5,10                      评测多个 K 值，默认 [1,3,5,10]
//
// 说明：默认 K 值选 [1,3,5,10] 是比较常见的评测粒度，
//   小 K 看重排能力，大 K 看召回覆盖能力，方便对比不同参数的效果。
function parseArgs(): { mode: Mode | 'all'; ks: number[] } {
  const args = process.argv.slice(2); // 去掉 node 和脚本路径，只留用户参数
  let mode: Mode | 'all' = 'hybrid';  // 默认混合检索
  let ks: number[] = [1, 3, 5, 10];   // 默认评测这四个 K 值

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) {
      const m = args[i + 1];
      // 只接受合法值，其他忽略
      if (m === 'vector' || m === 'keyword' || m === 'hybrid' || m === 'all') {
        mode = m;
      }
      i++; // 跳过参数值，避免下一轮循环当成新参数
    } else if (args[i] === '--k' && args[i + 1]) {
      // 单个 K 值，比如 --k 5
      ks = [parseInt(args[i + 1])];
      i++;
    } else if (args[i] === '--ks' && args[i + 1]) {
      // 多个 K 值，用逗号分隔，比如 --ks 1,3,5,10
      ks = args[i + 1]
        .split(',')
        .map(s => parseInt(s.trim()))
        .filter(n => !isNaN(n)); // 过滤掉解析失败的值
      i++;
    }
  }

  return { mode, ks };
}

// ────────────────────────────────────────────
// 按模式调用检索函数
// ────────────────────────────────────────────
// 统一封装一个搜索入口，上层不用关心具体是哪种检索。
// 以后加新的检索模式（比如加了 Rerank 的模式），只需要在这里加 case。
//
// 参数 k 表示要返回多少条结果。
async function searchByMode(query: string, mode: Mode, k: number) {
  switch (mode) {
    case 'vector':
      return vectorSearch(query, k);    // 纯向量检索
    case 'keyword':
      return keywordSearch(query, k);   // 纯关键词检索
    case 'hybrid':
    default:
      return hybridSearch(query, k);    // 混合检索（向量 + 关键词 + RRF 融合）
  }
}

// LLM 模型实例（用于语义判断召回是否命中）
const llm = createModel({ temperature: 0 });

// ────────────────────────────────────────────
// 判断是否命中（声明级判断标准 — LLM 语义评估版）
// ────────────────────────────────────────────
// 用 LLM 判断检索到的 top-K 个 chunk，是否覆盖了回答该问题所需的某一个要点。
//
// 为什么用"要点"而不是"整段上下文能不能回答"？
//   整体判断粒度太粗：上下文缺了某一个关键事实也算"能回答"，无法定位漏了什么。
//   逐条判断每个 answerKeyword 后，Recall = 被覆盖的要点数 / 总要点数（对齐 RAGAS Context Recall）。
//
// 无答案问题的特殊处理：
//   一条结果都没召回才算命中——说明检索系统知道这道题它不会，没乱答。
//   召回了任何东西 = 没命中 = 乱召回了。
async function isHitLLM(
  question: string,
  keyword: string,
  docs: { pageContent: string }[],
): Promise<boolean> {
  // 没有任何上下文 → 该要点不可能被覆盖
  if (docs.length === 0) return false;

  // 把检索到的上下文拼起来
  const contextText = docs.map((d, i) => `[${i + 1}] ${d.pageContent}`).join('\n---\n');

  const prompt = `你是一个检索质量评估员。请判断以下检索到的上下文片段，是否包含回答这个问题所需的这个信息要点。

【问题】
${question}

【需要判断的信息要点】
${keyword}

【检索到的上下文】
${contextText}

判断标准：
- 只要上下文中包含了这个信息要点（语义一致即可，不要求措辞完全一样），就算命中，输出 yes
- 如果上下文完全不包含这个要点，输出 no

请只输出 yes 或 no，不要输出其他任何文字。`;

  const raw = await llm.predict(prompt, 'eval-recall');
  return raw.trim().toLowerCase().startsWith('yes');
}

// ────────────────────────────────────────────
// 评估单个检索模式
// ────────────────────────────────────────────
// 流程：
//   1. 遍历评测集中的每个问题
//   2. 对每个问题，一次检索拿 maxK 条结果（所有 K 值共用，省 API 调用）
//   3. 对每个 K 值，逐条判断 answerKeywords 各要点是否被覆盖
//   4. 最后统计总体召回率和分类召回率
//
// 为什么一次拿 maxK 而不是每个 K 各查一次？
//   假设有 4 个 K 值（1,3,5,10），49 道题：
//   - 每个 K 各查一次：49 × 4 = 196 次检索调用
//   - 一次拿最大 K 再切片：49 × 1 = 49 次检索调用
//   直接省了 75% 的调用量和时间，结果完全一样。
//   这是一个很常见的小优化，准确率脚本里也是同样的做法。
//
// 为什么"一次检索"还能逐 K 判断要点？
//   top-K 是 maxK 结果的前缀切片，每个 K 各自逐条判断要点是否被覆盖，
//   所以每个 K 值都会对每个要点单独调用一次 LLM 判断。
export async function evaluateMode(evalSet: EvalItem[], mode: Mode, ks: number[]): Promise<RecallSummary> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  模式：${mode.toUpperCase()}`);
  console.log(`${'='.repeat(60)}`);

  // 每个 K 值存两套累计：被覆盖的要点数（分子）、总要点数（分母）
  // 比如 coveredByK[4] = [1, 2, 0, 1, ...]  totalByK[4] = [2, 3, 2, 2, ...]
  const coveredByK: Record<number, number[]> = {};
  const totalByK:   Record<number, number[]> = {};
  ks.forEach(k => {
    coveredByK[k] = [];
    totalByK[k]   = [];
  });

  // 按分类存储，方便看不同类型问题的表现差异
  // 比如：政策查询召回率特别低 → 说明政策类文档的检索需要优化
  const catCovered: Record<string, Record<number, number[]>> = { product: {}, policy: {}, none: {} };
  const catTotal:   Record<string, Record<number, number[]>> = { product: {}, policy: {}, none: {} };
  ks.forEach(k => {
    catCovered.product[k] = [];
    catCovered.policy[k]  = [];
    catCovered.none[k]    = [];
    catTotal.product[k]   = [];
    catTotal.policy[k]    = [];
    catTotal.none[k]      = [];
  });

  // 最大的 K 值，一次检索拿这么多，所有小 K 值都从这里切片
  const maxK = Math.max(...ks);

  for (let i = 0; i < evalSet.length; i++) {
    const item = evalSet[i];

    // 打印进度，比如 [12/49] 蓝牙耳机多少钱 ... 1/2@1 2/3@3
    process.stdout.write(`  [${i + 1}/${evalSet.length}] ${item.question.slice(0, 20)}... `);

    // 只调一次检索，拿 maxK 条结果
    const docs = await searchByMode(item.question, mode, maxK);

    // 对每个 K 值分别逐条判断要点是否被覆盖
    let hitStr = '';
    for (const k of ks) {
      const topK = docs.slice(0, k); // 小 K 直接从 maxK 结果里截前 N 条

      // 无答案问题：一条都没召回才算命中（说明检索没有乱召回）
      if (item.category === 'none') {
        const hit = topK.length === 0 ? 1 : 0;
        coveredByK[k].push(hit);
        totalByK[k].push(1);
        catCovered.none[k].push(hit);
        catTotal.none[k].push(1);
        hitStr += (hit ? '✓' : '✗') + `@${k} `;
        continue;
      }

      // 有答案问题：逐条判断每个要点是否被 top-K 覆盖
      let covered = 0;
      for (const kw of item.answerKeywords) {
        if (await isHitLLM(item.question, kw, topK)) covered++;
      }
      const total = item.answerKeywords.length || 1; // 防止空要点数组除零
      coveredByK[k].push(covered);
      totalByK[k].push(total);
      catCovered[item.category][k].push(covered);
      catTotal[item.category][k].push(total);
      hitStr += `${covered}/${total}@${k} `;
    }
    console.log(hitStr);
  }

  // 输出总体召回率（声明级：Σ被覆盖要点 / Σ总要点）
  const recallByK: Record<number, number> = {};
  console.log(`\n  📊 总体召回率（声明级）：`);
  for (const k of ks) {
    const covered = coveredByK[k].reduce((a, b) => a + b, 0); // 被覆盖的要点总数
    const total   = totalByK[k].reduce((a, b) => a + b, 0);   // 总要点数
    const recall  = total > 0 ? covered / total : 0;          // 召回率 = 覆盖要点 ÷ 总要点
    recallByK[k] = recall;
    console.log(`    Recall@${k.toString().padEnd(2)} = ${recall.toFixed(4)}  (${covered}/${total} 要点)`);
  }

  // 输出分类召回率，看不同类型的问题召回率怎么样，方便定位短板
  const categoryRecall: Record<string, Record<number, number>> = {};
  console.log(`\n  📂 分类召回率：`);
  for (const cat of ['product', 'policy', 'none'] as const) {
    const catName = cat === 'product' ? '商品查询' : cat === 'policy' ? '政策查询' : '无答案';
    const parts: string[] = [];
    categoryRecall[cat] = {};
    for (const k of ks) {
      const cov = catCovered[cat][k];
      if (cov.length === 0) continue;
      const covered = cov.reduce((a, b) => a + b, 0);
      const total   = catTotal[cat][k].reduce((a, b) => a + b, 0);
      const recall  = total > 0 ? covered / total : 0;
      categoryRecall[cat][k] = recall;
      parts.push(`Recall@${k}=${recall.toFixed(2)}`);
    }
    console.log(`    ${catName.padEnd(6)} (${catCovered[cat][ks[0]].length}题)：${parts.join('  ')}`);
  }

  return { mode, recallByK, categoryRecall };
}

// ────────────────────────────────────────────
// 主函数
// ────────────────────────────────────────────
async function main() {
  const { mode, ks } = parseArgs();
  const evalSet: EvalItem[] = JSON.parse(readFileSync(EVAL_FILE, 'utf-8'));

  console.log(`\n📚 RAG 召回率评估`);
  console.log(`  评测集：${evalSet.length} 个问题`);
  console.log(`  K 值：${ks.join(', ')}`);
  console.log(`  模式：${mode}`);
  console.log(`  命中标准：LLM 语义判断 top-K 上下文能否回答问题（纯问题 + 上下文）`);

  if (mode === 'all') {
    // 三种模式都跑，方便对比
    const modes: Mode[] = ['vector', 'keyword', 'hybrid'];
    const summaries: RecallSummary[] = [];
    for (const m of modes) {
      summaries.push(await evaluateMode(evalSet, m, ks));
    }

    // 打印三种模式的对比总表
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  🎯 三种模式对比总结（召回率）`);
    console.log(`${'='.repeat(60)}`);
    console.log(`  ${'模式'.padEnd(10)}${ks.map(k => `Recall@${k}`.padEnd(12)).join('')}`);
    console.log(`  ${'-'.repeat(58)}`);
    for (const s of summaries) {
      console.log(`  ${s.mode.padEnd(10)}${ks.map(k => (s.recallByK[k]?.toFixed(3) ?? '-').padEnd(12)).join('')}`);
    }
    console.log('');
  } else {
    // 只跑单个模式
    await evaluateMode(evalSet, mode, ks);
  }

  // 释放向量库占用的连接并关闭连接池，不然 Node 进程不会退出
  await closeVectorStore();
  console.log('✅ 评估完成\n');
}

// 只有直接运行本文件时才跑 CLI；被 eval-all.ts 导入时只复用上面的评估函数
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch(err => {
    console.error('❌ 评估失败：', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
