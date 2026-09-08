// client/src/composables/useAgent.ts
// Agent 对话逻辑：流式输出 + 短期记忆（threadId）
import { ref, onMounted, nextTick } from 'vue';
import type { ToolStep } from '../types.ts';

const API_BASE = 'http://localhost:3000/api';
const THREAD_STORAGE_KEY = 'agent_thread_id';
const USER_STORAGE_KEY = 'agent_user_id';

/** 获取/生成用户 ID（长期记忆标识，跨会话保留） */
const getUserId = (): string => {
  let id = localStorage.getItem(USER_STORAGE_KEY);
  if (!id) {
    id = `U-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem(USER_STORAGE_KEY, id);
  }
  return id;
};

type ScrollCallback = () => void | Promise<void>;

/** Agent 模式的消息（带思考内容与工具步骤） */
export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;        // 最终答案
  thinkingContent?: string; // 调用工具前的思考/过渡语
  steps?: ToolStep[];
}

interface AgentStreamEvent {
  type: 'threadId' | 'token' | 'step' | 'answer' | 'done' | 'error';
  threadId?: string;
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
  const threadId = ref('');
  const userId   = ref('');

  // ─── 初始化：生成 userId + 恢复 threadId，并拉取历史消息 ───
  onMounted(async () => {
    userId.value = getUserId();
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
      const res = await fetch(`${API_BASE}/agent/history?threadId=${threadId.value}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.messages && Array.isArray(data.messages)) {
        messages.value = data.messages.map((m: { role: string; content: string }) => ({
          role:    m.role as 'user' | 'assistant',
          content: m.content,
        }));
      }
    } catch (err) {
      console.warn('[useAgent] 加载历史失败:', err);
      // 加载失败不影响使用，清空 threadId 重新开始
      threadId.value = '';
      localStorage.removeItem(THREAD_STORAGE_KEY);
    }
  };

  // ─── 发送消息（流式）───────────────────────────────────────────
  const sendMessage = async (userInput: string, scrollCallback?: ScrollCallback) => {
    if (!userInput.trim() || loading.value) return;

    error.value = '';
    steps.value = [];
    messages.value.push({ role: 'user', content: userInput });
    scrollCallback?.();

    loading.value = true;

    const assistantIndex = messages.value.length;
    // 初始消息：内容为空，还没开始生成
    messages.value.push({ role: 'assistant', content: '', thinkingContent: '', steps: [] });

    try {
      const response = await fetch(`${API_BASE}/agent/stream`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          message:  userInput,
          threadId: threadId.value || undefined,
          userId:   userId.value,
        }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error('响应没有内容');

      const reader  = response.body.getReader();
      const decoder = new TextDecoder('utf-8');

      // 标记当前阶段：firstReply（工具调用前的 AI 回复）还是 finalAnswer（工具返回后的最终答案）
      let phase: 'firstReply' | 'finalAnswer' = 'firstReply';

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

            // 保存服务端返回的 threadId（新会话时返回）
            if (parsed.type === 'threadId' && parsed.threadId && parsed.threadId !== threadId.value) {
              threadId.value = parsed.threadId;
              localStorage.setItem(THREAD_STORAGE_KEY, parsed.threadId);
            }

            if (parsed.type === 'token') {
              const msg = messages.value[assistantIndex];
              if (msg) {
                if (phase === 'firstReply') {
                  // 第一阶段：调用工具前的 AI 回复，存为思考内容
                  msg.thinkingContent = (msg.thinkingContent || '') + (parsed.content ?? '');
                } else {
                  // 第二阶段：最终答案，正常累加
                  msg.content += parsed.content ?? '';
                }
              }
              await nextTick();
              scrollCallback?.();
            }

            if (parsed.type === 'step') {
              const stepData = {
                tool:        parsed.tool ?? '',
                toolInput:   parsed.toolInput,
                observation: parsed.observation,
              };
              steps.value.push(stepData);
              // 同步加到当前消息的 steps 里，实时展示在气泡中
              const msg = messages.value[assistantIndex];
              if (msg) {
                if (!msg.steps) msg.steps = [];
                msg.steps.push(stepData);
              }
              // 出现 step 说明进入最终答案阶段了
              phase = 'finalAnswer';
              await nextTick();
              scrollCallback?.();
            }

            if (parsed.type === 'answer') {
              const prevMsg = messages.value[assistantIndex];
              const hasSteps = steps.value.length > 0;
              // 如果没有工具调用（纯对话），把思考内容当作最终答案
              const finalContent = hasSteps
                ? (parsed.content ?? '')
                : (prevMsg?.thinkingContent || parsed.content || '');

              messages.value[assistantIndex] = {
                role:            'assistant',
                content:         finalContent,
                thinkingContent: hasSteps ? (prevMsg?.thinkingContent || '') : '',
                steps:           [...steps.value],
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

  // ─── 清空对话 ───────────────────────────────────────────────────
  const clearMessages = () => {
    messages.value = [];
    steps.value    = [];
    error.value    = '';
    // 换新会话：threadId 重新生成（服务端短期记忆归零），userId 不变（长期记忆保留）
    threadId.value = '';
    localStorage.removeItem(THREAD_STORAGE_KEY);
  };

  return {
    messages,
    loading,
    steps,
    error,
    threadId,
    sendMessage,
    clearMessages,
    loadHistory,
  };
}
