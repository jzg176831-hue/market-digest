/**
 * 配置模板 — 复制本文件为 config.js，填入实际值后运行。
 *   cp config.example.js config.js
 *
 * ─────────────────────────────────────────────────────
 * 哪些是必填的？
 *
 * 【DB】必填：在 DB_CONFIG 里填入数据库连接信息。
 *
 * 【LLM 主模型】可选：
 *   启动时会自动尝试从已知 AI 框架的配置文件中读取当前默认模型
 *   的 baseUrl / apiKey / model，若能读到则无需在这里填写。
 *   读不到，或想使用与框架默认不同的模型时，才填 MODEL_CONFIG。
 *
 * 【Embedding】可选：填写 OPENAI_EMBEDDING_CONFIG 中的 api_key、base_url、model（三者与服务商一致；api_key 留空则跳过向量去重，效果略弱但仍可运行）。
 * ─────────────────────────────────────────────────────
 */

// PostgreSQL 数据库连接
const DB_CONFIG = {
  host:     'YOUR_DB_HOST',      // 数据库主机，如 192.168.1.100
  port:     5432,
  database: 'YOUR_DATABASE',    // 数据库名
  user:     'YOUR_DB_USER',
  password: 'YOUR_DB_PASSWORD',
};

// LLM 主模型配置
// 优先级：这里 → 框架配置文件中检测到的默认模型（兜底）
// 填了就用这里的；留空时自动用框架当前配置的模型
const MODEL_CONFIG = {
  model:       'deepseek-v3-1-250821',
  api_key:     'YOUR_LLM_API_KEY',
  base_url:    'https://ark.cn-beijing.volces.com/api/v3',
  temperature: 0.3,
};

/** 详情页 body 瘦身选择器 */
const DETAIL_STRIP_SELECTORS = [
  'nav', '.nav', '.navigation', '#nav', 'header nav', '.header-nav', '.main-nav',
  'footer', '.footer', '#footer', '.site-footer', '.page-footer',
  '.sidebar', '.side-bar', '#sidebar', '.aside', '#aside', '.l-sidebar', '.r-sidebar',
  '.ad', '.ads', '#ad', '.advertisement', '.ad-container', '[id*="ad-"]', '[class*="ad-"]', '.ad-box', '.recommend', '.hot-news', '.pop-news',
  '.social-share', '.share-bar', '.comment-area', '.comments',
];

/** 抓取源配置（默认覆盖财新、东方财富、新浪等，可按需增删） */
const SOURCES = [
  { site: 'caixin',     name: 'caixin_finance',          url: 'https://finance.caixin.com/',      baseUrl: 'https://finance.caixin.com',    listFilterType: 'time_window' },
  { site: 'caixin',     name: 'caixin_economy',          url: 'https://economy.caixin.com/',      baseUrl: 'https://economy.caixin.com',    listFilterType: 'time_window' },
  { site: 'cnfin',      name: 'cnfin_finance_early',     url: 'https://search.cnfin.com/synthesis?q=%E8%B4%A2%E7%BB%8F%E6%97%A9%E6%8A%A5', baseUrl: 'https://www.cnfin.com', listFilterType: 'daily_report', listOptions: { waitUntil: 'load', timeout: 45000, afterLoadWaitMs: 3000 } },
  { site: 'eastmoney',  name: 'eastmoney_finance_digest', url: 'https://finance.eastmoney.com/a/ccjdd.html', baseUrl: 'https://finance.eastmoney.com', listFilterType: 'time_window', listOptions: { waitUntil: 'load', timeout: 45000, afterLoadWaitMs: 3000, pagination: true, maxListPages: 30, listPageUrlTemplate: 'https://finance.eastmoney.com/a/ccjdd_{{page}}.html' }, preferDetailSummary: true },
  { site: 'sina',       name: 'sina_finance_roll',       url: 'https://finance.sina.com.cn/roll', baseUrl: 'https://finance.sina.com.cn',   listFilterType: 'time_window', listOptions: { waitUntil: 'load', timeout: 45000, afterLoadWaitMs: 3000, pagination: true, maxListPages: 30, nextPageSelector: 'a[onclick*="newsList.page.next()"]' } },
];

// OpenAI Embedding（可选，用于文章向量化和相似度去重，走 OpenAI 兼容接口）
// 留空则跳过 Embedding 去重（去重效果会减弱，但仍可正常运行）
const OPENAI_EMBEDDING_CONFIG = {
  api_key:  '',   // 如 'sk-...'
  model:    'YOUR_EMBEDDING_MODEL', // 按服务商填写，须与 base_url 对应（如 OpenAI: text-embedding-3-small；其它云用其文档中的模型 ID）
  base_url: '',   // 如 'https://api.openai.com/v1'
};

// Embedding 相似度去重阈值（余弦相似度，0～1）
const EMBEDDING_DEDUP_THRESHOLD = 0.92;

module.exports = {
  DB_CONFIG,
  MODEL_CONFIG,
  SOURCES,
  DETAIL_STRIP_SELECTORS,
  OPENAI_EMBEDDING_CONFIG,
  EMBEDDING_DEDUP_THRESHOLD,
};
