'use strict';
/**
 * setup.js — 安装配置脚本（由 Agent 调用，也可手动执行）
 *
 * 功能：
 *   1. 解析 CLI 参数中的数据库连接信息
 *   2. 测试数据库连接
 *   3. 将配置写入 config.js
 *   4. 测试 LLM 连接
 *
 * 用法：
 *   node setup.js \
 *     --db-host 192.168.1.100 \
 *     --db-port 5432 \
 *     --db-name mydb \
 *     --db-user postgres \
 *     --db-pass secret
 *
 * 退出码：
 *   0 = 成功
 *   1 = 失败（打印错误原因）
 */

const { Pool }      = require('pg');
const axios         = require('axios');
const { execSync }  = require('child_process');
const fs            = require('fs');
const path          = require('path');
const os            = require('os');

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

// LLM 模型配置（可选，留空则自动检测框架配置或由用户事后手动填写 config.js）
const cliModel      = args['model']       || '';
const cliApiKey     = args['api-key']     || '';
const cliBaseUrl    = args['base-url']    || '';
// Chrome/Chromium 路径（可选，留空则自动检测）
const cliChromePath = args['chrome-path'] || '';

if (!dbHost || !dbName || !dbUser) {
  console.error('缺少必填参数：--db-host / --db-name / --db-user');
  console.error('用法：node setup.js --db-host HOST --db-name DB --db-user USER --db-pass PASS');
  console.error('可选：--model MODEL --api-key KEY --base-url URL --chrome-path PATH');
  process.exit(1);
}

// ── 检测框架模型配置 ────────────────────────────────────────
function detectFrameworkModel() {
  // OpenClaw
  try {
    const cfgPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const primary = cfg?.agents?.defaults?.model?.primary;
    if (primary) {
      const slashIdx = primary.indexOf('/');
      if (slashIdx !== -1) {
        const providerName = primary.slice(0, slashIdx);
        const modelId      = primary.slice(slashIdx + 1);
        const provider = cfg?.models?.providers?.[providerName];
        if (provider?.apiKey && provider?.baseUrl) {
          return { model: modelId, apiKey: provider.apiKey, baseUrl: provider.baseUrl, source: 'OpenClaw' };
        }
      }
    }
  } catch (_) {}

  // 可在此添加其他框架的检测逻辑

  return null;
}

// ── 检测 Chrome/Chromium 可执行文件 ───────────────────────────
/**
 * 依次尝试：
 *   1. 常见系统安装路径（直接 fs.existsSync）
 *   2. which 命令查找 PATH 中的可执行文件
 * 返回找到的第一个可用路径，否则返回 null。
 */
function detectChrome() {
  const knownPaths = [
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/local/bin/chromium',
    '/snap/bin/chromium',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ];

  for (const p of knownPaths) {
    if (fs.existsSync(p)) return p;
  }

  // 通过 which 查 PATH
  for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      const p = execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf8', stdio: 'pipe' }).trim();
      if (p && fs.existsSync(p)) return p;
    } catch (_) {}
  }

  return null;
}

// ── 生成 config.js 内容 ────────────────────────────────────
function buildConfigJs(dbCfg, modelCfg, chromePath) {
  const m = modelCfg || {};
  // 路径中可能含单引号（极少见），用 JSON.stringify 安全转义后去掉外层双引号
  const chromePathSafe = (chromePath || '').replace(/'/g, "\\'");
  return `// PostgreSQL：抓取到的文章按批写入（每 10 篇一批）
const DB_CONFIG = {
  host: '${dbCfg.host}',
  port: ${dbCfg.port},
  database: '${dbCfg.database}',
  user: '${dbCfg.user}',
  password: '${dbCfg.password}'
};

// LLM 主模型配置（必填，留空运行时报错）
const MODEL_CONFIG = {
  model: '${m.model || ''}',
  api_key: '${m.apiKey || ''}',
  base_url: '${m.baseUrl || ''}',
  temperature: 0.3
};

// Chrome/Chromium 可执行文件路径（安装时自动检测写入）
// 留空时运行时会按内置候选路径列表依次尝试；如需指定其他路径可在此修改。
const CHROME_EXECUTABLE = '${chromePathSafe}';

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

// OpenAI Embedding 配置（可选；如不需要可保持留空）
// 留空则跳过 Embedding 去重（去重效果会减弱，但仍可正常运行）
const OPENAI_EMBEDDING_CONFIG = {
  api_key: '',
  base_url: '',
  model: '',
};

// Embedding 相似度阈值（余弦相似度）
const EMBEDDING_DEDUP_THRESHOLD = 0.92;

module.exports = {
  DB_CONFIG,
  MODEL_CONFIG,
  CHROME_EXECUTABLE,
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

  await pool.end().catch(() => {});

  // 2. 确定模型配置
  let modelCfg = null;
  if (cliModel && cliApiKey && cliBaseUrl) {
    // 明确传入了模型参数，直接使用
    modelCfg = { model: cliModel, apiKey: cliApiKey, baseUrl: cliBaseUrl };
    console.log(`✓ 使用指定模型：${modelCfg.model}`);
  } else {
    // 尝试从框架配置中自动检测
    const detected = detectFrameworkModel();
    if (detected) {
      console.log(`[DETECTED_MODEL] source=${detected.source} model=${detected.model} base_url=${detected.baseUrl}`);
      // 如果有部分 CLI 参数则覆盖对应字段
      modelCfg = {
        model:   cliModel   || detected.model,
        apiKey:  cliApiKey  || detected.apiKey,
        baseUrl: cliBaseUrl || detected.baseUrl,
      };
    } else {
      console.log('[DETECTED_MODEL] none');
    }
  }

  // 3. 检测 Chrome/Chromium
  let chromePath = '';
  if (cliChromePath) {
    if (fs.existsSync(cliChromePath)) {
      chromePath = cliChromePath;
      console.log(`✓ 使用指定浏览器：${chromePath}`);
    } else {
      console.warn(`⚠ 指定的 --chrome-path 不存在：${cliChromePath}，已忽略`);
    }
  } else {
    const detected = detectChrome();
    if (detected) {
      chromePath = detected;
      console.log(`[DETECTED_CHROME] path=${detected}`);
    } else {
      console.log('[DETECTED_CHROME] none');
    }
  }

  // 4. 写 config.js
  const configContent = buildConfigJs(dbCfg, modelCfg, chromePath);
  const configPath = path.join(__dirname, 'config.js');
  fs.writeFileSync(configPath, configContent, 'utf8');
  console.log(`✓ config.js 已写入：${configPath}`);

  // 5. 测试 LLM 连接（若有模型配置）
  if (modelCfg && modelCfg.apiKey && modelCfg.baseUrl) {
    console.log(`正在测试 LLM 连接（${modelCfg.model}）...`);
    try {
      const url = `${modelCfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
      await axios.post(
        url,
        { model: modelCfg.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
        { headers: { Authorization: `Bearer ${modelCfg.apiKey}`, 'Content-Type': 'application/json' }, timeout: 15000 }
      );
      console.log('[LLM_TEST] ok');
    } catch (e) {
      const status = e?.response?.status;
      const body   = JSON.stringify(e?.response?.data || '').slice(0, 200);
      console.log(`[LLM_TEST] fail status=${status || 'network'} body=${body}`);
    }
  } else {
    console.log('[LLM_TEST] skip（无模型配置）');
  }

  console.log('');
  console.log('✓ 配置完成！');
}

main().catch(e => {
  console.error(`✗ 安装失败：${e.message}`);
  process.exit(1);
});
