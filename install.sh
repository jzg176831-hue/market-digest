#!/usr/bin/env bash
# ================================================================
# market-digest 一键安装脚本
# 用法（由 AI 自动执行，或手动运行）：
#   bash install.sh
#   bash install.sh --db-host 192.168.1.100 --db-name mydb --db-user postgres --db-pass secret
# ================================================================
set -euo pipefail

# ---------- 颜色输出 ----------
green() { echo -e "\033[32m$*\033[0m"; }
yellow() { echo -e "\033[33m$*\033[0m"; }
red() { echo -e "\033[31m$*\033[0m"; }

SKILL_NAME="market-digest"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

green "========================================="
green "  $SKILL_NAME 安装脚本"
green "========================================="

# ---------- 解析参数 ----------
DB_HOST="${DB_HOST:-}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-}"
DB_USER="${DB_USER:-postgres}"
DB_PASS="${DB_PASS:-}"
LLM_API_KEY="${LLM_API_KEY:-}"
LLM_BASE_URL="${LLM_BASE_URL:-https://ark.cn-beijing.volces.com/api/v3}"
LLM_MODEL="${LLM_MODEL:-deepseek-v3-1-250821}"
OPENAI_API_KEY="${OPENAI_API_KEY:-}"
OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.openai.com/v1}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db-host)  DB_HOST="$2";  shift 2 ;;
    --db-port)  DB_PORT="$2";  shift 2 ;;
    --db-name)  DB_NAME="$2";  shift 2 ;;
    --db-user)  DB_USER="$2";  shift 2 ;;
    --db-pass)  DB_PASS="$2";  shift 2 ;;
    --llm-key)  LLM_API_KEY="$2"; shift 2 ;;
    --llm-url)  LLM_BASE_URL="$2"; shift 2 ;;
    --llm-model) LLM_MODEL="$2"; shift 2 ;;
    --openai-key) OPENAI_API_KEY="$2"; shift 2 ;;
    --openai-url) OPENAI_BASE_URL="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; shift ;;
  esac
done

# ---------- 检查 Node.js ----------
if ! command -v node &>/dev/null; then
  red "错误：未找到 node，请先安装 Node.js >= 18"
  exit 1
fi
NODE_VER=$(node -e "process.stdout.write(process.version)")
green "✓ Node.js $NODE_VER"

# ---------- npm install ----------
green ">>> npm install..."
cd "$SKILL_DIR"
npm install
green "✓ npm 依赖安装完成"

# ---------- 生成 config.js ----------
if [[ -f "$SKILL_DIR/config.js" ]]; then
  yellow "⚠  config.js 已存在，跳过生成（如需重置请手动删除后重新运行）"
else
  green ">>> 生成 config.js..."
  # 写入配置（用传入参数或占位符）
  cat > "$SKILL_DIR/config.js" << JSEOF
'use strict';
// 由 install.sh 自动生成 — 请按需修改

const DB_CONFIG = {
  host:     '${DB_HOST:-YOUR_DB_HOST}',
  port:     ${DB_PORT},
  database: '${DB_NAME:-YOUR_DATABASE}',
  user:     '${DB_USER}',
  password: '${DB_PASS:-YOUR_DB_PASSWORD}',
};

const MODEL_CONFIG = {
  model:       '${LLM_MODEL}',
  api_key:     '${LLM_API_KEY:-YOUR_LLM_API_KEY}',
  base_url:    '${LLM_BASE_URL}',
  temperature: 0.3,
};

const DETAIL_STRIP_SELECTORS = [
  'nav', '.nav', '.navigation', '#nav', 'header nav', '.header-nav', '.main-nav',
  'footer', '.footer', '#footer', '.site-footer', '.page-footer',
  '.sidebar', '.side-bar', '#sidebar', '.aside', '#aside',
  '.ad', '.ads', '#ad', '.advertisement', '.ad-container', '[id*="ad-"]', '[class*="ad-"]', '.ad-box', '.recommend', '.hot-news', '.pop-news',
  '.social-share', '.share-bar', '.comment-area', '.comments',
];

const SOURCES = [
  { site: 'caixin',    name: 'caixin_finance',           url: 'https://finance.caixin.com/',      baseUrl: 'https://finance.caixin.com',    listFilterType: 'time_window' },
  { site: 'caixin',    name: 'caixin_economy',           url: 'https://economy.caixin.com/',      baseUrl: 'https://economy.caixin.com',    listFilterType: 'time_window' },
  { site: 'cnfin',     name: 'cnfin_finance_early',      url: 'https://search.cnfin.com/synthesis?q=%E8%B4%A2%E7%BB%8F%E6%97%A9%E6%8A%A5', baseUrl: 'https://www.cnfin.com', listFilterType: 'daily_report', listOptions: { waitUntil: 'load', timeout: 45000, afterLoadWaitMs: 3000 } },
  { site: 'eastmoney', name: 'eastmoney_finance_digest', url: 'https://finance.eastmoney.com/a/ccjdd.html', baseUrl: 'https://finance.eastmoney.com', listFilterType: 'time_window', listOptions: { waitUntil: 'load', timeout: 45000, afterLoadWaitMs: 3000, pagination: true, maxListPages: 30, listPageUrlTemplate: 'https://finance.eastmoney.com/a/ccjdd_{{page}}.html' }, preferDetailSummary: true },
  { site: 'sina',      name: 'sina_finance_roll',        url: 'https://finance.sina.com.cn/roll', baseUrl: 'https://finance.sina.com.cn',   listFilterType: 'time_window', listOptions: { waitUntil: 'load', timeout: 45000, afterLoadWaitMs: 3000, pagination: true, maxListPages: 30, nextPageSelector: 'a[onclick*="newsList.page.next()"]' } },
];

const OPENAI_EMBEDDING_CONFIG = {
  api_key:  '${OPENAI_API_KEY:-YOUR_OPENAI_API_KEY}',
  model:    'text-embedding-ada-002',
  base_url: '${OPENAI_BASE_URL}',
};

const EMBEDDING_DEDUP_THRESHOLD = 0.92;

module.exports = { DB_CONFIG, MODEL_CONFIG, SOURCES, DETAIL_STRIP_SELECTORS, OPENAI_EMBEDDING_CONFIG, EMBEDDING_DEDUP_THRESHOLD };
JSEOF
  green "✓ config.js 已生成"

  if [[ -z "$DB_HOST" || -z "$DB_PASS" || -z "$LLM_API_KEY" ]]; then
    yellow ""
    yellow "⚠  以下字段仍需手动填写 config.js："
    [[ -z "$DB_HOST" ]]    && yellow "   DB_CONFIG.host     (数据库主机)"
    [[ -z "$DB_NAME" ]]    && yellow "   DB_CONFIG.database (数据库名)"
    [[ -z "$DB_PASS" ]]    && yellow "   DB_CONFIG.password (数据库密码)"
    [[ -z "$LLM_API_KEY" ]] && yellow "   MODEL_CONFIG.api_key (LLM API Key)"
    [[ -z "$OPENAI_API_KEY" ]] && yellow "   OPENAI_EMBEDDING_CONFIG.api_key (Embedding API Key)"
    yellow ""
  fi
fi

# ---------- 初始化数据库 ----------
if [[ -n "$DB_HOST" && -n "$DB_NAME" && -n "$DB_PASS" ]]; then
  green ">>> 初始化数据库表..."
  if command -v psql &>/dev/null; then
    PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
      -f "$SKILL_DIR/sql/setup.sql" && green "✓ 数据库表已初始化" \
      || yellow "⚠  数据库初始化失败，请手动执行 sql/setup.sql"
  else
    yellow "⚠  未找到 psql，请手动执行: psql -h $DB_HOST -U $DB_USER -d $DB_NAME -f sql/setup.sql"
  fi
else
  yellow "⚠  未提供完整数据库参数，跳过建表。请手动执行 sql/setup.sql"
fi

# ---------- 完成 ----------
green ""
green "========================================="
green "  安装完成！"
green "========================================="
echo ""
echo "  快速开始："
echo "    node fetch.js           # 仅爬取文章"
echo "    node daily.js           # 仅基于数据库生成日报"
echo "    node daily-full.js      # 抓取 + 聚类 + 生成日报"
echo "    node daily.js 2026-04-06  # 指定日期"
echo ""
echo "  配置文件：$SKILL_DIR/config.js"
echo "  数据库 SQL：$SKILL_DIR/sql/setup.sql"
echo ""
