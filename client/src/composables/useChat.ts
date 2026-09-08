/**
 * Vue3 Composable
 * useChat — 封装对话逻辑，包含流式输出、短期记忆（threadId）
 * 在 View 组件中直接使用，保持组件简洁
 */
import { ref, onMounted, nextTick } from 'vue';
import { streamRequest, request } from '../utils/request.ts';
import type { ChatMessage } from '../types.ts';

const THREAD_STORAGE_KEY = 'chat_thread_id';

type ScrollCallback = () => void | Promise<void>;

interface StreamEventData {
  threadId?: string;
  content?: string;
  error?: string;
  done?: boolean;
}

export function useChat() {
  const messages = ref<ChatMessage[]>([]);  // 完整消息历史
  const streaming = ref(false);             // 是否正在流式输出
  const streamText = ref('');               // 当前流式输出的文本片段
  const error = ref('');                    // 错误信息
  const threadId = ref('');                 // 会话 ID（短期记忆标识）

  // ─── 初始化：恢复 threadId，并拉取历史消息 ───
  onMounted(async () => {
    const saved = localStorage.getItem(THREAD_STORAGE_KEY);
    if (saved) {
      threadId.value = saved;
      await loadHistory();
    }
  });

  // ─── 从服务端拉取历史消息（刷新恢复） ───
  const loadHistory = async () => {
    if (!threadId.value) return;
    try {
      const data = await request<{ messages: ChatMessage[] }>(
        `/chat/history?threadId=${threadId.value}`
      );
      if (data.messages && Array.isArray(data.messages)) {
        messages.value = data.messages;
      }
      console.warn('[useChat] 加载历史成功:', data);
    } catch (err) {
      console.warn('[useChat] 加载历史失败:', err);
      // 加载失败不影响使用，清空 threadId 重新开始
      threadId.value = '';
      localStorage.removeItem(THREAD_STORAGE_KEY);
    }
  };

  // ─── 发送消息（流式）───────────────────────────────────────────
  const sendMessage = async (userInput: string, scrollCallback?: ScrollCallback) => {
    if (!userInput.trim() || streaming.value) return;

    error.value = '';
    messages.value.push({ role: 'user', content: userInput });
    scrollCallback?.();

    streaming.value = true;
    streamText.value = '';

    try {
      // userId 从 token 解析，不在 body 里传
      const response = await streamRequest('/chat/stream', {
        message:  userInput,
        threadId: threadId.value || undefined,
      });

      if (!response.body) throw new Error('响应没有内容');

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');

      // 读取 SSE 流
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n').filter((l) => l.startsWith('data: '));

        for (const line of lines) {
          const raw = line.slice(6).trim();
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw) as StreamEventData;

            // 保存服务端返回的 threadId（新会话时返回）
            if (parsed.threadId && parsed.threadId !== threadId.value) {
              threadId.value = parsed.threadId;
              localStorage.setItem(THREAD_STORAGE_KEY, parsed.threadId);
            }

            if (parsed.error) {
              error.value = parsed.error;
              break;
            }
            if (parsed.done) break;
            if (parsed.content) {
              streamText.value += parsed.content;
              await nextTick();
              scrollCallback?.();
            }
          } catch {
            // 忽略解析失败的片段
          }
        }
      }

      // 流结束，将完整回复存入历史
      if (streamText.value) {
        messages.value.push({ role: 'assistant', content: streamText.value });
      }
    } catch (err) {
      error.value = `请求失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      streaming.value = false;
      streamText.value = '';
      scrollCallback?.();
    }
  };

  // ─── 清空对话 ───────────────────────────────────────────────────
  const clearMessages = () => {
    messages.value = [];
    error.value = '';
    // 换新会话：threadId 重新生成（服务端短期记忆归零）
    threadId.value = '';
    localStorage.removeItem(THREAD_STORAGE_KEY);
  };

  return {
    messages,
    streaming,
    streamText,
    error,
    threadId,
    sendMessage,
    clearMessages,
    loadHistory,
  };
}
