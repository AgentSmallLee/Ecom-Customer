# Customer Graph 客服工作流图

## 完整工作流

```mermaid
flowchart TD
    START([START]) --> recallMemories[回忆长期记忆<br/>recallMemories]
    recallMemories --> intentRouter[意图识别<br/>intentRouter]

    intentRouter -->|订单相关| orderAgent[订单 Agent<br/>orderAgent]
    intentRouter -->|知识库相关| ragNode[RAG 检索<br/>ragNode]
    intentRouter -->|闲聊/其他| generalChat[通用聊天<br/>generalChat]

    orderAgent --> answerSynthesizer[答案合成<br/>answerSynthesizer]
    ragNode --> answerSynthesizer
    generalChat --> answerSynthesizer

    answerSynthesizer -->|消息超阈值| summarize[摘要压缩<br/>summarize]
    answerSynthesizer -->|正常| END([END])
    summarize --> END

    %% 异步副作用（图外）
    END -.->|fire-and-forget| memoryWriter[(写长期记忆<br/>memoryWriter)]

    style START fill:#dcfce7,stroke:#22c55e,color:#166534
    style END fill:#fef3c7,stroke:#f59e0b,color:#92400e
    style memoryWriter fill:#f3e8ff,stroke:#a855f7,color:#6b21a8,stroke-dasharray: 5 5
```

## 节点说明

| 节点 | 职责 | 输入 | 输出 |
|------|------|------|------|
| `recallMemories` | 从 PostgresStore 召回用户长期记忆（偏好、历史等），注入 state | userInput | userMemories |
| `intentRouter` | 识别用户意图，路由到对应处理节点 | userInput, messages | intent（订单/知识库/闲聊） |
| `orderAgent` | 订单相关查询，调用工具查订单状态、物流等 | userInput, messages | orderResult |
| `ragNode` | 知识库检索，从 pgvector 查相关文档生成答案 | userInput, messages | ragAnswer, sources |
| `generalChat` | 通用闲聊，直接用模型回复 | userInput, messages | chatAnswer |
| `answerSynthesizer` | 合成最终答案，统一格式输出 | 各分支结果 | finalAnswer |
| `summarize` | 消息超阈值时，用 LLM 压缩旧对话为摘要，控制 Token | messages | summary, 裁剪后的 messages |

## 记忆体系

### 短期记忆（图内）
- **Checkpointer（PostgresSaver）**：按 `thread_id` 持久化对话状态
- 每次图执行自动加载/保存，刷新浏览器不丢对话
- `summarize` 节点负责摘要压缩，控制上下文长度

### 长期记忆（部分图内、部分图外）
- **召回（图内）**：`recallMemories` 节点从 PostgresStore 读取用户偏好，注入 prompt
- **写入（图外异步）**：图执行完后 fire-and-forget 调用 `memoryWriterNode`，不阻塞响应
- 按 `user_id` 命名空间存储，跨会话召回

## 流式输出

- **streamMode: `'updates'`**：节点级流式，每个节点执行完推送一次状态更新
- 前端可展示：意图识别结果 → 检索/工具进度 → 最终答案 的完整轨迹
