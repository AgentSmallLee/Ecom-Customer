<!-- monitor/src/App.vue -->
<!-- LLM 监控台（独立应用）：模型健康 / 失败率 / 调用审计日志（支持过滤与分页）/ Token 用量统计 -->
<template>
  <div class="llm-page">
    <header class="page-header">
      <div class="header-left">
        <div class="avatar">监</div>
        <div class="header-info">
          <h1>LLM 监控</h1>
          <span class="subtitle">模型健康 · 失败率 · 调用审计 · Token 用量</span>
        </div>
      </div>
      <button class="ghost-btn" :disabled="loading" @click="refreshAll">
        {{ loading ? '刷新中…' : '刷新' }}
      </button>
    </header>

    <main class="page-body">
      <div v-if="error" class="error-tip">{{ error }}</div>

      <!-- 模型健康 + 失败率 -->
      <section class="grid-2">
        <div class="card">
          <div class="card-head">
            <span class="card-title">模型健康状态</span>
            <span class="card-sub">{{ health.length }} 个已配置模型</span>
          </div>
          <div v-if="!health.length" class="empty">暂无数据</div>
          <div v-for="h in health" :key="h.model" class="row">
            <span class="status-dot" :class="h.healthy ? 'ok' : 'bad'" />
            <div class="row-main">
              <div class="row-name">
                {{ h.model }}
                <span v-if="h.role" class="role-tag" :class="`role-${h.role}`">
                  {{ roleLabel(h.role) }}
                </span>
              </div>
              <div class="row-meta">
                {{ h.provider }}
                <template v-if="h.healthy"> · {{ h.latencyMs }} ms</template>
                <template v-else-if="h.errorMessage"> · {{ h.errorMessage }}</template>
              </div>
            </div>
            <span class="tag" :class="h.healthy ? 'tag-ok' : 'tag-bad'">
              {{ h.healthy ? '正常' : '不可用' }}
            </span>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">模型失败率</span>
            <select v-model.number="failureMinutes" class="mini-select" @change="loadFailureRate">
              <option :value="5">近 5 分钟</option>
              <option :value="15">近 15 分钟</option>
              <option :value="60">近 60 分钟</option>
            </select>
          </div>
          <div v-if="!failureRate.length" class="empty">该时间窗内没有调用记录</div>
          <div v-for="f in failureRate" :key="f.model" class="row">
            <div class="row-main">
              <div class="row-name">
                {{ f.model }}
                <span v-if="roleMap[f.model]" class="role-tag" :class="`role-${roleMap[f.model]}`">
                  {{ roleLabel(roleMap[f.model]) }}
                </span>
              </div>
              <div class="row-meta">共 {{ f.total }} 次 · 失败 {{ f.failures }} 次</div>
            </div>
            <span class="rate-value" :class="{ bad: (f.failure_rate_pct ?? 0) > 0 }">
              {{ f.failure_rate_pct ?? 0 }}%
            </span>
          </div>
        </div>
      </section>

      <!-- 审计日志 -->
      <section class="card">
        <div class="card-head">
          <span class="card-title">调用审计日志</span>
          <span class="card-sub">共 {{ logPage.total }} 条</span>
        </div>

        <form class="filters" @submit.prevent="searchLogs">
          <label class="field">
            <span>来源 source</span>
            <input v-model.trim="filters.source" placeholder="如 graph-rag-chain" />
          </label>
          <label class="field">
            <span>模型 model</span>
            <input v-model.trim="filters.model" placeholder="如 deepseek-flash" />
          </label>
          <label class="field">
            <span>状态 status</span>
            <select v-model="filters.status">
              <option value="">全部</option>
              <option value="success">success</option>
              <option value="error">error</option>
              <option value="timeout">timeout</option>
            </select>
          </label>
          <label class="field">
            <span>用户 ID</span>
            <input v-model.trim="filters.userId" placeholder="来自 JWT" />
          </label>
          <label class="field">
            <span>会话 threadId</span>
            <input v-model.trim="filters.threadId" placeholder="命名空间化 thread_id" />
          </label>
          <label class="field">
            <span>链路 traceId</span>
            <input v-model.trim="filters.traceId" placeholder="与 LangSmith 对应" />
          </label>
          <label class="field">
            <span>开始日期</span>
            <input v-model="filters.startDate" type="date" />
          </label>
          <label class="field">
            <span>结束日期</span>
            <input v-model="filters.endDate" type="date" />
          </label>
          <div class="filter-actions">
            <button type="submit" class="primary-btn" :disabled="logsLoading">查询</button>
            <button type="button" class="ghost-btn" @click="resetFilters">重置</button>
          </div>
        </form>

        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>来源</th>
                <th>模型</th>
                <th>状态</th>
                <th class="num">耗时</th>
                <th class="num">输入</th>
                <th class="num">输出</th>
                <th class="num">合计</th>
                <th>用户</th>
                <th>会话</th>
                <th>链路</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="logsLoading && !logPage.logs.length">
                <td :colspan="11" class="table-empty">加载中…</td>
              </tr>
              <tr v-else-if="!logPage.logs.length">
                <td :colspan="11" class="table-empty">没有匹配的调用记录</td>
              </tr>
              <tr v-for="log in logPage.logs" :key="log.id">
                <td class="nowrap">{{ fmtTime(log.createdAt) }}</td>
                <td>{{ log.source }}</td>
                <td class="nowrap">
                  {{ log.model }}
                  <span v-if="log.isFailover" class="tag tag-warn">降级</span>
                </td>
                <td>
                  <span class="tag" :class="statusClass(log.status)">{{ log.status }}</span>
                </td>
                <td class="num">{{ log.latencyMs }} ms</td>
                <td class="num">{{ fmtNum(log.inputTokens) }}</td>
                <td class="num">{{ fmtNum(log.outputTokens) }}</td>
                <td class="num">{{ fmtNum(log.totalTokens) }}</td>
                <td class="nowrap muted" :title="log.userId ?? ''">{{ short(log.userId) }}</td>
                <td class="nowrap muted" :title="log.threadId ?? ''">{{ short(log.threadId) }}</td>
                <td class="nowrap muted mono" :title="log.traceId ?? ''">{{ short(log.traceId) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="pager">
          <span class="pager-info">
            第 {{ logPage.page }} / {{ totalPages }} 页 · 每页
            <select v-model.number="pageSize" class="mini-select" @change="searchLogs">
              <option :value="10">10</option>
              <option :value="20">20</option>
              <option :value="50">50</option>
            </select>
            条
          </span>
          <div class="pager-btns">
            <button
              class="ghost-btn"
              :disabled="logPage.page <= 1 || logsLoading"
              @click="goPage(logPage.page - 1)"
            >上一页</button>
            <button
              class="ghost-btn"
              :disabled="logPage.page >= totalPages || logsLoading"
              @click="goPage(logPage.page + 1)"
            >下一页</button>
          </div>
        </div>
      </section>

      <!-- Token 统计 -->
      <section class="card">
        <div class="card-head">
          <span class="card-title">Token 用量统计</span>
          <select v-model.number="statsDays" class="mini-select" @change="loadTokenStats">
            <option :value="7">近 7 天</option>
            <option :value="14">近 14 天</option>
            <option :value="30">近 30 天</option>
          </select>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>日期</th>
                <th>模型</th>
                <th class="num">调用数</th>
                <th class="num">输入 Token</th>
                <th class="num">输出 Token</th>
                <th class="num">合计 Token</th>
                <th class="num">平均耗时</th>
                <th class="num">错误</th>
                <th class="num">超时</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!stats.length">
                <td :colspan="9" class="table-empty">暂无数据</td>
              </tr>
              <tr v-for="(s, i) in stats" :key="`${s.date}-${s.model}-${i}`">
                <td class="nowrap">{{ s.date }}</td>
                <td>{{ s.model }}</td>
                <td class="num">{{ s.calls }}</td>
                <td class="num">{{ fmtNum(s.input_tokens) }}</td>
                <td class="num">{{ fmtNum(s.output_tokens) }}</td>
                <td class="num">{{ fmtNum(s.total_tokens) }}</td>
                <td class="num">{{ s.avg_latency_ms ?? '-' }} ms</td>
                <td class="num">{{ s.errors }}</td>
                <td class="num">{{ s.timeouts }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { request } from './utils/request.ts';
import type {
  LlmHealthStatus,
  LlmFailureRate,
  LlmAuditLogPage,
  LlmTokenStat,
} from './types.ts';

const error   = ref('');
const loading = ref(false);

const health         = ref<LlmHealthStatus[]>([]);
const failureRate    = ref<LlmFailureRate[]>([]);
const failureMinutes = ref(5);

const stats     = ref<LlmTokenStat[]>([]);
const statsDays = ref(7);

const emptyFilters = () => ({
  source: '', model: '', status: '', userId: '', threadId: '', traceId: '',
  startDate: '', endDate: '',
});
const filters     = ref(emptyFilters());
const pageSize    = ref(20);
const logsLoading = ref(false);
const logPage     = ref<LlmAuditLogPage>({ total: 0, page: 1, pageSize: 20, logs: [] });

const totalPages = computed(() =>
  Math.max(1, Math.ceil(logPage.value.total / pageSize.value)),
);

/** 模型名 → 配置角色（失败率按模型聚合，接口不带 role，用健康检查结果映射） */
const roleMap = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const h of health.value) if (h.role) map[h.model] = h.role;
  return map;
});

/** 角色文案：主模型 / 备用模型 */
const roleLabel = (role?: string) =>
  role === 'primary' ? '主模型' : role === 'fallback' ? '备用模型' : '';

/** 组装审计日志查询串；结束日期补到当天 23:59:59，否则只会查到当天零点之前 */
const buildLogQuery = () => {
  const q = new URLSearchParams();
  const f = filters.value;
  if (f.source)   q.set('source',   f.source);
  if (f.model)    q.set('model',    f.model);
  if (f.status)     q.set('status',     f.status);
  if (f.userId)     q.set('userId',     f.userId);
  if (f.threadId)   q.set('threadId',   f.threadId);
  if (f.traceId)  q.set('traceId',  f.traceId);
  if (f.startDate) q.set('startDate', f.startDate);
  if (f.endDate)   q.set('endDate',  `${f.endDate}T23:59:59.999`);
  q.set('page',     String(logPage.value.page));
  q.set('pageSize', String(pageSize.value));
  return q.toString();
};

const loadHealth = async () => {
  try {
    health.value = await request<LlmHealthStatus[]>('/llm/health');
    error.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '健康检查失败';
  }
};

const loadFailureRate = async () => {
  try {
    failureRate.value = await request<LlmFailureRate[]>(
      `/llm/failure-rate?minutes=${failureMinutes.value}`,
    );
    error.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '失败率查询失败';
  }
};

const loadTokenStats = async () => {
  try {
    stats.value = await request<LlmTokenStat[]>(`/llm/token-stats?days=${statsDays.value}`);
    error.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Token 统计查询失败';
  }
};

const loadLogs = async () => {
  logsLoading.value = true;
  try {
    logPage.value = await request<LlmAuditLogPage>(`/llm/logs?${buildLogQuery()}`);
    error.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : '审计日志查询失败';
  } finally {
    logsLoading.value = false;
  }
};

const searchLogs = () => {
  logPage.value = { ...logPage.value, page: 1 };
  loadLogs();
};

const resetFilters = () => {
  filters.value = emptyFilters();
  logPage.value = { ...logPage.value, page: 1 };
  loadLogs();
};

const goPage = (n: number) => {
  const target = Math.min(Math.max(1, n), totalPages.value);
  if (target === logPage.value.page) return;
  logPage.value = { ...logPage.value, page: target };
  loadLogs();
};

const refreshAll = async () => {
  loading.value = true;
  await Promise.all([loadHealth(), loadFailureRate(), loadLogs(), loadTokenStats()]);
  loading.value = false;
};

// ── 展示格式化 ──
const pad = (n: number) => String(n).padStart(2, '0');

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const fmtNum = (n: number | null | undefined) =>
  n === null || n === undefined ? '-' : String(n);

const short = (v: string | null) => (v ? (v.length > 14 ? `${v.slice(0, 12)}…` : v) : '-');

const statusClass = (s: string) =>
  s === 'success' ? 'tag-ok' : s === 'timeout' ? 'tag-warn' : 'tag-bad';

onMounted(refreshAll);
</script>

<style scoped>
/* ── 本页自带的局部设计变量 ──
   当前项目没有全局 token 体系，所以就地定义一份，保证组件自包含；
   取值对齐现有页面（#f8fafc 底、#e2e8f0 描边、8/12px 圆角、#2563eb 主色）。
   若后续引入全局设计 token，删掉这一段即可自动继承。 */
.llm-page {
  --color-primary:        #2563eb;
  --color-primary-hover:  #1d4ed8;
  --color-primary-soft:   #eff6ff;
  --color-primary-border: #bfdbfe;
  --color-bg:             #f8fafc;
  --color-surface:        #ffffff;
  --color-border:         #e2e8f0;
  --color-border-strong:  #cbd5e1;
  --color-text:           #1e293b;
  --color-text-secondary: #64748b;
  --color-text-muted:     #94a3b8;
  --color-success:        #22c55e;
  --color-danger:         #dc2626;
  --color-danger-soft:    #fef2f2;
  --color-danger-border:  #fecaca;
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --shadow-sm: 0 1px 4px rgba(0, 0, 0, .06);
  --focus-ring: 0 0 0 3px rgba(37, 99, 235, .12);

  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;                 /* 用 100% 而非 100vh，避免超出父级被裁切 */
  max-width: 1280px;            /* 监控台内容较宽，单独放宽上限 */
  margin: 0 auto;
  background: var(--color-bg);
  font-family: -apple-system, 'PingFang SC', sans-serif;
}

.page-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 24px;
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
}
.header-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
.avatar {
  width: 40px; height: 40px; flex-shrink: 0;
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, #0ea5e9, #0369a1);
  color: #fff; font-size: 16px; font-weight: 600;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 1px 2px rgba(3, 105, 161, .3);
}
.header-info h1 { margin: 0; font-size: 15px; font-weight: 600; color: var(--color-text); }
.header-info .subtitle { display: block; margin-top: 3px; font-size: 12px; color: var(--color-text-muted); }

.page-body {
  flex: 1;
  min-height: 0;                       /* 关键：让 flex 子项内部可滚动 */
  overflow-y: auto;
  padding: 24px;
  display: flex; flex-direction: column; gap: 18px;
  background: var(--color-bg);
}

/* ── 卡片 ── */
.card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  padding: 18px 20px;
}
.card-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; margin-bottom: 14px;
}
.card-title { font-size: 14px; font-weight: 600; color: var(--color-text); }
.card-sub   { font-size: 12px; color: var(--color-text-muted); }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }

/* ── 健康 / 失败率 行 ── */
.row {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--color-border);
}
.row:last-child { border-bottom: none; }
.row-main { flex: 1; min-width: 0; }
.row-name { font-size: 13px; font-weight: 600; color: var(--color-text); }
.row-meta { margin-top: 2px; font-size: 12px; color: var(--color-text-muted); word-break: break-all; }

/* 主模型 / 备用模型 备注 */
.role-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  font-size: 11px;
  font-weight: 500;
  vertical-align: 1px;
}
.role-primary {
  background: var(--color-primary-soft);
  color: var(--color-primary);
  border-color: var(--color-primary-border);
}
.role-fallback {
  background: #f1f5f9;
  color: var(--color-text-secondary);
  border-color: var(--color-border);
}

.status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.status-dot.ok  { background: var(--color-success); box-shadow: 0 0 0 3px rgba(22, 163, 74, .12); }
.status-dot.bad { background: var(--color-danger);  box-shadow: 0 0 0 3px rgba(220, 38, 38, .12); }
.rate-value { font-size: 16px; font-weight: 600; color: var(--color-success); }
.rate-value.bad { color: var(--color-danger); }

/* ── 标签 ── */
.tag {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-size: 11px; font-weight: 500;
  border: 1px solid transparent;
}
.tag-ok   { background: #f0fdf4; color: #15803d; border-color: #bbf7d0; }
.tag-bad  { background: var(--color-danger-soft); color: var(--color-danger); border-color: var(--color-danger-border); }
.tag-warn { background: #fffbeb; color: #b45309; border-color: #fde68a; }

/* ── 筛选区 ── */
.filters {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
  padding: 14px;
  margin-bottom: 14px;
  background: #f8f9fb;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.field { display: flex; flex-direction: column; gap: 5px; }
.field > span { font-size: 12px; color: var(--color-text-secondary); }
.field input, .field select {
  height: 34px; padding: 0 10px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: 13px; font-family: inherit;
  outline: none;
  transition: border-color .15s, box-shadow .15s;
}
.field input::placeholder { color: var(--color-text-muted); }
.field input:focus, .field select:focus {
  border-color: var(--color-primary);
  box-shadow: var(--focus-ring);
}
.filter-actions { display: flex; align-items: flex-end; gap: 8px; }

/* ── 按钮 ── */
.primary-btn, .ghost-btn {
  height: 34px; padding: 0 16px;
  border-radius: var(--radius-md);
  font-size: 13px; font-weight: 500; font-family: inherit;
  cursor: pointer;
  transition: background .15s, border-color .15s, color .15s;
}
.primary-btn { border: none; background: var(--color-primary); color: #fff; }
.primary-btn:hover:not(:disabled) { background: var(--color-primary-hover); }
.primary-btn:disabled { background: #e3e8ef; color: #9aa4b2; cursor: not-allowed; }
.ghost-btn {
  border: 1px solid var(--color-border-strong);
  background: var(--color-surface);
  color: var(--color-text-secondary);
}
.ghost-btn:hover:not(:disabled) { background: #f4f6f9; border-color: var(--color-text-muted); color: var(--color-text); }
.ghost-btn:disabled { color: #b8c0cc; cursor: not-allowed; }

.mini-select {
  height: 28px; padding: 0 8px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: 12px; font-family: inherit;
  outline: none;
}

/* ── 表格 ── */
.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.data-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.data-table th {
  padding: 9px 12px;
  text-align: left;
  font-size: 12px; font-weight: 600; color: var(--color-text-secondary);
  background: #f8f9fb;
  border-bottom: 1px solid var(--color-border);
  white-space: nowrap;
}
.data-table td {
  padding: 9px 12px;
  color: var(--color-text);
  border-bottom: 1px solid var(--color-border);
}
.data-table tbody tr:last-child td { border-bottom: none; }
.data-table tbody tr:hover { background: #fafbfc; }
.data-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.data-table .nowrap { white-space: nowrap; }
.data-table .muted { color: var(--color-text-muted); }
.data-table .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.table-empty { padding: 28px 12px; text-align: center; color: var(--color-text-muted); }

/* ── 分页 ── */
.pager {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; margin-top: 14px; flex-wrap: wrap;
}
.pager-info { font-size: 12px; color: var(--color-text-secondary); }
.pager-btns { display: flex; gap: 8px; }

.empty { padding: 20px 0; text-align: center; font-size: 13px; color: var(--color-text-muted); }

.error-tip {
  padding: 10px 14px;
  background: var(--color-danger-soft);
  border: 1px solid var(--color-danger-border);
  border-radius: var(--radius-md);
  color: var(--color-danger); font-size: 13px;
}

@media (max-width: 900px) {
  .grid-2 { grid-template-columns: 1fr; }
  .llm-page { border-left: none; border-right: none; }
  .page-header, .page-body { padding-left: 16px; padding-right: 16px; }
}
</style>
