#!/usr/bin/env node
'use strict';
/**
 * 入口：完整日报流程（抓取 → 去重聚类 → 生成报告）。
 *
 * 用法：
 *   node daily.js               # 默认：昨日 08:00 → 今日 08:00（早报/8点定时任务）
 *   node daily.js today         # 今日模式：今日 08:00 → 当前时间（用户在9:30后要今天日报）
 *   node daily.js 2026-04-06    # 指定日期：该日 08:00 → 次日 08:00
 */

const { crawlAll }        = require('./pipeline/crawl');
const { processAndReport } = require('./pipeline/process-report');
const { endPool }          = require('./db/pool');

async function main() {
  const arg = process.argv[2];
  let date;
  let window = 'full'; // 默认：完整时间窗口（昨天 08:00 → 今天 08:00）

  if (arg === 'today') {
    // 今日模式：今天 08:00 → 当前时间
    date = new Date().toLocaleDateString('sv');
    window = 'today';
  } else if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    // 指定日期
    date = arg;
  } else {
    // 默认：昨日
    const d = new Date();
    d.setDate(d.getDate() - 1);
    date = d.toLocaleDateString('sv');
  }

  console.error(`[daily] 报告日期: ${date}，window: ${window}`);

  await crawlAll();
  await processAndReport(date, window);
}

main()
  .catch(e => { console.error('[daily] 致命错误:', e.message || e); process.exit(1); })
  .finally(() => endPool());
