// server/src/scripts/eval-recall.ts
// RAG 召回率（Recall@K）评估脚本
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
// 召回率（Recall@K）是什么？
//   top-K 条结果中，有没有包含正确答案？有多少正确答案被捞回来了？
//   通俗说：该回来的回来了多少？怕漏掉。
//   和准确率的区别：准确率怕掺假（回来的有多少是对的），召回率怕漏掉（该回来的回来了多少）。
//
// 命中判断标准：
//   用 LLM 语义判断 top-K 结果能否回答这个问题（纯问题 + 上下文，不依赖答案要点）
//   无答案问题：一条都没召回才算命中（说明检索系统没乱召回）

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { vectorSearch, keywordSearch, hybridSearch } from '../chains/rag-chain.ts';
import { pool } from '../db/postgres.ts';
import { LlmService } from '../llm/llm.service.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_FILE = join(__dirname, './eval-set.json');

// 支持的检索模式
type Mode = 'vector' | 'keyword' | 'hybrid';

// 评测集每一项的类型定义
interface EvalItem {
  question: string;          // 用户问题
  category: 'product' | 'policy' | 'none'; // 问题分类，用于分类统计
  answerKeywords: string[];   // 答案要点（生成质量评估用，召回评估不依赖）
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

// LLM 服务实例（用于语义判断召回是否命中）
const llm = new LlmService();

// ────────────────────────────────────────────
// 判断是否命中（召回率判断标准 — LLM 语义评估版）
// ────────────────────────────────────────────
// 用 LLM 判断检索到的 top-K 个 chunk，从语义上看能不能回答这个问题。
//
// 为什么不用关键词匹配了？
//   关键词匹配太粗：
//     · 假阳性：chunk 里有关键词但说的是另一件事
//     · 假阴性：chunk 说的是对的但措辞不一样，关键词匹配不上
//   LLM 做语义判断更准确，更接近真实的召回效果。
//
// 无答案问题的特殊处理：
//   一条结果都没召回才算命中——说明检索系统知道这道题它不会，没乱答。
//   召回了任何东西 = 没命中 = 乱召回了。
async function isHitLLM(
  question: string,
  docs: { pageContent: string }[],
  category: string,
): Promise<boolean> {
  // 无答案问题：没有任何匹配就是命中（说明检索没有乱召回）
  if (category === 'none') {
    return docs.length === 0;
  }
  // 有答案问题但一条没检索到 → 肯定没命中
  if (docs.length === 0) {
    return false;
  }

  // 把检索到的上下文拼起来
  const contextText = docs.map((d, i) => `[${i + 1}] ${d.pageContent}`).join('\n---\n');

  const prompt = `你是一个检索质量评估员。请判断以下检索到的上下文片段，从语义上是否包含了回答这个问题所需的关键信息。

【问题】
${question}

【检索到的上下文】
${contextText}

判断标准：
- 只要上下文中包含了回答问题所需的主要信息（语义一致即可，不要求措辞完全一样），就算命中
- 如果上下文完全不相关，或者缺少回答问题的关键信息，就算没命中

请只输出 yes 或 no，不要输出其他任何文字。`;

  const raw = await llm.predict(prompt);
  return raw.trim().toLowerCase().startsWith('yes');
}

// ────────────────────────────────────────────
// 评估单个检索模式
// ────────────────────────────────────────────
// 流程：
//   1. 遍历评测集中的每个问题
//   2. 对每个问题，一次检索拿 maxK 条结果（所有 K 值共用，省 API 调用）
//   3. 对每个 K 值，分别判断是否命中
//   4. 最后统计总体召回率和分类召回率
//
// 为什么一次拿 maxK 而不是每个 K 各查一次？
//   假设有 4 个 K 值（1,3,5,10），49 道题：
//   - 每个 K 各查一次：49 × 4 = 196 次检索调用
//   - 一次拿最大 K 再切片：49 × 1 = 49 次检索调用
//   直接省了 75% 的调用量和时间，结果完全一样。
//   这是一个很常见的小优化，准确率脚本里也是同样的做法。
async function evaluateMode(evalSet: EvalItem[], mode: Mode, ks: number[]) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  模式：${mode.toUpperCase()}`);
  console.log(`${'='.repeat(60)}`);

  // 用对象存每个 K 值的命中记录（1=命中，0=未命中）
  // 比如 hitsByK[4] = [1, 1, 0, 1, ...]
  const hitsByK: Record<number, number[]> = {};
  ks.forEach(k => (hitsByK[k] = []));

  // 按分类存储，方便看不同类型问题的表现差异
  // 比如：政策查询召回率特别低 → 说明政策类文档的检索需要优化
  const catHits: Record<string, Record<number, number[]>> = {
    product: {}, // 商品查询
    policy: {},  // 政策查询
    none: {},    // 无答案问题
  };
  ks.forEach(k => {
    catHits.product[k] = [];
    catHits.policy[k] = [];
    catHits.none[k] = [];
  });

  // 最大的 K 值，一次检索拿这么多，所有小 K 值都从这里切片
  const maxK = Math.max(...ks);

  for (let i = 0; i < evalSet.length; i++) {
    const item = evalSet[i];

    // 打印进度，比如 [12/49] 蓝牙耳机多少钱 ... ✓@1 ✓@3 ✗@5
    process.stdout.write(`  [${i + 1}/${evalSet.length}] ${item.question.slice(0, 20)}... `);

    // 只调一次检索，拿 maxK 条结果
    const docs = await searchByMode(item.question, mode, maxK);

    // 对每个 K 值分别用 LLM 判断是否命中
    let hitStr = '';
    for (const k of ks) {
      const topK = docs.slice(0, k); // 小 K 直接从 maxK 结果里截前 N 条
      const hit = await isHitLLM(item.question, topK, item.category);
      hitsByK[k].push(hit ? 1 : 0);
      catHits[item.category][k].push(hit ? 1 : 0);
      hitStr += (hit ? '✓' : '✗') + `@${k} `;
    }
    console.log(hitStr);
  }

  // 输出总体召回率
  console.log(`\n  📊 总体召回率：`);
  for (const k of ks) {
    const hits = hitsByK[k].reduce((a, b) => a + b, 0); // 命中数量
    const total = hitsByK[k].length;                    // 总问题数
    const recall = hits / total;                        // 召回率 = 命中数 ÷ 总数
    console.log(`    Recall@${k.toString().padEnd(2)} = ${recall.toFixed(4)}  (${hits}/${total})`);
  }

  // 输出分类召回率，看不同类型的问题召回率怎么样，方便定位短板
  console.log(`\n  📂 分类召回率：`);
  for (const cat of ['product', 'policy', 'none'] as const) {
    const catName = cat === 'product' ? '商品查询' : cat === 'policy' ? '政策查询' : '无答案';
    const parts: string[] = [];
    for (const k of ks) {
      const arr = catHits[cat][k];
      if (arr.length === 0) continue;
      const hits = arr.reduce((a, b) => a + b, 0);
      const recall = hits / arr.length;
      parts.push(`Recall@${k}=${recall.toFixed(2)}`);
    }
    console.log(`    ${catName.padEnd(6)} (${catHits[cat][ks[0]].length}题)：${parts.join('  ')}`);
  }
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
    for (const m of modes) {
      await evaluateMode(evalSet, m, ks);
    }

    // 打印对比总结的表头（详细数据看上面各模式的输出）
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  🎯 三种模式对比总结（召回率）`);
    console.log(`${'='.repeat(60)}`);
    console.log(`  ${'模式'.padEnd(10)}${ks.map(k => `Recall@${k}`.padEnd(12)).join('')}`);
    console.log(`  ${'-'.repeat(58)}`);
    console.log(`  （详情见上方各模式输出）`);
    console.log('');
  } else {
    // 只跑单个模式
    await evaluateMode(evalSet, mode, ks);
  }

  // 关闭数据库连接池，不然 Node 进程不会退出
  await pool.end();
  console.log('✅ 评估完成\n');
}

// 启动
main().catch(err => {
  console.error('❌ 评估失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});
