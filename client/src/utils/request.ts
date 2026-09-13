/**
 * 统一请求封装
 * - 自动携带 Authorization Token
 * - 统一错误处理（401 触发未登录事件）
 * - 提供普通请求和 SSE 流式请求两种方式
 * - 开发环境：用写死的开发 token 模拟登录态（假装从用户中心获取）
 */

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000/api';
const IS_DEV = import.meta.env.DEV;

/** Token 在 localStorage 中的 key（与登录模块保持一致） */
const TOKEN_KEY = 'ecom_token';

/**
 * 开发用的固定 token（用后端 JWT_SECRET 签发，有效期 365 天）
 * 模拟"从用户中心获取到的 token"，接入真实登录后删掉即可
 */
const DEV_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJVLWRldi0wMDAxIiwidXNlcm5hbWUiOiLlvIDlj5HnlKjmiLciLCJpYXQiOjE3ODg4ODM4NTEsImV4cCI6MTgyMDQxOTg1MX0.ZAzEb2Td_9mFAGD5wLgP3ivt98zyQ9ccNXdwgrwcsMU';

export const getToken = (): string => localStorage.getItem(TOKEN_KEY) || '';
export const setToken = (token: string) => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

/**
 * 开发环境初始化：写入开发用 token，假装是从用户中心拿到的
 * 每次都覆盖：避免本地残留的旧 token（字段/签名与当前后端不一致）导致接口 401
 * 接入真实登录后删除这段逻辑
 */
if (IS_DEV) {
  setToken(DEV_TOKEN);
  console.warn('[request] 开发环境：使用默认开发 token');
}

/**
 * 构建统一请求头（自动注入 token）
 */
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

/**
 * 统一响应处理
 * - 401：清除 token，触发未登录事件
 * - 其他错误：抛出异常
 */
const handleResponse = (response: Response): Response => {
  if (response.status === 401) {
    clearToken();
    // 触发自定义事件，让应用层处理登录跳转（避免直接依赖 router）
    window.dispatchEvent(new CustomEvent('auth:unauthorized'));
    throw new Error('登录已过期，请重新登录');
  }
  return response;
};

/**
 * 普通 JSON 请求（返回 JSON 数据）
 */
export const request = async <T = unknown>(
  url: string,
  options: RequestInit = {},
): Promise<T> => {
  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: buildHeaders(options.headers as Record<string, string>),
  });

  handleResponse(response);

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || data.message || '请求失败');
  }
  return data as T;
};

/**
 * SSE 流式请求（返回原始 Response，调用方自行读取流）
 * 适用于流式对话、流式生成等场景
 */
export const streamRequest = async (
  url: string,
  body: Record<string, unknown>,
  options: RequestInit = {},
): Promise<Response> => {
  const response = await fetch(`${API_BASE}${url}`, {
    method: 'POST',
    ...options,
    headers: buildHeaders(options.headers as Record<string, string>),
    body: JSON.stringify(body),
  });

  handleResponse(response);

  if (!response.ok) {
    throw new Error(`请求失败：HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error('响应没有内容');
  }
  return response;
};
