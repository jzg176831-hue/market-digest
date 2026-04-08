'use strict';
/**
 * finance_articles 表操作。使用 db/pool.js 的共享连接池。
 */

const { isConfigured, getPool } = require('./pool');

const TABLE = 'finance_articles';

// ---------- 表初始化 ----------

let _tableEnsured = false;

async function ensureTable() {
  if (_tableEnsured) return;
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id            SERIAL PRIMARY KEY,
      url           TEXT NOT NULL UNIQUE,
      title         TEXT,
      publish_at    TIMESTAMPTZ NULL,
      author        TEXT,
      summary       TEXT,
      content       TEXT,
      content_brief TEXT,
      site          TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW(),
      deleted_at    TIMESTAMPTZ NULL,
      cluster_rank  INT NULL,
      embedding     TEXT NULL
    )
  `);
  await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS publish_at TIMESTAMPTZ NULL`).catch(() => {});
  await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS embedding TEXT NULL`).catch(() => {});
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_articles_url_unique ON ${TABLE} (url)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_finance_articles_publish_at ON ${TABLE} (publish_at) WHERE publish_at IS NOT NULL`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_finance_articles_deleted_at ON ${TABLE} (deleted_at) WHERE deleted_at IS NULL`).catch(() => {});
  _tableEnsured = true;
}

// ---------- 时间规范化 ----------

/**
 * 将 publishTime 字符串规范为带 +08:00 的 ISO 时间字符串。
 * 支持 yyyy-mm-dd、yyyy-mm-dd HH:mm、MM-DD HH:mm。
 */
function normalizePublishTime(str, now = new Date()) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim().replace(/\s+/g, ' ');
  const yearBeijing = now.getFullYear();

  // 完整日期
  const full = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (full) {
    const [, y, mo, d, h, min, sec] = full;
    const pad = n => String(parseInt(n, 10)).padStart(2, '0');
    return `${y}-${pad(mo)}-${pad(d)}T${h != null ? pad(h) : '00'}:${min != null ? pad(min) : '00'}:${sec != null ? pad(sec) : '00'}+08:00`;
  }
  // 短格式：MM-DD HH:mm
  const short = s.match(/^(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (short) {
    const [, mo, d, h, min, sec] = short;
    const pad = n => String(parseInt(n, 10)).padStart(2, '0');
    return `${yearBeijing}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(min)}:${sec != null ? pad(sec) : '00'}+08:00`;
  }
  return null;
}

// ---------- 写入 ----------

/**
 * 写入一批文章（ON CONFLICT DO NOTHING）。
 * @param {Array} articles
 * @returns {Promise<{ inserted: number, error?: string }>}
 */
async function writeArticlesBatch(articles) {
  if (!isConfigured()) return { inserted: 0, error: 'DB_CONFIG 未配置' };
  if (!Array.isArray(articles) || articles.length === 0) return { inserted: 0 };

  await ensureTable();
  const pool = getPool();
  let inserted = 0;

  for (const a of articles) {
    const url = (a.url && String(a.url).trim()) || '';
    if (!url) continue;
    const publishAt    = normalizePublishTime(a.publishTime && String(a.publishTime).trim());
    const embeddingJson = Array.isArray(a.embedding) && a.embedding.length > 0
      ? JSON.stringify(a.embedding) : null;
    const deletedAt = a.deleted_at != null ? a.deleted_at : null;
    try {
      const res = await pool.query(
        `INSERT INTO ${TABLE} (url, title, publish_at, author, summary, content, content_brief, site, embedding, deleted_at)
         VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (url) DO NOTHING`,
        [
          url,
          (a.title   && String(a.title))        || null,
          publishAt,
          (a.author  && String(a.author))        || null,
          (a.summary && String(a.summary))       || null,
          (a.content && String(a.content))       || null,
          (a.contentBrief && String(a.contentBrief)) || null,
          (a.site    && String(a.site))          || 'unknown',
          embeddingJson,
          deletedAt,
        ]
      );
      if (res.rowCount > 0) inserted++;
    } catch (e) {
      return { inserted, error: e.message };
    }
  }
  return { inserted };
}

/**
 * 写入单批（供「每满 10 篇就写」用），直接返回结果。
 * @param {Array} articles
 * @param {Function} [log]
 */
async function writeArticlesBatchWithLock(articles, log = () => {}) {
  const result = await writeArticlesBatch(articles);
  if (result.error) log(`写入 DB 失败: ${result.error}`);
  else log(`写入 DB: 本批 ${articles.length} 条，新插入 ${result.inserted} 条${result.inserted < articles.length ? '（其余已存在跳过）' : ''}`);
  return result;
}

// ---------- 查询 ----------

/**
 * 按 url 查单条（用于详情页抓取前判重）。
 */
async function getArticleByUrl(url) {
  if (!isConfigured() || !url) return null;
  try {
    const res = await getPool().query(
      `SELECT url, title, publish_at, author, summary, content, content_brief, site
       FROM ${TABLE} WHERE url = $1 AND deleted_at IS NULL LIMIT 1`,
      [url.trim()]
    );
    const r = res.rows[0];
    if (!r) return null;
    const publishTimeStr = r.publish_at
      ? (typeof r.publish_at === 'string' ? r.publish_at : r.publish_at.toISOString()).replace('T', ' ').slice(0, 16)
      : '';
    return {
      url: r.url,
      title: r.title || '',
      publishTime: publishTimeStr,
      author: r.author || '',
      summary: r.summary || '',
      content: r.content || '',
      contentBrief: r.content_brief || '',
      site: r.site || '',
    };
  } catch (_) {
    return null;
  }
}

/**
 * 按 report_date 加载文章：publish_at 落在 [reportDate 08:00, reportDate+1 08:00)，本地时间。
 */
async function loadArticlesByReportDate(reportDate) {
  if (!isConfigured()) return [];
  try {
    const start = new Date(`${reportDate}T08:00:00`);           // 本地时间
    const end   = new Date(start.getTime() + 24 * 3600 * 1000);
    const res = await getPool().query(
      `SELECT url, title, publish_at, author, summary, content, content_brief, site, cluster_rank, embedding
       FROM ${TABLE}
       WHERE deleted_at IS NULL
         AND publish_at IS NOT NULL
         AND publish_at >= $1 AND publish_at < $2
       ORDER BY cluster_rank NULLS LAST, id`,
      [start.toISOString(), end.toISOString()]
    );
    return mapRows(res.rows);
  } catch (_) {
    return [];
  }
}

/**
 * 按 report_date 加载文章（今日 08:00 至当前）。
 */
async function loadArticlesByReportDateUpToNow(reportDate) {
  if (!isConfigured()) return [];
  try {
    const start = new Date(`${reportDate}T08:00:00`);           // 本地时间
    const res = await getPool().query(
      `SELECT url, title, publish_at, author, summary, content, content_brief, site, cluster_rank, embedding
       FROM ${TABLE}
       WHERE deleted_at IS NULL
         AND publish_at IS NOT NULL
         AND publish_at >= $1 AND publish_at <= NOW()
       ORDER BY cluster_rank NULLS LAST, id`,
      [start.toISOString()]
    );
    return mapRows(res.rows);
  } catch (_) {
    return [];
  }
}

function mapRows(rows) {
  return (rows || []).map(r => {
    const pt = r.publish_at;
    const publishTimeStr = pt
      ? (typeof pt === 'string' ? pt : pt.toISOString()).replace('T', ' ').slice(0, 16)
      : '';
    let emb = r.embedding;
    if (typeof emb === 'string') { try { emb = JSON.parse(emb); } catch (_) { emb = null; } }
    if (!Array.isArray(emb) || emb.length === 0) emb = undefined;
    return {
      url: r.url,
      title: r.title,
      publishTime: publishTimeStr,
      author: r.author,
      summary: r.summary,
      content: r.content,
      contentBrief: r.content_brief,
      site: r.site,
      embedding: emb,
    };
  });
}

// ---------- 更新 ----------

/**
 * 按 url 更新单条：cluster_rank 或 deleted_at。
 */
async function updateArticleByUrl(url, updates) {
  if (!isConfigured()) return { updated: 0, error: 'DB_CONFIG 未配置' };
  const sets   = ['updated_at = NOW()'];
  const values = [];
  let n = 1;
  if (updates.cluster_rank !== undefined) { sets.push(`cluster_rank = $${n++}`); values.push(updates.cluster_rank); }
  if (updates.deleted_at   !== undefined) { sets.push(`deleted_at = $${n++}`);   values.push(updates.deleted_at); }
  if (values.length === 0) return { updated: 0 };
  values.push(url.trim());
  try {
    const res = await getPool().query(
      `UPDATE ${TABLE} SET ${sets.join(', ')} WHERE url = $${n}`,
      values
    );
    return { updated: res.rowCount || 0 };
  } catch (e) {
    return { updated: 0, error: e.message };
  }
}

/** 软删除：将 deleted_at 设为当前时间 */
async function softDeleteByUrl(url) {
  return updateArticleByUrl(url, { deleted_at: new Date() });
}

module.exports = {
  isConfigured,
  writeArticlesBatch,
  writeArticlesBatchWithLock,
  getArticleByUrl,
  loadArticlesByReportDate,
  loadArticlesByReportDateUpToNow,
  updateArticleByUrl,
  softDeleteByUrl,
};
