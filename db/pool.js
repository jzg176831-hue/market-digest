'use strict';
/**
 * 全局 pg.Pool 单例：所有 db 模块共用同一个连接池，避免每次操作 new Client。
 */

const { Pool } = require('pg');
const { DB_CONFIG } = require('../config');

let _pool = null;

/** DB 是否已配置（host、database、password 均存在） */
function isConfigured() {
  return !!(DB_CONFIG?.host && DB_CONFIG?.database && String(DB_CONFIG?.password || '').trim());
}

/** 获取（或懒初始化）全局连接池 */
function getPool() {
  if (!isConfigured()) throw new Error('数据库未配置：请填写 config.js 中的 DB_CONFIG');
  if (!_pool) {
    _pool = new Pool({
      host:     DB_CONFIG.host,
      port:     DB_CONFIG.port || 5432,
      database: DB_CONFIG.database,
      user:     DB_CONFIG.user,
      password: DB_CONFIG.password || '',
      max:                   10,
      idleTimeoutMillis:  30000,
      connectionTimeoutMillis: 5000,
    });
    _pool.on('error', (err) => {
      process.stderr.write(`[DB Pool] 意外错误: ${err.message}\n`);
    });
  }
  return _pool;
}

/** 程序退出前清理连接池 */
async function endPool() {
  if (_pool) {
    await _pool.end().catch(() => {});
    _pool = null;
  }
}

module.exports = { isConfigured, getPool, endPool };
