// server/src/scripts/eval-precision.ts
// RAG 检索准确率（Precision@K）评估脚本
//
// 用法（推荐用 pnpm 脚本）：
//   pnpm eval-precision -- --mode all       # 三种模式一起对比（推荐）
//   pnpm eval-precision                     # 混合检索，评测所有 K 值（默认）
//   pnpm eval-precision -- --mode vector    # 纯向量检索
//   pnpm eval-precision -- --mode keyword   # 纯关键词检索
//   pnpm eval-precision -- --mode hybrid    # 混合检索
//   pnpm eval-precision -- --k 5            # 只评测指定 K 值
//   pnpm eval-precision -- --ks 1,3,5,10    # 评测多个 K 值
//
// 准确率（Precision@K）是什么？
//   检索返回的 top-K 条结果中，有多少是真正相关的？
//   通俗说：捞回来的东西里，靠谱的比例有多大？
//   和召回率的区别：召回率怕漏掉（查全率），准确率怕掺假（查准率）。
//
// 相关判断标准：
//   chunk 的内容包含 expectedSource（正确答案所在的商品/政策标题）就算相关
//   无答案问题：top-K 里一条相关的都没有 → Precision = 1.0（没乱召回就是准）
//
// 为什么用文档标题匹配当相关标准？
//   1. 实现简单，不用给每个 chunk 单独人工标注
//   2. 复用现有评测集，零额外标注成本
//   3. 电商客服场景下，同一个商品的信息都算相关，比较合理
//   4. 当然这是近似标准，真要严格可以用 embedding 相似度阈值或人工标注

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { vectorSearch, keywordSearch, hybridSearch } from '../chains/rag-chain.ts';
import { pool } from '../db/postgres.ts';

// 当前文件所在目录（ESM 环境下没有 __dirname，需要手动计算）
const __dirname = dirname(fileURLToPath(import.meta.url));
// 评测集文件路径：每个问题包含预期的正确答案来源（expectedSource）
const EVAL_FILE = join(__dirname, '../data/eval/eval-set.json');

type Mode = 'vector' | 'keyword' | 'hybrid';

// 评测集每一项的类型定义
interface EvalItem {
  question: string;          // 用户问题
  category: 'product' | 'policy' | 'none'; // 问题分类，用于分类统计
  expectedSource: string;    // 正确答案所在的文档/商品标题，用来判断 chunk 是否相关
  expectedKeywords: string[]; // 预期关键词（备用，当前 Precision 评估不用这个）
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

// ────────────────────────────────────────────
// 判断单个 chunk 是否相关
// ────────────────────────────────────────────
// 相关标准：chunk 的文本内容包含 expectedSource 字符串。
// 比如 expectedSource 是 "蓝牙耳机 X1 Pro"，只要 chunk 里有这个标题就算相关。
//
// 无答案问题（expectedSource 为空）：不存在相关的 chunk，直接返回 false。
function isRelevant(doc: { pageContent: string }, expectedSource: string): boolean {
  if (!expectedSource) return false;
  return doc.pageContent.includes(expectedSource);
}

// ────────────────────────────────────────────
// 计算单个问题的 Precision@K
// ────────────────────────────────────────────
// Precision@K = top-K 结果中相关的数量 ÷ 实际返回数量
//
// 为什么用实际返回数量做分母而不是固定用 K？
//   因为有时候检索结果可能不足 K 条（比如无答案问题就一条都搜不到），
//   用实际返回数量更合理——总共就返回了 3 条，总不能拿 5 当分母。
//
// 无答案问题的特殊处理：
//   - 一条都没召回 → 1.0（没乱召回，很准）
//   - 召回了任何东西 → 0.0（乱召回了，不准）
//   这是因为无答案问题不存在"相关文档"，不能用普通公式算。
function calcPrecision(
  docs: { pageContent: string }[],
  expectedSource: string,
  k: number,
): number {
  // 截取 top-K 条结果（slice 越界不会报错，自动截断到实际长度）
  const topK = docs.slice(0, k);

  // 一条结果都没有
  if (topK.length === 0) {
    if (!expectedSource) return 1.0; // 无答案问题，没乱召回 = 准
    return 0;
  }

  // 无答案问题：只要召回了东西，就是不准
  if (!expectedSource) return 0;

  // 统计 top-K 里有多少条是相关的
  const relevantCount = topK.filter(d => isRelevant(d, expectedSource)).length;
  // 准确率 = 相关数量 ÷ 实际返回数量
  return relevantCount / topK.length;
}

// ────────────────────────────────────────────
// 评估单个检索模式
// ────────────────────────────────────────────
// 流程：
//   1. 遍历评测集中的每个问题
//   2. 对每个问题，一次检索拿 maxK 条结果（所有 K 值共用，省 API 调用）
//   3. 对每个 K 值，分别计算 Precision
//   4. 最后统计总体准确率和分类准确率
//
// 为什么一次拿 maxK 而不是每个 K 各查一次？
//   假设有 4 个 K 值（1,3,5,10），49 道题：
//   - 每个 K 各查一次：49 × 4 = 196 次检索调用
//   - 一次拿最大 K 再切片：49 × 1 = 49 次检索调用
//   直接省了 75% 的调用量和时间，结果完全一样。
//   这是一个很常见的小优化，召回率脚本里也是同样的做法。
async function evaluateMode(evalSet: EvalItem[], mode: Mode, ks: number[]) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  模式：${mode.toUpperCase()}`);
  console.log(`${'='.repeat(60)}`);

  // 用对象存每个 K 值的准确率列表
  // 比如 precisionByK[4] = [1.0, 0.5, 0.75, ...]，每个元素是一个问题的 Precision
  const precisionByK: Record<number, number[]> = {};
  ks.forEach(k => (precisionByK[k] = []));

  // 按分类存储，方便看不同类型问题的表现差异
  // 比如：政策查询准确率特别低 → 说明政策类文档的检索需要优化
  const catPrecision: Record<string, Record<number, number[]>> = {
    product: {}, // 商品查询
    policy: {},  // 政策查询
    none: {},    // 无答案问题
  };
  ks.forEach(k => {
    catPrecision.product[k] = [];
    catPrecision.policy[k] = [];
    catPrecision.none[k] = [];
  });

  // 最大的 K 值，一次检索拿这么多，所有小 K 值都从这里切片
  const maxK = Math.max(...ks);

  for (let i = 0; i < evalSet.length; i++) {
    const item = evalSet[i];

    // 打印进度，比如 [12/49] 蓝牙耳机多少钱 ... P@1=1.00 P@3=0.67
    process.stdout.write(`  [${i + 1}/${evalSet.length}] ${item.question} ... `);

    // 只调一次检索，拿 maxK 条结果
    const docs = await searchByMode(item.question, mode, maxK);

    // 对每个 K 值分别计算准确率
    let precStr = '';
    for (const k of ks) {
      const prec = calcPrecision(docs, item.expectedSource, k);
      precisionByK[k].push(prec);
      catPrecision[item.category][k].push(prec);
      precStr += `P@${k}=${prec.toFixed(2)} `;
    }

    console.log(precStr);
  }

  // 输出总体准确率
  console.log(`\n  📊 总体准确率（Precision@K）：`);
  for (const k of ks) {
    // 平均值 = 所有问题的 Precision 之和 ÷ 问题总数
    const avg = precisionByK[k].reduce((a, b) => a + b, 0) / precisionByK[k].length;
    console.log(`    Precision@${k.toString().padEnd(2)} = ${avg.toFixed(4)}`);
  }

  // 输出分类准确率，看不同类型的问题准确率怎么样，方便定位短板
  console.log(`\n  📂 分类准确率：`);
  for (const cat of ['product', 'policy', 'none'] as const) {
    const catName = cat === 'product' ? '商品查询' : cat === 'policy' ? '政策查询' : '无答案';
    const parts: string[] = [];
    for (const k of ks) {
      const arr = catPrecision[cat][k];
      if (arr.length === 0) continue;
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      parts.push(`P@${k}=${avg.toFixed(2)}`);
    }
    console.log(`    ${catName.padEnd(6)} (${catPrecision[cat][ks[0]].length}题)：${parts.join('  ')}`);
  }
}

// ────────────────────────────────────────────
// 主函数
// ────────────────────────────────────────────
async function main() {
  const { mode, ks } = parseArgs();
  const evalSet: EvalItem[] = JSON.parse(readFileSync(EVAL_FILE, 'utf-8'));

  console.log(`\n📚 RAG 检索准确率评估`);
  console.log(`  评测集：${evalSet.length} 个问题`);
  console.log(`  K 值：${ks.join(', ')}`);
  console.log(`  模式：${mode}`);
  console.log(`  相关标准：chunk 包含 expectedSource 标题即为相关`);

  if (mode === 'all') {
    // 三种模式都跑，方便对比
    const modes: Mode[] = ['vector', 'keyword', 'hybrid'];
    for (const m of modes) {
      await evaluateMode(evalSet, m, ks);
    }

    // 打印对比总结的表头（详细数据看上面各模式的输出）
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  🎯 三种模式对比总结（准确率）`);
    console.log(`${'='.repeat(60)}`);
    console.log(`  ${'模式'.padEnd(10)}${ks.map(k => `Prec@${k}`.padEnd(12)).join('')}`);
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
