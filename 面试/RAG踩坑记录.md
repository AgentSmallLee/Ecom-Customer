# RAG 面试踩坑记录

> 项目开发中遇到的实际问题、原因分析和解决方案，面试时可以拿出来讲，体现实战经验。

---

## 1. Embedding API 批量大小限制踩坑

### 现象

把 TextSplitter 的 `chunkSize` 从 500 改到 20 后，入库时报错：

```
400 InternalError.Algo.InvalidParameter: 
Value error, batch size is invalid, it should not be larger than 20.: input.contents
```

### 原因分析

报错和 TextSplitter 的 chunkSize 本身**没有直接关系**，根源是 **Embedding API 的批量请求限制**。

**完整因果链：**

```
chunkSize 从 500 改到 20
    ↓
每个文档被切成更多 chunk（比如从 10 个变成 250 个）
    ↓
embedDocuments() 需要处理的文本数量暴增
    ↓
OpenAIEmbeddings 批量调用 API 时，单次请求超过了 20 条
    ↓
阿里云百炼 API 拒绝请求，报 400
```

**根本原因：**
- 我们用的是**阿里云百炼**的 embedding 接口（OpenAI 兼容模式）
- 百炼的 embedding API **单次请求最多 20 条文本**
- LangChain 的 `OpenAIEmbeddings` 默认 `batchSize = 512`（按 OpenAI 官方的标准设计的）
- 我们的配置里没有设置 `batchSize`，用了默认值 512
- chunkSize=500 时，总共切出来的 chunk 少于 20 个，一次请求就发完了，侥幸没触发限制
- chunkSize=20 时，切出几百个 chunk，踩到了百炼的 20 条限制

### 解决方案

在 `models/embedding.ts` 的 `OpenAIEmbeddings` 配置中加上 `batchSize: 20`：

```ts
export const embeddings = new OpenAIEmbeddings({
  modelName:    'qwen3.7-text-embedding',
  openAIApiKey: process.env.DASHSCOPE_API_KEY,
  configuration: {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  batchSize: 20,  // 对齐百炼的批量限制，默认 512 会超限
});
```

加上之后，LangChain 会自动把文本拆成每批 20 条，循环调用 API。

### 经验总结

1. **第三方 OpenAI 兼容接口不能想当然**：批量大小、速率限制、向量维度、参数名称，都要对着厂商文档确认，不能直接套 OpenAI 的默认值
2. **有三个容易搞混的 "chunkSize/batchSize"**：

| 配置项 | 所属模块 | 作用 | 默认值 |
|---|---|---|---|
| `chunkSize` | RecursiveCharacterTextSplitter | 文本切分的每段字符数 | 1000 |
| `chunkSize` | PGVectorStore | 数据库批量 INSERT 的行数 | 500 |
| `batchSize` | OpenAIEmbeddings | embedding API 单次请求的文本数 | 512 |

3. **小数据量时问题容易被掩盖**：文档少、chunk 少的时候，批量限制永远触发不了，问题不会暴露。数据量上来才会炸，所以上线前一定要做压测

---

## 2. （待补充更多踩坑记录...）

