'use strict';
/**
 * 共享 Embedding 工具：调用 OpenAI-compatible embeddings 接口。
 */

const axios = require('axios');
const { OPENAI_EMBEDDING_CONFIG } = require('../config');
const { describeRequestError } = require('./http-error');

/**
 * 将文本转换为 embedding 向量。
 * @param {string} text
 * @param {(msg: string) => void} [log]
 * @returns {Promise<number[]|null>}  成功返回向量，失败返回 null
 */
async function text2Embedding(text, log = () => {}) {
  const cfg    = OPENAI_EMBEDDING_CONFIG || {};
  const apiKey = cfg.api_key || '';
  if (!apiKey.trim()) return null;

  const baseUrl = cfg.base_url || 'https://api.openai.com/v1';
  const model   = cfg.model   || 'text-embedding-ada-002';

  try {
    const { data } = await axios.post(
      `${baseUrl.replace(/\/$/, '')}/embeddings`,
      { model, input: (text || '').trim().slice(0, 8000) },
      {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        timeout: 15000,
      }
    );
    const emb = data?.data?.[0]?.embedding;
    return Array.isArray(emb) ? emb : null;
  } catch (e) {
    const detail = describeRequestError(e);
    const line = detail.length > 800 ? `${detail.slice(0, 800)}…` : detail;
    log(`[Embedding] 请求失败: ${line}`);
    return null;
  }
}

module.exports = { text2Embedding };
