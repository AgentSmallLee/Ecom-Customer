// client/src/composables/useGraph.ts
import { ref, nextTick } from 'vue';
import type { ToolStep } from '../types.ts';

const API_BASE = 'http://localhost:3000/api';

/** 长期记忆的用户标识：localStorage 持久化，跨会话（thread）不变 */
const USER_ID_KEY = 'ecom_user_id';
const getUserId = (): string => {
  let id = localStorage.getItem(USER_ID_KEY);
  if (!id) {
    id = `U-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem(USER_ID_KEY, id);
  }
  return id;
};

type ScrollCallback = () => void | Promise<void>;

export const NODE_LABELS: Record<string, string> = {
  recallMemories:    '记忆召回',
  intentRouter:      '意图识别',
  orderAgent:        '订单查询',
  ragNode:           '知识库检索',
  generalChat:       '通用对话',
  answerSynthesizer: '整理回答',
  summarize:         '历史压缩',
  memoryWriter:      '记忆沉淀',
};

export const INTENT_LABELS: Record<string, string> = {
  order:     '订单查询',
  knowledge: '知识库问答',
  general:   '通用对话',
};

/** Graph 模式的消息（带工作流轨迹） */
export interface GraphMessage {
  role: 'user' | 'assistant';
  content: string;
  nodes?: string[];
  intent?: string;
  steps?: ToolStep[];
  loading?: boolean;
}

interface GraphStreamEvent {
  type: 'node' | 'steps' | 'answer' | 'error' | 'done';
  node?: string;
  intent?: string | null;
  steps?: ToolStep[];
  content?: string;
}

export function useGraph() {
  const messages    = ref<GraphMessage[]>([]);
  const loading     = ref(false);
  const currentNode = ref('');
  const error       = ref('');

  // 会话标识（短期记忆的 key）与用户标识（长期记忆的 key）
  const threadId = ref<string>(crypto.randomUUID());
  const userId   = ref<string>(getUserId());

  const sendMessage = async (userInput: string, scrollCallback?: ScrollCallback) => {
    if (!userInput.trim() || loading.value) return;

    error.value       = '';
    currentNode.value = '';
    messages.value.push({ role: 'user', content: userInput });
    scrollCallback?.();

    loading.value = true;

    const assistantIndex = messages.value.length;
    messages.value.push({
      role: 'assistant', content: '',
      nodes: [], intent: '', steps: [], loading: true,
    });

    try {
      // 历史由服务端 checkpointer 按 threadId 管理，前端只传会话/用户标识
      const response = await fetch(`${API_BASE}/graph/stream`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          message:  userInput,
          threadId: threadId.value,
          userId:   userId.value,
        }),
      });

      if (!response.body) throw new Error('响应没有内容');
      const reader  = response.body.getReader();
      const decoder = new TextDecoder('utf-8');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const lines = decoder
          .decode(value, { stream: true })
          .split('\n')
          .filter((l) => l.startsWith('data: '));

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line.slice(6)) as GraphStreamEvent;

            if (parsed.type === 'node' && parsed.node) {
              currentNode.value = NODE_LABELS[parsed.node] || parsed.node;
              const msg = messages.value[assistantIndex]!;
              if (!msg.nodes?.includes(parsed.node)) {
                messages.value[assistantIndex] = {
                  ...msg,
                  nodes:  [...(msg.nodes ?? []), parsed.node],
                  intent: parsed.intent
                    ? (INTENT_LABELS[parsed.intent] || parsed.intent)
                    : msg.intent,
                };
              }
              await nextTick();
              scrollCallback?.();
            }

            if (parsed.type === 'steps') {
              messages.value[assistantIndex] = {
                ...messages.value[assistantIndex]!,
                steps: parsed.steps ?? [],
              };
            }

            if (parsed.type === 'answer') {
              messages.value[assistantIndex] = {
                ...messages.value[assistantIndex]!,
                content: parsed.content ?? '',
                loading: false,
              };
              currentNode.value = '';
              await nextTick();
              scrollCallback?.();
            }

            if (parsed.type === 'error') {
              messages.value[assistantIndex] = {
                ...messages.value[assistantIndex]!,
                content: parsed.content ?? '',
                loading: false,
              };
              currentNode.value = '';
            }
          } catch { /* 忽略解析失败的片段 */ }
        }
      }
    } catch (err) {
      error.value = `请求失败：${err instanceof Error ? err.message : String(err)}`;
      messages.value.pop();
    } finally {
      loading.value     = false;
      currentNode.value = '';
    }
  };

  const clearMessages = () => {
    messages.value    = [];
    currentNode.value = '';
    error.value       = '';
    // 换新会话：threadId 重新生成（服务端短期记忆归零），userId 不变（长期记忆保留）
    threadId.value = crypto.randomUUID();
  };

  return {
    messages, loading, currentNode, error,
    threadId, userId,
    sendMessage, clearMessages,
  };
}
