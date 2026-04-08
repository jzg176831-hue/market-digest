'use strict';
/**
 * setup.js — 安装配置脚本（由 Agent 调用，也可手动执行）
 *
 * 功能：
 *   1. 解析 CLI 参数中的数据库连接信息（和可选的 Embedding 配置）
 *   2. 测试数据库连接
 *   3. 建表（幂等，可重复执行）并插入 __global__ 行
 *   4. 将配置写入 config.js
 *
 * 用法：
 *   node setup.js \
 *     --db-host 192.168.1.100 \
 *     --db-port 5432 \
 *     --db-name mydb \
 *     --db-user postgres \
 *     --db-pass secret \
 *     [--embedding-key sk-xxx] \
 *     [--embedding-url https://api.openai.com/v1] \
 *     [--embedding-model text-embedding-ada-002]
 *
 * 退出码：
 *   0 = 成功
 *   1 = 失败（打印错误原因）
 */

const { Pool } = require('pg');
const fs        = require('fs');
const path      = require('path');

// ── 解析 CLI 参数 ──────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[key] = val;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const dbHost  = args['db-host']  || '';
const dbPort  = parseInt(args['db-port'] || '5432', 10);
const dbName  = args['db-name']  || '';
const dbUser  = args['db-user']  || '';
const dbPass  = args['db-pass']  || '';

const embKey   = args['embedding-key']   || '';
const embUrl   = args['embedding-url']   || '';
const embModel = args['embedding-model'] || 'text-embedding-ada-002';

if (!dbHost || !dbName || !dbUser) {
  console.error('缺少必填参数：--db-host / --db-name / --db-user');
  console.error('用法：node setup.js --db-host HOST --db-name DB --db-user USER --db-pass PASS');
  process.exit(1);
}

// ── 建表 SQL（幂等） ──────────────────────────────────────
const SETUP_SQL = `
CREATE TABLE IF NOT EXISTS finance_articles (
  id            SERIAL PRIMARY KEY,
  url           TEXT NOT NULL UNIQUE,
  title         TEXT,
  publish_at    TIMESTAMPTZ NULL,
  author        TEXT,
  summary       TEXT,
  content       TEXT,
  content_brief TEXT,
  site          TEXT NOT NULL DEFAULT 'unknown',
  embedding     TEXT NULL,
  cluster_rank  INT  NULL,
  deleted_at    TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_articles_url_unique
  ON finance_articles (url);

CREATE INDEX IF NOT EXISTS idx_finance_articles_publish_at
  ON finance_articles (publish_at)
  WHERE publish_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_finance_articles_deleted_at
  ON finance_articles (deleted_at)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS finance_clusters (
  id                    SERIAL PRIMARY KEY,
  report_date           DATE NOT NULL,
  cluster_rank          INT  NOT NULL,
  summary               TEXT,
  china_summary         TEXT,
  international_summary TEXT,
  score                 NUMERIC NULL,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (report_date, cluster_rank)
);

CREATE INDEX IF NOT EXISTS idx_finance_clusters_report_date
  ON finance_clusters (report_date);

CREATE TABLE IF NOT EXISTS finance_crawl_schedule (
  id            SERIAL PRIMARY KEY,
  source        TEXT NOT NULL UNIQUE DEFAULT '__global__',
  status        TEXT NOT NULL DEFAULT 'idle',
  last_crawl_at TIMESTAMPTZ NULL,
  started_at    TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO finance_crawl_schedule (source, status)
VALUES ('__global__', 'idle')
ON CONFLICT (source) DO NOTHING;
`;

// ── 生成 config.js 内容 ────────────────────────────────────
function buildConfigJs(dbCfg, embCfg) {
  const embKeyVal   = embCfg.key   ? `'${embCfg.key}'`   : "''";
  const embUrlVal   = embCfg.url   ? `'${embCfg.url}'`   : "''";
  const embModelVal = embCfg.model ? `'${embCfg.model}'` : "'text-embedding-ada-002'";

  return `// PostgreSQL：抓取到的文章按批写入（每 10 篇一批）
const DB_CONFIG = {
  host: '${dbCfg.host}',
  port: ${dbCfg.port},
  database: '${dbCfg.database}',
  user: '${dbCfg.user}',
  password: '${dbCfg.password}'
};

// LLM 主模型配置
// 优先使用这里的值；留空时自动读取 ~/.openclaw/openclaw.json 的默认模型。
const MODEL_CONFIG = {
  model: '',
  api_key: '',
  base_url: '',
  temperature: 0.3
};

/** 详情页 body 瘦身：所有站点共用的无用结构选择器，依次 remove 以减小送 LLM 的 HTML 体积 */
const DETAIL_STRIP_SELECTORS = [
  'nav', '.nav', '.navigation', '#nav', 'header nav', '.header-nav', '.main-nav',
  'footer', '.footer', '#footer', '.site-footer', '.page-footer',
  '.sidebar', '.side-bar', '#sidebar', '.aside', '#aside', '.l-sidebar', '.r-sidebar',
  '.ad', '.ads', '#ad', '.advertisement', '.ad-container', '[id*="ad-"]', '[class*="ad-"]', '.ad-box', '.recommend', '.hot-news', '.pop-news',
  '.social-share', '.share-bar', '.comment-area', '.comments'
];

/**
 * 抓取源配置
 * - listFilterType: 'time_window'（默认）或 'daily_report'
 * - listOptions.pagination: 翻页配置（listPageUrlTemplate 或 nextPageSelector）
 * - preferDetailSummary: 优先用详情页摘要
 */
const SOURCES = [
  { site: 'caixin', name: 'caixin_finance', url: 'https://finance.caixin.com/', baseUrl: 'https://finance.caixin.com', listFilterType: 'time_window' },
  { site: 'caixin', name: 'caixin_economy', url: 'https://economy.caixin.com/', baseUrl: 'https://economy.caixin.com', listFilterType: 'time_window' },
  {
    site: 'cnfin',
    name: 'cnfin_finance_early',
    url: 'https://search.cnfin.com/synthesis?q=%E8%B4%A2%E7%BB%8F%E6%97%A9%E6%8A%A5',
    baseUrl: 'https://www.cnfin.com',
    listFilterType: 'daily_report',
    listOptions: { waitUntil: 'load', timeout: 45000, afterLoadWaitMs: 3000 }
  },
  {
    site: 'eastmoney',
    name: 'eastmoney_finance_digest',
    url: 'https://finance.eastmoney.com/a/ccjdd.html',
    baseUrl: 'https://finance.eastmoney.com',
    listFilterType: 'time_window',
    listOptions: {
      waitUntil: 'load',
      timeout: 45000,
      afterLoadWaitMs: 3000,
      pagination: true,
      maxListPages: 30,
      listPageUrlTemplate: 'https://finance.eastmoney.com/a/ccjdd_{{page}}.html'
    },
    preferDetailSummary: true
  },
  {
    site: 'sina',
    name: 'sina_finance_roll',
    url: 'https://finance.sina.com.cn/roll',
    baseUrl: 'https://finance.sina.com.cn',
    listFilterType: 'time_window',
    listOptions: {
      waitUntil: 'load',
      timeout: 45000,
      afterLoadWaitMs: 3000,
      pagination: true,
      maxListPages: 30,
      nextPageSelector: 'a[onclick*="newsList.page.next()"]'
    }
  }
];

// OpenAI Embedding 配置
// 留空则跳过 Embedding 去重（去重效果会减弱，但仍可正常运行）
const OPENAI_EMBEDDING_CONFIG = {
  api_key: ${embKeyVal},
  base_url: ${embUrlVal},
  model: ${embModelVal},
};

// Embedding 相似度阈值（余弦相似度）
const EMBEDDING_DEDUP_THRESHOLD = 0.92;

module.exports = {
  DB_CONFIG,
  MODEL_CONFIG,
  SOURCES,
  DETAIL_STRIP_SELECTORS,
  OPENAI_EMBEDDING_CONFIG,
  EMBEDDING_DEDUP_THRESHOLD,
};
`;
}

// ── 主流程 ────────────────────────────────────────────────
async function main() {
  const dbCfg = { host: dbHost, port: dbPort, database: dbName, user: dbUser, password: dbPass };
  const pool  = new Pool({ ...dbCfg, connectionTimeoutMillis: 10000 });

  // 1. 测试连接
  console.log(`正在连接数据库 ${dbUser}@${dbHost}:${dbPort}/${dbName} ...`);
  try {
    await pool.query('SELECT 1');
    console.log('✓ 数据库连接成功');
  } catch (e) {
    console.error(`✗ 数据库连接失败：${e.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  }

  // 2. 建表
  console.log('正在建表（幂等，已存在则跳过）...');
  try {
    await pool.query(SETUP_SQL);
    console.log('✓ 数据库表初始化完成');
  } catch (e) {
    console.error(`✗ 建表失败：${e.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  }

  await pool.end().catch(() => {});

  // 3. 写 config.js
  const embCfg = { key: embKey, url: embUrl, model: embModel };
  const configContent = buildConfigJs(dbCfg, embCfg);
  const configPath = path.join(__dirname, 'config.js');
  fs.writeFileSync(configPath, configContent, 'utf8');
  console.log(`✓ config.js 已写入：${configPath}`);

  console.log('');
  console.log('✓ 配置完成！');
  if (!embKey) {
    console.log('  提示：未配置 Embedding API Key，去重将使用标题相似度模式（效果略弱）。');
    console.log('  如需启用 Embedding 去重，稍后可重新运行：');
    console.log('    node setup.js --db-host ... --embedding-key YOUR_KEY --embedding-url https://... --embedding-model YOUR_MODEL');
  }
}

main().catch(e => {
  console.error(`✗ 安装失败：${e.message}`);
  process.exit(1);
});
