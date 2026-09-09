# 踩坑：DeepSeek 模型 withStructuredOutput 报错 400

## 报错信息

```
400 Thinking mode does not support this tool_choice
```

## 报错场景

使用 LangChain 的 `withStructuredOutput` + `method: 'functionCalling'` 方式做结构化输出时：

```ts
import { z } from 'zod';

const schema = z.object({
  memories: z.array(z.string()).max(10),
});

const structuredModel = createModel({ temperature: 0 })
  .withStructuredOutput(schema, {
    method: 'functionCalling',
  });
```

调用 `structuredModel.invoke(...)` 时报 400。

## 根本原因

**DeepSeek v4 系列模型（deepseek-v4、deepseek-v4-flash）默认开启了 thinking/reasoning 模式**，而 thinking 模式下不支持 `tool_choice` 参数。

`withStructuredOutput` 的 `functionCalling` 方式底层会设置 `tool_choice: { name: '...' }`，强制模型调用指定工具来输出结构化数据，这和 DeepSeek 的 thinking 模式冲突了。

---

## 解决方案

### 方案 A：换一种结构化输出方式（推荐，兼容性最好）

**不用 `withStructuredOutput`，改用"prompt 约束 + 手动解析 JSON"的方式。**

优点：不依赖模型的 function calling 能力，任何模型都能用。
缺点：需要自己写解析逻辑，偶尔解析失败需要兜底。

```ts
const model = createModel({ temperature: 0 });

const systemPrompt = `你是XXX。
要求：
...（业务规则）...
- **只输出 JSON 数组，不要任何其他文字、不要 markdown 格式、不要解释**
- 示例：["记忆1","记忆2","记忆3"]`;

const response = await model.invoke([
  ['system', systemPrompt],
  ['human', userInput],
]);

const text = typeof response.content === 'string'
  ? response.content
  : JSON.stringify(response.content);

// 三层解析兜底
function parseJSONArray(text: string): string[] {
  // 1. 直接解析
  try {
    const parsed = JSON.parse(text.trim());
    if (Array.isArray(parsed)) return parsed;
  } catch {}

  // 2. 提取 ```json 代码块
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeBlock?.[1]) {
    try {
      const parsed = JSON.parse(codeBlock[1].trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }

  // 3. 提取第一个 [ 到最后一个 ] 之间
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first >= 0 && last > first) {
    try {
      const parsed = JSON.parse(text.slice(first, last + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }

  return [];
}
```

### 方案 B：关掉 thinking 模式（如果模型支持）

有些模型可以通过参数关闭 thinking，比如：

```ts
const model = new ChatOpenAI({
  model: 'deepseek-v4-flash',
  modelKwargs: {
    reasoning_effort: 'low', // 或其他关闭参数
  },
});
```

**注意**：DeepSeek v4 系列的 thinking 关闭参数需要查官方文档，不同版本参数名可能不一样。有些模型可能不支持关闭。

### 方案 C：换用 JSON mode 方式

`withStructuredOutput` 还有另一种方式 `method: 'jsonMode'`，用的是 `response_format: json_object`，不依赖 tool_choice：

```ts
const structuredModel = model.withStructuredOutput(schema, {
  method: 'jsonMode', // 不用 functionCalling
});
```

**注意**：DeepSeek 是否支持 `response_format: json_object` 需要验证，不是所有模型都支持。

---

## 选型建议

| 方案 | 可靠性 | 兼容性 | 开发量 | 推荐度 |
|---|---|---|---|---|
| A. prompt + 手动解析 | 中（需要好的 prompt + 多层解析兜底） | 最高（所有模型都能用） | 中 | ⭐⭐⭐⭐ |
| B. 关 thinking | 高（能关的话） | 低（取决于模型是否支持） | 小 | ⭐⭐⭐ |
| C. jsonMode | 高 | 中（取决于模型是否支持 response_format） | 小 | ⭐⭐⭐⭐（如果支持） |

**项目中最终选了方案 A**，因为：
1. DeepSeek v4 flash 不支持关闭 thinking 模式（或参数不明确）
2. 手动解析的兼容性最好，以后换模型也不用改
3. 三层解析兜底基本能覆盖所有情况，可靠性足够

---

## 延伸思考

`withStructuredOutput` 虽然方便，但对模型能力有要求，生产环境要考虑：

1. **模型切换成本** — 换模型时如果 function calling 支持不一致，代码要改
2. **降级方案** — 结构化输出失败时要有 fallback，不能让整个链路崩
3. **成本** — function calling 方式的 token 成本可能更高（因为要传 schema）

对可靠性要求高的场景，"prompt + 手动解析 + 多层兜底"反而是最稳妥的方案。
