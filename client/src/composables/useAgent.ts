// client/src/composables/useAgent.ts
import { ref, nextTick } from 'vue';
import type { ChatMessage, ToolStep } from '../types.ts';

const API_BASE = 'http://localhost:3000/api';

type ScrollCallback = () => void | Promise<void>;

/** Agent 模式的消息（带思考中标记与工具步骤） */
export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
  thinking?: boolean;
  steps?: ToolStep[];
}

interface AgentStreamEvent {
  type: 'step' | 'answer' | 'done' | 'error';
  tool?: string;
  toolInput?: Record<string, unknown>;
  observation?: string;
  content?: string;
}

export function useAgent() {
  const messages = ref<AgentMessage[]>([]);
  const loading  = ref(false);
  const steps    = ref<ToolStep[]>([]);
  const error    = ref('');

  const sendMessage = async (userInput: string, scrollCallback?: ScrollCallback) => {
    if (!userInput.trim() || loading.value) return;

    error.value = '';
    steps.value = [];
    messages.value.push({ role: 'user', content: userInput });
    scrollCallback?.();

    loading.value = true;

    const assistantIndex = messages.value.length;
    messages.value.push({ role: 'assistant', content: '', thinking: true });

    try {
      const history: ChatMessage[] = messages.value
        .slice(0, -1)
        .slice(-10)
        .filter((m) => !m.thinking)
        .map(({ role, content }) => ({ role, content }));

      const response = await fetch(`${API_BASE}/agent/stream`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message: userInput, history }),
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
            const parsed = JSON.parse(line.slice(6)) as AgentStreamEvent;

            if (parsed.type === 'step') {
              steps.value.push({
                tool:        parsed.tool ?? '',
                toolInput:   parsed.toolInput,
                observation: parsed.observation,
              });
              await nextTick();
              scrollCallback?.();
            }

            if (parsed.type === 'answer') {
              messages.value[assistantIndex] = {
                role:    'assistant',
                content: parsed.content ?? '',
                steps:   [...steps.value],
              };
              await nextTick();
              scrollCallback?.();
            }

            if (parsed.type === 'done') {
              steps.value = [];
            }

            if (parsed.type === 'error') {
              messages.value[assistantIndex] = {
                role:    'assistant',
                content: parsed.content ?? '',
              };
            }
          } catch { /* 忽略解析失败的片段 */ }
        }
      }
    } catch (err) {
      error.value = `请求失败：${err instanceof Error ? err.message : String(err)}`;
      messages.value.pop();
    } finally {
      loading.value = false;
    }
  };

  const clearMessages = () => {
    messages.value = [];
    steps.value    = [];
    error.value    = '';
  };

  return { messages, loading, steps, error, sendMessage, clearMessages };
}
