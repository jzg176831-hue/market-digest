'use strict';
/**
 * finance_clusters 表操作。使用共享连接池。
 */

const { isConfigured, getPool } = require('./pool');

const TABLE = 'finance_clusters';

let _tableEnsured = false;

async function ensureTable() {
  if (_tableEnsured) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id                    SERIAL PRIMARY KEY,
      report_date           DATE NOT NULL,
      cluster_rank          INT NOT NULL,
      summary               TEXT,
      china_summary         TEXT,
      international_summary TEXT,
      score                 NUMERIC NULL,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (report_date, cluster_rank)
    )
  `);
  _tableEnsured = true;
}

/**
 * 按日报日期取全部组总结，按 cluster_rank 升序。
 * @param {string} reportDate - YYYY-MM-DD
 */
async function getClusters(reportDate) {
  if (!isConfigured()) return [];
  try {
    const res = await getPool().query(
      `SELECT id, report_date, cluster_rank, summary, china_summary, international_summary, score, updated_at
       FROM ${TABLE} WHERE report_date = $1::date ORDER BY cluster_rank`,
      [reportDate]
    );
    return res.rows || [];
  } catch (_) {
    return [];
  }
}

/**
 * 插入或更新一条组总结。
 * @param {string} reportDate
 * @param {number} clusterRank
 * @param {{ summary?: string, china_summary?: string, international_summary?: string, score?: number|null }} payload
 */
async function upsertCluster(reportDate, clusterRank, payload = {}) {
  if (!isConfigured()) return { ok: false, error: 'DB 未配置' };
  await ensureTable();
  const summary              = payload.summary              ?? '';
  const chinaSummary         = payload.china_summary        ?? null;
  const internationalSummary = payload.international_summary ?? null;
  const score                = payload.score                ?? null;
  try {
    await getPool().query(
      `INSERT INTO ${TABLE} (report_date, cluster_rank, summary, china_summary, international_summary, score, created_at, updated_at)
       VALUES ($1::date, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (report_date, cluster_rank)
       DO UPDATE SET
         summary               = COALESCE(EXCLUDED.summary, ${TABLE}.summary),
         china_summary         = COALESCE(EXCLUDED.china_summary, ${TABLE}.china_summary),
         international_summary = COALESCE(EXCLUDED.international_summary, ${TABLE}.international_summary),
         score                 = EXCLUDED.score,
         updated_at            = NOW()`,
      [reportDate, clusterRank, summary, chinaSummary, internationalSummary, score]
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 取某 report_date 下当前最大 cluster_rank（无组时返回 0）。
 */
async function getMaxClusterRank(reportDate) {
  if (!isConfigured()) return 0;
  try {
    const res = await getPool().query(
      `SELECT COALESCE(MAX(cluster_rank), 0) AS max_rank FROM ${TABLE} WHERE report_date = $1::date`,
      [reportDate]
    );
    return parseInt(res.rows[0]?.max_rank || 0, 10);
  } catch (_) {
    return 0;
  }
}

module.exports = { isConfigured, getClusters, upsertCluster, getMaxClusterRank };
