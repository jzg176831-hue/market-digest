#!/usr/bin/env node
'use strict';
/**
 * 入口：仅爬取文章并写入 DB。
 * 用法：node fetch.js
 */

const { crawlAll } = require('./pipeline/crawl');
const { endPool }  = require('./db/pool');

crawlAll()
  .catch(e => { console.error('[fetch] 致命错误:', e.message || e); process.exit(1); })
  .finally(() => endPool());
