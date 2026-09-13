// monitor/src/utils/request.ts
// LLM 监控台的请求封装（只保留普通 JSON 请求；监控台不走 SSE）
// 从主前端 client/src/utils/request.ts 抽出来的，去掉流式请求部分

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000/api';
const IS_DEV = import.meta.env.DEV;

/** Token 在 localStorage 中的 key（与登录模块保持一致） */
const TOKEN_KEY = 'ecom_token';

/**
 * 开发用的固定 token（用后端 JWT_SECRET 签发，有效期 365 天）
 * 监控台当前复用客服前台同一套开发态 token 方案，接入真实登录后统一替换
 */
const DEV_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJVLWRldi0wMDAxIiwidXNlcm5hbWUiOiLlvIDlj5HnlKjmiLciLCJpYXQiOjE3ODg4ODM4NTEsImV4cCI6MTgyMDQxOTg1MX0.ZAzEb2Td_9mFAGD5wLgP3ivt98zyQ9ccNXdwgrwcsMU';

export const getToken = (): string => localStorage.getItem(TOKEN_KEY) || '';
export const setToken = (token: string) => localStorage.setItem(TOKEN_KEY, token);

/** 开发环境初始化：每次都覆盖，避免本地残留的旧 token 导致 401 */
if (IS_DEV) {
  setToken(DEV_TOKEN);
}

/** 构建请求头（自动注入 token） */
const buildHeaders = (customHeaders: Record<string, string> = {}): Record<string, string> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...customHeaders,
  };
  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
};

/** 普通 JSON 请求；401 时清掉 token 并抛出可读错误 */
export const request = async <T = unknown>(
  url: string,
  options: RequestInit = {},
): Promise<T> => {
  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: buildHeaders(options.headers as Record<string, string>),
  });

  if (response.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    throw new Error('登录已过期，请重新登录');
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || data.message || '请求失败');
  }
  return data as T;
};
