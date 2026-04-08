'use strict';
/**
 * 日志工厂：createLogger(prefix, logFilePath) → { log, logError, logStream }
 * 同时写 stderr 和文件，时间戳固定用 zh-CN locale。
 */

const fs   = require('fs');
const path = require('path');

/**
 * @param {string} prefix       - 每行头部标签，如 'crawl' / 'process'
 * @param {string} logFilePath  - 日志文件完整路径
 * @returns {{ log: Function, logError: Function, logStream: fs.WriteStream }}
 */
function createLogger(prefix, logFilePath) {
  const dir = path.dirname(logFilePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const stream = fs.createWriteStream(logFilePath, { flags: 'a' });

  function ts() {
    return new Date().toLocaleString('zh-CN');
  }

  function log(...args) {
    const msg = `[${ts()}] [${prefix}] ${args.join(' ')}`;
    process.stderr.write(msg + '\n');
    stream.write(msg + '\n');
  }

  function logError(...args) {
    const msg = `[${ts()}] [${prefix}] ERROR: ${args.join(' ')}`;
    process.stderr.write(msg + '\n');
    stream.write(msg + '\n');
  }

  return { log, logError, logStream: stream };
}

module.exports = { createLogger };
