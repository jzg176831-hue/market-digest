-- ============================================================
-- market-digest 数据库初始化
-- 执行方式（任选一种）：
--   psql -h HOST -U USER -d DATABASE -f setup.sql
--   或由 install.sh 自动执行
-- ============================================================

-- 1. 文章表
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

-- 2. 日报聚类总结表
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

-- 3. 抓取调度表（全局单行，用于记录上次爬取时间）
CREATE TABLE IF NOT EXISTS finance_crawl_schedule (
  id            SERIAL PRIMARY KEY,
  source        TEXT NOT NULL UNIQUE DEFAULT '__global__',
  status        TEXT NOT NULL DEFAULT 'idle',
  last_crawl_at TIMESTAMPTZ NULL,
  started_at    TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 插入全局唯一行（幂等，已存在则跳过）
INSERT INTO finance_crawl_schedule (source, status)
VALUES ('__global__', 'idle')
ON CONFLICT (source) DO NOTHING;
