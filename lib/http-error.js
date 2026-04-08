'use strict';

/**
 * 将 axios / 网络错误整理成可读的短句（含 HTTP 状态、Retry-After、响应体摘要），便于日志排查。
 * @param {unknown} e
 * @returns {string}
 */
function describeRequestError(e) {
  if (e == null) return String(e);
  if (typeof e === 'object' && e !== null && 'response' in e && e.response) {
    const { status, statusText, headers, data } = e.response;
    const parts = [`HTTP ${status}${statusText ? ` ${statusText}` : ''}`];
    const ra = headers?.['retry-after'] ?? headers?.['Retry-After'];
    if (ra != null && ra !== '') parts.push(`Retry-After: ${ra}`);
    let bodyHint = '';
    if (data != null) {
      if (typeof data === 'object' && data.error) {
        const em = data.error.message || data.error.code || data.error.type;
        if (em) bodyHint = String(em).slice(0, 500);
      }
      if (!bodyHint) {
        try {
          const s = typeof data === 'string' ? data : JSON.stringify(data);
          bodyHint = s.length > 500 ? `${s.slice(0, 500)}…` : s;
        } catch (_) {
          bodyHint = String(data).slice(0, 500);
        }
      }
    }
    if (bodyHint) parts.push(`响应: ${bodyHint}`);
    const cfg = e.config;
    if (cfg) {
      const path = [cfg.baseURL, cfg.url].filter(Boolean).join('').replace(/\/+$/, '');
      if (path) parts.push(`POST …${path.slice(-80)}`);
    }
    return parts.join(' | ');
  }
  if (typeof e === 'object' && e !== null && e.code === 'ECONNABORTED')
    return `请求超时 (${e.message || 'ECONNABORTED'})`;
  if (typeof e === 'object' && e !== null && e.request && !e.response)
    return `无 HTTP 响应 (${e.code || e.message || 'network'})`;
  if (e instanceof Error) return e.message;
  return String(e);
}

module.exports = { describeRequestError };
