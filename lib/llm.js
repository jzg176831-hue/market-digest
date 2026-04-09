'use strict';
/**
 * 共享 LLM 工具：
 *  - callLLM(messages, opts)   调用 chat completions
 *  - withRetry(fn, opts)       通用重试包装
 *  - extractJson(text)         从 LLM 返回文本中提取第一个 JSON 对象或数组
 */

const axios = require('axios');
const { MODEL_CONFIG } = require('../config');
const { describeRequestError } = require('./http-error');

/**
 * 调用 LLM chat completions。取值来自 config.js MODEL_CONFIG，未配置则报错。
 * @param {Array<{role:string, content:string}>} messages
 * @param {{ timeoutMs?: number, baseUrl?: string, model?: string, apiKey?: string, temperature?: number }} [opts]
 * @returns {Promise<string>} 模型返回的 content 字符串
 */
async function callLLM(messages, opts = {}) {
  const baseUrl = opts.baseUrl || MODEL_CONFIG.base_url;
  const model   = opts.model   || MODEL_CONFIG.model;
  const apiKey  = opts.apiKey  || MODEL_CONFIG.api_key;
  const temperature = opts.temperature ?? MODEL_CONFIG.temperature ?? 0.3;
  const timeoutMs   = opts.timeoutMs ?? 60000;

  if (!apiKey) throw new Error('LLM API key 未配置');

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  try {
    const res = await axios.post(
      url,
      { model, messages, temperature },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: timeoutMs,
      }
    );
    return res.data?.choices?.[0]?.message?.content || '';
  } catch (e) {
    const err = new Error(`LLM 请求失败: ${describeRequestError(e)}`);
    err.cause = e;
    throw err;
  }
}

/**
 * 通用重试包装器：fn 抛错则按 delayMs 间隔重试，最多 maxRetries 次。
 * @param {(attempt: number) => Promise<any>} fn
 * @param {{ maxRetries?: number, delayMs?: number, label?: string, log?: function }} [opts]
 */
async function withRetry(fn, opts = {}) {
  const { maxRetries = 2, delayMs = 3000, label = '', log = () => {} } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (label) {
        const msg = e?.message || describeRequestError(e);
        if (attempt < maxRetries) {
          log(`  [${label}] 第${attempt}次失败，${delayMs / 1000}s 后重试 ${attempt + 1}/${maxRetries}...\n    原因: ${msg}`);
        } else {
          log(`  [${label}] 第${attempt}次失败\n    原因: ${msg}`);
        }
      }
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/**
 * 从 LLM 返回文本中提取第一个合法的 JSON 对象或数组。
 * 自动剥离 markdown 代码块。
 * @param {string} text
 * @returns {object|Array}  解析后的值
 * @throws {Error} 无法提取时抛出
 */
function extractJson(text) {
  let s = (text || '').trim();
  // 剥离 markdown 代码块
  for (const fence of ['```json', '```']) {
    if (s.startsWith(fence)) s = s.slice(fence.length).trimStart();
    if (s.endsWith('```'))   s = s.slice(0, -3).trimEnd();
  }
  // 尝试 {}
  const oi = s.indexOf('{');
  const oj = s.lastIndexOf('}');
  if (oi !== -1 && oj > oi) {
    try { return JSON.parse(s.slice(oi, oj + 1)); } catch (_) {}
  }
  // 尝试 []
  const ai = s.indexOf('[');
  const aj = s.lastIndexOf(']');
  if (ai !== -1 && aj > ai) {
    try { return JSON.parse(s.slice(ai, aj + 1)); } catch (_) {}
  }
  throw new Error(`无法从 LLM 返回中提取 JSON: ${s.slice(0, 120)}`);
}

module.exports = { callLLM, withRetry, extractJson };
