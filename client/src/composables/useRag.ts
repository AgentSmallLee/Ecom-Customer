// client/src/composables/useRag.ts
import { ref } from 'vue';
import { streamRequest } from '../utils/request.ts';
import type { SourceInfo } from '../types.ts';

type ScrollCallback = () => void | Promise<void>;

/** RAG 模式的消息（带参考来源与加载标记） */
export interface RagMessage {
  role: 'user' | 'assistant';
  content: string;
  sources?: SourceInfo[];
  loading?: boolean;
}

interface RagStreamEvent {
  type: 'sources' | 'token' | 'answer' | 'error' | 'done';
  sources?: SourceInfo[];
  content?: string;
}

export function useRag() {
  const messages = ref<RagMessage[]>([]);
  const loading  = ref(false);
  const error    = ref('');

  const ask = async (question: string, scrollCallback?: ScrollCallback) => {
    if (!question.trim() || loading.value) return;

    error.value = '';
    messages.value.push({ role: 'user', content: question });
    scrollCallback?.();

    loading.value = true;

    const assistantIndex = messages.value.length;
    messages.value.push({ role: 'assistant', content: '', sources: [], loading: true });

    try {
      // RAG 知识库查询：登录态下调用，后端从 token 解析用户身份
      const response = await streamRequest('/rag/query', { question });

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
            const parsed = JSON.parse(line.slice(6)) as RagStreamEvent;

            if (parsed.type === 'sources') {
              // 按 source（文档标题）去重，同一个文档的多个 chunk 只展示一次
              const rawSources = parsed.sources ?? [];
              const seen = new Set<string>();
              const deduped = rawSources.filter(s => {
                if (seen.has(s.source)) return false;
                seen.add(s.source);
                return true;
              });
              messages.value[assistantIndex] = {
                ...messages.value[assistantIndex]!,
                sources: deduped,
              };
            }

            // 流式 token：追加到当前消息内容
            if (parsed.type === 'token' && parsed.content) {
              const current = messages.value[assistantIndex]!;
              messages.value[assistantIndex] = {
                ...current,
                content: current.content + parsed.content,
                loading: true,
              };
              scrollCallback?.();
            }

            // 最终完整回答：更新内容，loading 置为 false
            if (parsed.type === 'answer') {
              messages.value[assistantIndex] = {
                role:    'assistant',
                content: parsed.content ?? '',
                sources: messages.value[assistantIndex]?.sources,
                loading: false,
              };
              scrollCallback?.();
            }

            if (parsed.type === 'error') {
              messages.value[assistantIndex] = {
                role: 'assistant', content: parsed.content ?? '',
                sources: [], loading: false,
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
    error.value    = '';
  };

  return { messages, loading, error, ask, clearMessages };
}
