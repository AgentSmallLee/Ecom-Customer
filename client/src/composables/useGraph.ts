// client/src/composables/useGraph.ts
import { ref, nextTick } from 'vue';
import { streamRequest } from '../utils/request.ts';
import type { ToolStep } from '../types.ts';

type ScrollCallback = () => void | Promise<void>;

export const NODE_LABELS: Record<string, string> = {
  recallMemories:    '记忆召回',
  intentRouter:      '意图识别',
  orderAgent:        '订单查询',
  ragNode:           '商品咨询',
  generalChat:       '通用对话',
  answerSynthesizer: '整理回答',
  summarize:         '历史压缩',
  memoryWriter:      '记忆沉淀',
};

export const INTENT_LABELS: Record<string, string> = {
  order:     '订单查询',
  knowledge: '商品咨询',
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
  type: 'node' | 'steps' | 'answer' | 'token' | 'answer_token' | 'error' | 'done';
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

  // 会话标识（短期记忆的 key）
  const threadId = ref<string>(crypto.randomUUID());

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
      // userId 从 token 解析，不在 body 里传
      const response = await streamRequest('/graph/stream', {
        message:  userInput,
        threadId: threadId.value,
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

            // token 级流式输出（answerSynthesizer 节点逐 token 推送）
            if (parsed.type === 'token' || parsed.type === 'answer_token') {
              const msg = messages.value[assistantIndex]!;
              messages.value[assistantIndex] = {
                ...msg,
                content: (msg.content || '') + (parsed.content || ''),
              };
              await nextTick();
              scrollCallback?.();
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
    // 换新会话：threadId 重新生成（服务端短期记忆归零）
    threadId.value = crypto.randomUUID();
  };

  return {
    messages, loading, currentNode, error,
    threadId,
    sendMessage, clearMessages,
  };
}
