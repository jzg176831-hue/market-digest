'use strict';
/**
 * finance_crawl_schedule 表操作。使用共享连接池。
 * 全局单条记录（source = '__global__'），用于记录抓取状态与上次爬取时间。
 */

const { isConfigured, getPool } = require('./pool');

const TABLE         = 'finance_crawl_schedule';
const GLOBAL_SOURCE = '__global__';

// ---------- 表初始化 ----------

let _tableEnsured = false;

async function ensureTable() {
  if (_tableEnsured) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id            SERIAL PRIMARY KEY,
      source        TEXT NOT NULL UNIQUE DEFAULT '__global__',
      status        TEXT NOT NULL DEFAULT 'idle',
      last_crawl_at TIMESTAMPTZ NULL,
      started_at    TIMESTAMPTZ NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  _tableEnsured = true;
}

/**
 * 获取全局记录（不存在返回 null）。
 */
async function getGlobalRow() {
  if (!isConfigured()) return null;
  try {
    const res = await getPool().query(
      `SELECT id, source, last_crawl_at, status, started_at FROM ${TABLE} WHERE source = $1 LIMIT 1`,
      [GLOBAL_SOURCE]
    );
    return res.rows[0] || null;
  } catch (_) {
    return null;
  }
}

/**
 * 启动前检查：确保表存在，若无全局记录则自动创建（自愈），不报错退出。
 */
async function checkRunning() {
  if (!isConfigured()) return { shouldExit: false };
  await ensureTable();
  let row = await getGlobalRow();
  if (!row) {
    // 首次运行：自动创建 __global__ 行
    await getPool().query(
      `INSERT INTO ${TABLE} (source, status) VALUES ($1, 'idle') ON CONFLICT (source) DO NOTHING`,
      [GLOBAL_SOURCE]
    );
    row = await getGlobalRow();
  }
  return { shouldExit: false };
}

/** 将全局记录设为运行中。 */
async function setRunning() {
  if (!isConfigured()) return { ok: false, error: 'DB 未配置' };
  await ensureTable();
  try {
    await getPool().query(
      `UPDATE ${TABLE} SET status = 'running', started_at = NOW(), updated_at = NOW() WHERE source = $1`,
      [GLOBAL_SOURCE]
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 将全局记录设回空闲并更新 last_crawl_at。 */
async function setIdle(lastCrawlAt = null) {
  if (!isConfigured()) return { ok: false, error: 'DB 未配置' };
  await ensureTable();
  try {
    if (lastCrawlAt != null) {
      const ts = lastCrawlAt instanceof Date ? lastCrawlAt : new Date(lastCrawlAt);
      await getPool().query(
        `UPDATE ${TABLE} SET status = 'idle', started_at = NULL, last_crawl_at = $1, updated_at = NOW() WHERE source = $2`,
        [ts, GLOBAL_SOURCE]
      );
    } else {
      await getPool().query(
        `UPDATE ${TABLE} SET status = 'idle', started_at = NULL, last_crawl_at = NOW(), updated_at = NOW() WHERE source = $1`,
        [GLOBAL_SOURCE]
      );
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 返回上次成功爬取结束时间（Date 或 null）。 */
async function getLastCrawlAt() {
  const row = await getGlobalRow();
  return row?.last_crawl_at ? new Date(row.last_crawl_at) : null;
}

module.exports = { isConfigured, getGlobalRow, checkRunning, setRunning, setIdle, getLastCrawlAt, GLOBAL_SOURCE };
