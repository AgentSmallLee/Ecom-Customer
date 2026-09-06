# AI Agent 后端：Express 还是 NestJS？

> 结合本项目（Express + LangChain/LangGraph 的电商 AI 客服）分析两者差异与选型建议。配合 [[ts-vs-js-for-ai-agent]] 阅读。

## 结论先行

- **原型 / 学习 / 小项目（<10 个路由）**：选 **Express**。心智负担低，LangChain 官方示例几乎全是 Express 风格，代码量最少。
- **长期维护的企业级 Agent 平台**（多 Agent 编排、多模块、团队协作、需要鉴权/限流/审计等工程能力）：选 **NestJS**。它的模块化和依赖注入恰好匹配 Agent 项目的"多服务编排"形态。
- **本项目现状**：Express 完全够用，不必迁移。

---

## 两者的本质区别

一句话概括：

> **Express 是一个路由库，NestJS 是一个应用框架。**
>
> Express 只给你 `app.get/post` 和中间件管道，剩下的架构自己搭；NestJS 把 Angular 风格的模块、依赖注入（DI）、生命周期管理、微服务等整套工程化方案都给你搭好了。

| 维度 | Express | NestJS |
|------|---------|--------|
| 定位 | 极简 HTTP 中间件框架 | 企业级全功能框架（基于 Express/Fastify） |
| 代码风格 | 函数式、自由组织 | 面向对象：Module / Controller / Provider / Service |
| 依赖注入 | 无（自己 new / 单例） | 内置（Angular 风格的 DI 容器） |
| TypeScript | 需要自己配 | 原生 TS，框架本身就是 TS 写的 |
| 学习曲线 | 半小时上手 | 需要理解 DI、装饰器、模块树 |
| 脚手架 | 手动建目录 | `nest g module/service/controller` 自动生成 |
| 内置能力 | 路由、中间件，仅此而已 | 鉴权(Guard)、校验(Pipe+class-validator)、拦截器、过滤器、配置中心、OpenAPI 自动文档 |
| 测试 | 需要自己搭（supertest 等） | 内置 `@nestjs/testing`，DI 天然利于 mock |
| 社区生态 | 最大（Node 后端事实标准） | 大且增长快，企业采用率高 |
| 性能 | 与 NestJS（Express 底层）持平 | 换 Fastify 底层更快一点，差别不重要 |

---

## 同一个功能，两种写法的直观对比

以本项目 `POST /api/rag/query` 为例。

**Express（现状，~35 行）：**

```ts
// routes/rag.ts — 一个文件搞定
const router = express.Router();
router.post('/query', async (req, res) => {
  const { question } = req.body as { question?: string };
  if (!question) return res.status(400).json({ error: 'question 不能为空' });
  const result = await ragChainWithSources.invoke({ question });
  res.write(`data: ${JSON.stringify(result)}\n\n`);
});
```

**NestJS（等效，拆成 3 个文件）：**

```ts
// rag.controller.ts
@Controller('rag')
export class RagController {
  constructor(private readonly ragService: RagService) {}
  @Post('query')
  query(@Body() dto: QueryDto): Observable<string> { ... }
}

// rag.service.ts  — Agent/Chain 逻辑在这里
@Injectable()
export class RagService {
  constructor(
    private readonly embedding: EmbeddingProvider,   // 注入，不用手动 new
    private readonly modelFactory: ModelFactory,
  ) {}
}

// rag.module.ts — 显式声明依赖边界
@Module({ controllers: [RagController], providers: [RagService, ...] })
export class RagModule {}
```

**读法**：Express 一个文件直给，快；NestJS 拆成三层，多写代码换来的是——`RagService` 的依赖由容器注入，测试时可以一行替换成 mock；模块边界（`RagModule`）显式声明，多人协作不会互相踩。

---

## AI Agent 后端的特殊考量

### 1. Agent 是"重服务"架构，DI 价值被放大

普通 CRUD 后端每个请求独立；Agent 后端的核心是**长生命周期对象**：LLM 客户端、向量库连接、图编译产物（`graph.compile()` 的结果）、检索器。本项目里这些东西都是模块顶层的单例：

```ts
// rag-chain.ts — 全局单例，模块加载时初始化
const vectorStore = await PGVectorStore.initialize(embeddings, PG_CONFIG);
```

Express 下这没问题，但缺点是：
- 初始化顺序靠 import 链隐式决定，项目大了很难追踪
- 想换实现（比如 mock 掉向量库做测试）要改源码
- 服务启动失败时错误堆栈深

NestJS 的 DI 恰好解决这些：`PGVectorStore` 作为 Provider 注册，生命周期由框架管理，`@Injectable()` 一行替换实现，测试直接 `Test.createTestingModule({ ... }).overrideProvider(...)`。

### 2. SSE 流式响应两边都支持，但写法不同

Agent 的标配是流式输出（本项目 4 个接口里 3 个是 SSE）：
- Express：手动 `res.setHeader` + `res.write`，全靠自己（本项目的写法）
- NestJS：装饰器 + RxJS（`@Sse()` 装饰器直接返回 `Observable`），管道化处理更规整，但需要学 RxJS

**这个维度算平手**——Express 手动但直白，NestJS 规整但概念多一层。

### 3. LangChain/LangGraph 与框架无关

重要事实：**Agent 框架（LangChain）不关心你用什么 Web 框架**。`chains`、`graphs`、`tools`、`agents` 目录下的代码在 Express 和 NestJS 里一模一样——迁移成本只在 `routes` 和 `index` 这一层。这也是为什么"先 Express 起步、后迁 NestJS"的路径是可行的（如果需要的话）。

### 4. NestJS 的杀手锏场景

当你的 Agent 项目长出这些需求时，NestJS 开始明显划算：

- **多租户鉴权**：Guard 装饰器统一拦截，给每个请求注入"当前用户的 LLM 配额/模型偏好"
- **限流与成本控制**：Interceptor 统一统计每个请求的 token 消耗、按用户记账
- **配置热切换**：`@nestjs/config` 集中管理 API Key、模型选择，环境隔离
- **后台任务**：`@nestjs/bull` 队列处理文档入库、批量 embedding 等长任务
- **API 文档**：Swagger 装饰器自动生成，前端对接省事
- **多 Agent 平台化**：每个 Agent 一个 Module，按需挂载

---

## 决策清单

| 你的情况 | 推荐 |
|---------|------|
| 跟教程学 LangChain/LangGraph | Express |
| 快速验证 prompt / Agent 思路 | Express |
| 个人项目，路由 < 10 个 | Express |
| 团队 3 人以上协作 | NestJS |
| 需要鉴权、限流、审计、多租户 | NestJS |
| 多 Agent 平台、要按模块划分领域 | NestJS |
| 微服务化（网关 + 多个 Agent 服务） | NestJS（原生支持微服务模块） |

## 渐进迁移路径（如果以后要迁）

> **✅ 本项目已于 2026-09-06 按此路径完成 Express → NestJS 迁移**，实际执行差异见下。

由于 Agent 核心逻辑与框架无关，迁移只动壳：

```
1. rag-chain / graphs / tools / agents 保持不动
2. routes/*.ts → 改写为 Controller + Service（薄壳，逻辑已在 Service 里）
3. 模块顶层单例（vectorStore、graph、agentApp）→ 注册为 Provider
4. SSE 手写 → @Sse() 装饰器（可选）
```

### 实际执行记录

- **目录结构**：`src/routes/` 删除，改为 `src/{chat,agent,rag,graph}/` 各含 `*.module.ts` + `*.controller.ts` + `*.service.ts`；入口 `index.ts` → `main.ts`（`NestFactory.create` + `setGlobalPrefix('api')`）。
- **核心逻辑零改动**：`chains/ graphs/ tools/ agents/ models/ db/ data/ prompts/ scripts/` 全部未动，验证了"Agent 智能在 LangChain 层，Web 框架只是壳"的判断。
- **单例迁移**：`agentApp`（routes/agent.ts 模块级单例）→ `AgentService` 的私有实例；`graph`（lazy 单例）→ `GraphService` 私有实例。`rag-chain.ts` 的顶层 `await PGVectorStore.initialize` 保持模块级加载（导入 RagService 时触发），未改为 Provider——如需更优雅可后续抽成 `RagModule` 的 async Provider。
- **关键坑：tsx/esbuild 不发射 `design:paramtypes` 元数据**，NestJS 的按类型自动注入失效，所有 controller 构造函数必须显式 `@Inject(ServiceClass)`（这是 NestJS 官方对 swc/esbuild 的标准建议）。tsconfig 需加 `experimentalDecorators: true`。
- **SSE 保持 POST + 手写**：`@Sse()` 装饰器只支持 GET，而本项目 4 个流式接口都是 POST，故用 `@Res()` 注入原生 express Response 手写 SSE，代码与 Express 版几乎逐行相同，前端零改动。
- **验证结果**：`tsc --noEmit` ✅；`GET /`、`GET /api/chat/health`、`POST /api/chat`（非流式）、`POST /api/chat/stream`（SSE 逐字流出）、`POST /api/agent/stream`（工具调用步骤→回答→done）、`POST /api/graph/stream`（节点轨迹+steps）、`POST /api/rag/query`（来源+回答）、400 参数校验，全部与迁移前行为一致。

## 一句话总结

> **Express 决定你今天能多快跑起来，NestJS 决定一年后它还能不能被十个人一起维护。**
>
> Agent 的核心智能在 LangChain 层，Web 框架只是壳——先用 Express 把壳做薄，等工程复杂度（鉴权/多租户/团队规模）真正到了，再换 NestJS 也不迟。
