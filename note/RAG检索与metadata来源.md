# RAG 检索：retriever 返回格式与 metadata.source 来源

## 一、retriever.invoke() 返回什么

`retriever.invoke(question)` 把问题转成向量，去向量数据库做相似度查询，返回**最相关的文档数组**：

```typescript
Document[]  // 每个 Document 的结构：
{
  pageContent: "红松心选的退换货政策是：签收后7天内...",  // 文档内容（字符串）
  metadata: {
    source: "policies.md",  // 来源文件名
    // 其他自定义元数据...
  }
}
```

对应代码中的用法：

```typescript
// rag-chain.ts
const formatDocs = (docs: { pageContent: string }[]) =>
  docs.map((doc) => doc.pageContent).join('\n\n---\n\n');
```

就是把每个 doc 的 `pageContent` 取出来，用分隔符拼成一段长文本，作为 prompt 的 `context` 变量。

---

## 二、metadata.source 是从哪里来的

**在文档入库脚本里手动设置的**，不是向量库自动生成的。

位置：`server/src/scripts/ingest.ts`

```typescript
const loadDocs = () => {
  const files = ['products.md', 'policies.md'];
  return files.map((file) => {
    const content = readFileSync(
      join(__dirname, '../data/knowledge', file),
      'utf-8'
    );
    // 手动构造 Document，指定 metadata.source = 文件名
    return new Document({ pageContent: content, metadata: { source: file } });
  });
};
```

---

## 三、完整链路：从文件到查询结果

```
原始文件
  ├── src/data/knowledge/products.md
  └── src/data/knowledge/policies.md
        │
        │  readFileSync 读取文件内容
        ▼
  new Document({ pageContent, metadata: { source: file } })
        │  source = 文件名（"products.md" / "policies.md"）
        ▼
  RecursiveCharacterTextSplitter 切分（chunkSize: 500, overlap: 50）
        │  切分后每个 chunk 继承父文档的 metadata
        ▼
  PGVectorStore.fromDocuments(...) 存入 pgvector
        │  content 列存文本，metadata 列存 JSON（含 source）
        ▼
  ───────── 存储 ─────────
        ▼
  retriever.invoke(question) 查询
        │  按向量相似度排序，取 top-k（k=4）
        ▼
  Document[]（每个都带着 metadata.source）
        │
        ▼
  formatDocs → 拼成 context 文本，喂给 prompt
```

---

## 四、关键点

| 问题 | 答案 |
|------|------|
| source 存在哪 | pgvector 的 `metadata` 列，JSON 格式 |
| source 值是什么 | 入库时设置的**文件名**，不是完整路径 |
| 切分后还在吗 | 在，`splitDocuments` 会把父文档的 metadata 原样传给每个 chunk |
| 为什么需要 source | 回答时可以告诉用户答案来自哪份文档，增加可信度 |

---

## 五、快速记忆

> **入库时设置 → 切分时继承 → 存储时落库 → 查询时原样返回**
>
> metadata 就是贴在文档上的标签，跟着文档走完整条流水线。
