'use strict';
/**
 * 爬取核心逻辑：Playwright 抓取各源列表页与详情页，写入 DB（不落盘 data/）。
 * 对外导出 crawlAll()。
 */

const fs      = require('fs');
const path    = require('path');
const cheerio = require('cheerio');
const { chromium } = require('playwright-core');

const { callLLM, withRetry }  = require('../lib/llm');
const { text2Embedding }      = require('../lib/embedding');
const { createLogger }        = require('../lib/logger');
const {
  isConfigured: dbConfigured,
  writeArticlesBatchWithLock,
  getArticleByUrl,
} = require('../db/articles');
const {
  isConfigured: scheduleConfigured,
  checkRunning, setRunning, setIdle, getLastCrawlAt,
} = require('../db/schedule');
const { SOURCES, DETAIL_STRIP_SELECTORS, CHROME_EXECUTABLE = '' } = require('../config');

const ROOT = path.join(__dirname, '..');

// ---------- 常量 ----------

const SOURCE_CONCURRENCY    = 5;
const DETAIL_POOL_SIZE      = 10;
const DETAIL_STAGGER_MIN_MS = 2000;
const DETAIL_STAGGER_MAX_MS = 8000;
const GOTO_RETRY_WAIT_MS    = 2500;
const PAGINATION_RETRY_MS   = 4000;
const DETAIL_BODY_MIN_LEN   = 300;
const DETAIL_WAIT_FAIL_MS   = 2500;
const DEFAULT_LIST_OPTIONS  = { waitUntil: 'networkidle', timeout: 30000 };
const DEFAULT_DETAIL_OPTIONS = { waitUntil: 'domcontentloaded', timeout: 12000 };

const CONTENT_FILTER_RULE = `只采：金融资讯（宏观经济政策、行业动态、上市公司公告、监管政策解读、市场热点分析、机构研报摘要等）。按标题与摘要判断。
不采：涉港/涉澳/涉台纯政治、中国军事、中国领土争议、中国与他国外交骂战或纯外交表态（如外交部例行回应、撤侨进展等）。`;

const PARSED_ARTICLE_SCHEMA_BASE = `
返回仅一个 JSON 对象，不要 markdown 代码块或其它说明。格式严格如下：
{"articles":[{"url":"文章完整URL","title":"文章标题","publishTime":"发表时间（见下方格式要求）","author":"作者（页面上有则填，没有则空字符串）","summary":"摘要，有则填，没有则空或不写该字段"}]}
publishTime 格式要求（必须遵守）：仅使用 yyyy-mm-dd 或 yyyy-mm-dd HH:mm（24小时制，北京时间）。若页面上为「X小时前」「昨天」等相对时间，请换算为上述绝对时间。
去重：标题完全相同或高度相似的条目只保留一条，选信息更全的一条。
重要：请将整个 JSON 压缩为一行输出，不要换行、不要缩进，以便完整返回。`;

const DETAIL_PAGE_SCHEMA = `
返回仅一个 JSON 对象，不要 markdown 代码块或其它说明。格式严格如下（请整段 JSON 压缩为一行输出，不要换行与缩进）：
{"content":"文章正文纯文本，段落之间用换行分隔","author":"作者，页面上有则填没有则空","summary":"短摘要：仅基于正文概括，不得编造；1～3句话，必填","contentBrief":"正文精简版：必须基于 content；content 为空则 contentBrief 空字符串；有 content 时压缩改写并保留全部要点与数据数字，不得添加或臆测"}
重要：请将整个 JSON 压缩为一行输出，不要换行、不要缩进，以便完整返回。`;

// ---------- 日志 ----------

const today = new Date().toISOString().slice(0, 10);
const { log, logError, logStream } = createLogger('crawl', path.join(ROOT, 'logs', `${today}_fetch.log`));

function appendErrorLog(opts) {
  const { type, source = '', url = '', error, prompt = '', response = '' } = opts;
  const ts = new Date().toLocaleString('zh-CN');
  const header = type === 'list' ? `[列表页] ${source}` : `[详情页] ${(url || '').slice(0, 100)}`;
  const block = [
    '',
    `========== ${ts} ==========`,
    header,
    `错误: ${error}`,
    '',
    `--- PROMPT (共 ${(prompt || '').length} 字符) ---`,
    prompt || '(空)',
    '',
    `--- LLM 返回 (共 ${(response || '').length} 字符) ---`,
    response || '(无返回)',
    '',
    '========== END ==========',
    '',
  ].join('\n');
  const fp = path.join(ROOT, 'logs', `${today}.error.log`);
  try { fs.appendFileSync(fp, block, 'utf-8'); } catch (_) {}
}

// ---------- Embedding ----------

async function computeEmbeddingsOnly(articles) {
  let fail = 0;
  const out = [];
  for (const a of articles) {
    const text = [(a.title || '').trim(), (a.summary || '').trim()].filter(Boolean).join('\n');
    const emb  = await text2Embedding(text, log);
    if (emb) out.push({ ...a, embedding: emb, deleted_at: null });
    else     { fail++; out.push({ ...a, embedding: null, deleted_at: null }); }
  }
  return out;
}

// ---------- Playwright 工具 ----------

async function gotoWithRetry(page, url, options = {}, maxRetries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, GOTO_RETRY_WAIT_MS));
    try {
      await page.goto(url, options);
      return;
    } catch (e) {
      lastErr = e;
      const interrupted = /interrupted by another navigation/i.test(e?.message || '');
      if (interrupted && attempt <= maxRetries) {
        log(`  goto 被二次导航打断，重试 ${attempt}/${maxRetries}: ${url.slice(0, 70)}`);
        await new Promise(r => setTimeout(r, GOTO_RETRY_WAIT_MS));
        try { await page.goto(url, { ...options, waitUntil: 'domcontentloaded' }); return; } catch (e2) { lastErr = e2; }
      } else if (attempt < maxRetries) {
        log(`  goto 重试 ${attempt}/${maxRetries}: ${url.slice(0, 70)}`);
      }
    }
  }
  throw lastErr;
}

async function getSiteBodyHtml(page, source) {
  try {
    if (source.headers && Object.keys(source.headers).length) page.setExtraHTTPHeaders(source.headers);
    const opt = { ...DEFAULT_LIST_OPTIONS, ...(source.listOptions || {}) };
    await gotoWithRetry(page, source.url, { waitUntil: opt.waitUntil, timeout: opt.timeout });
    if (opt.afterLoadWaitMs) await new Promise(r => setTimeout(r, opt.afterLoadWaitMs));
    let bodyHtml = await page.evaluate(() => document.body ? document.body.innerHTML : '');
    if (opt.fetchArticleTabAfterLoad && bodyHtml) {
      const m = bodyHtml.match(/"url":"(https:[^"]*tab=article[^"]*)"/);
      if (m) {
        const tabUrl = m[1].replace(/\\\//g, '/');
        await gotoWithRetry(page, tabUrl, { waitUntil: 'load', timeout: opt.timeout });
        await new Promise(r => setTimeout(r, 5000));
        bodyHtml = await page.evaluate(() => document.body ? document.body.innerHTML : '');
      }
    }
    return bodyHtml;
  } catch (e) {
    logError(`[${source.name}] 获取列表页失败: ${e.message}`);
    return null;
  }
}

async function getListPageBodyByUrl(page, source, pageNum) {
  const opt      = source.listOptions || {};
  const template = opt.listPageUrlTemplate;
  if (!template) return null;
  const url = (template.replace(/\{\{page\}\}/g, String(pageNum)).startsWith('http'))
    ? template.replace(/\{\{page\}\}/g, String(pageNum))
    : `${(source.baseUrl || '').replace(/\/$/, '')}/${template.replace(/\{\{page\}\}/g, String(pageNum)).replace(/^\//, '')}`;
  try {
    if (source.headers && Object.keys(source.headers).length) page.setExtraHTTPHeaders(source.headers);
    await gotoWithRetry(page, url, { waitUntil: opt.waitUntil || 'load', timeout: opt.timeout || 45000 });
    await new Promise(r => setTimeout(r, opt.afterLoadWaitMs || 2000));
    return await page.evaluate(() => document.body ? document.body.innerHTML : '');
  } catch (e) {
    logError(`[${source.name}] 第 ${pageNum} 页加载失败: ${e.message}`);
    return null;
  }
}

async function getNextListPageBody(page, source) {
  const opt      = source.listOptions || {};
  const selector = opt.nextPageSelector;
  if (!selector) return null;
  const waitMs = opt.afterLoadWaitMs || 2000;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) {
        await new Promise(r => setTimeout(r, PAGINATION_RETRY_MS));
        await page.reload({ waitUntil: 'load', timeout: 20000 });
        await new Promise(r => setTimeout(r, 1500));
      }
      await page.waitForSelector(selector, { state: 'visible', timeout: 15000 });
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }).catch(() => null),
        page.click(selector, { timeout: 8000, force: true }),
      ]);
      await new Promise(r => setTimeout(r, waitMs));
      return await page.evaluate(() => document.body ? document.body.innerHTML : '');
    } catch (e) {
      lastErr = e;
      logError(`${source.name} 翻页失败 (${attempt}/3):`, e.message);
    }
  }
  return null;
}

// ---------- HTML 瘦身 ----------

const IMAGE_URL_PATTERN = /\.(jpe?g|png|gif|webp|svg|bmp|ico)(\?|$)/i;

function isImageUrl(href) {
  if (!href) return false;
  const s = href.trim().split('?')[0];
  return IMAGE_URL_PATTERN.test(s) || /\/image\/|\/img\/|\.sinaimg\.|cdn.*\.(jpg|png|gif)/i.test(href);
}

function removeComments(html) {
  return (html || '').replace(/<!--[\s\S]*?-->/g, '');
}

function shrinkBodyForList(html) {
  if (!html) return html;
  const $ = cheerio.load(html, { decodeEntities: false });
  $('script, style, img').remove();
  $('a').each(function () { if (isImageUrl($(this).attr('href') || '')) $(this).remove(); });
  $('[style]').each(function () { if (/url\s*\(/i.test($(this).attr('style') || '')) $(this).removeAttr('style'); });
  return removeComments($.html());
}

function shrinkBodyForDetail(bodyHtml, stripSelectors) {
  if (!bodyHtml) return bodyHtml;
  const $ = cheerio.load(bodyHtml, { decodeEntities: false });
  $('script, style, img').remove();
  $('a').each(function () {
    const href = $(this).attr('href') || '';
    if (isImageUrl(href)) $(this).remove();
    else { const t = $(this).text().trim() || ' '; $(this).replaceWith(t); }
  });
  $('[style]').each(function () { if (/url\s*\(/i.test($(this).attr('style') || '')) $(this).removeAttr('style'); });
  if (stripSelectors) stripSelectors.forEach(sel => { try { $(sel).remove(); } catch (_) {} });
  return removeComments($.html());
}

// ---------- 时间窗口（列表页 LLM prompt 用） ----------

function localDateStr(d = new Date()) {
  return d.toLocaleDateString('sv'); // YYYY-MM-DD，本地时区
}

function localDateTimeStr(d = new Date()) {
  return d.toLocaleString('zh-CN', { hour12: false });
}

function getYesterdayToday8() {
  const now    = new Date();
  const today  = localDateStr(now);
  const yestD  = new Date(now); yestD.setDate(yestD.getDate() - 1);
  const yest   = localDateStr(yestD);
  const fmt    = s => { const [y, m, d] = s.split('-').map(Number); return `${y}/${m}/${d} 8:00`; };
  return { start: fmt(yest), end: fmt(today), todayStr: today, yesterdayStr: yest };
}

function getListFilterPrompt(filterType, lastCrawlAt = null) {
  const now = new Date();
  const fmtTime = d => d ? localDateTimeStr(new Date(d)) : '';

  if (lastCrawlAt) {
    const from = lastCrawlAt instanceof Date ? lastCrawlAt : new Date(lastCrawlAt);
    const fromStr = fmtTime(from);
    const toStr   = fmtTime(now);
    const filterRule = filterType === 'daily_report'
      ? '只包含上述时间范围内的日报类条目（如新闻早报、金融早报、金融日报等），其他文章不要放入 articles。'
      : '只包含上述时间范围内发布的文章，超出范围的不要放入 articles。';
    return { timeRange: `时间范围：从【${fromStr}】到【${toStr}】（上次爬取至当前）。只保留发表时间在此范围内的文章。`, filterRule, rangeStart: from, rangeEnd: now, timeRangeLog: `上次爬取 ${fromStr} 至当前 ${toStr}` };
  }
  if (filterType === 'daily_report') {
    const todayStr   = localDateStr();
    const rangeStart = new Date(`${todayStr}T00:00:00`); // 本地时间
    return { timeRange: `只取今天的日报。时间：今天（${todayStr}）。`, filterRule: '只包含今天的日报类条目（如新闻早报、金融早报、金融日报等），只取今天发布的这类日报，其他文章不要放入 articles。', rangeStart, rangeEnd: now, timeRangeLog: `今天 00:00 至当前 (${fmtTime(now)})` };
  }
  const { start, end, todayStr, yesterdayStr } = getYesterdayToday8();
  const rangeStart = new Date(`${yesterdayStr}T08:00:00`); // 本地时间
  const rangeEnd   = new Date(`${todayStr}T08:00:00`);
  return { timeRange: `时间范围：【${start}】到【${end}】（昨天 8:00 至今天 8:00）。只保留发表时间在此范围内的文章。`, filterRule: '只包含上述时间范围内发布的文章，超出范围的不要放入 articles。', rangeStart, rangeEnd, timeRangeLog: `${start} 至 ${end}` };
}

function parsePublishTimeToDate(str) {
  if (!str) return null;
  const m = str.trim().replace(/\s+/g, ' ').match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!m) return null;
  const [, y, mo, d, h, min, sec] = m;
  try {
    return new Date(`${y}-${String(parseInt(mo)).padStart(2,'0')}-${String(parseInt(d)).padStart(2,'0')}T${String(parseInt(h||0)).padStart(2,'0')}:${String(parseInt(min||0)).padStart(2,'0')}:${String(parseInt(sec||0)).padStart(2,'0')}`);
  } catch (_) { return null; }
}

// ---------- 文章列表解析 ----------

function dedupByUrlAndTitle(articles) {
  const seenUrl   = new Set();
  const seenTitle = new Set();
  return articles.filter(a => {
    if (!a.url) return false;
    const u = (a.url || '').trim().split('#')[0].replace(/\/$/, '').toLowerCase();
    const t = (a.title || '').trim().replace(/\s+/g, ' ');
    if (seenUrl.has(u) || seenTitle.has(t)) return false;
    seenUrl.add(u); seenTitle.add(t);
    return true;
  });
}

function articleKey(a) {
  return (a?.url || '').trim().split('#')[0].replace(/\/$/, '').toLowerCase();
}

async function parseArticlesFromBody(source, bodyHtml, baseUrl, lastCrawlAt = null) {
  const filterType = source.listFilterType || 'time_window';
  const { timeRange, filterRule, rangeStart, rangeEnd, timeRangeLog } = getListFilterPrompt(filterType, lastCrawlAt);

  const schema = PARSED_ARTICLE_SCHEMA_BASE + '\n' + filterRule + '\n' + CONTENT_FILTER_RULE + '\nauthor 可能是人名、机构名、公司名等，页面上有则填；summary 同理。没有就留空。';
  const bodyShrunk = shrinkBodyForList(bodyHtml);
  const prompt = `你是一个解析网页的助手。${timeRange}\n\n下面是一个财经网站（${source.name}）列表页的 body HTML（已去除 script/style/注释）。请从中解析出所有同时满足「时间/日报条件」与「金融资讯」的条目。\n\n${schema}\n\nHTML 内容（仅 body 部分）：\n${bodyShrunk}`;
  const messages = [
    { role: 'system', content: '你只输出符合要求的 JSON，不输出任何其他文字或 markdown。' },
    { role: 'user',   content: prompt },
  ];

  let list;
  try {
    list = await withRetry(async () => {
      const content = await callLLM(messages, { timeoutMs: 180000 });
      if (!content) {
        appendErrorLog({ type: 'list', source: source.name, error: 'LLM 无返回', prompt, response: '' });
        throw new Error('LLM 无返回');
      }
      const raw = content.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1').trim();
      let data;
      try { data = JSON.parse(raw); } catch (e) {
        appendErrorLog({ type: 'list', source: source.name, error: e.message, prompt, response: content });
        throw e;
      }
      return Array.isArray(data.articles) ? data.articles : [];
    }, { maxRetries: 3, delayMs: 3000, label: `${source.name} 列表解析`, log });
  } catch (e) {
    logError(`[${source.name}] 列表解析 3 次均失败，跳过`);
    return [];
  }

  list.forEach(a => {
    if (a.url && !a.url.startsWith('http'))
      a.url = baseUrl + (a.url.startsWith('/') ? '' : '/') + a.url;
  });

  if (!rangeStart || !rangeEnd || list.length === 0) {
    log(`[${source.name}] LLM 解析 ${list.length} 篇 | ${timeRangeLog}`);
    list.forEach(a => log(`  来源:${source.name} 时间:${a.publishTime || '?'} 标题:${(a.title || '').slice(0, 60)}`));
    return list;
  }
  let parseFail = 0, outOfRange = 0;
  const filtered = list.filter(a => {
    const t = parsePublishTimeToDate(a.publishTime);
    if (t == null) { parseFail++; return false; }
    if (t < rangeStart || t > rangeEnd) { outOfRange++; return false; }
    return true;
  });
  const extra = [];
  if (outOfRange) extra.push(`超时间范围 ${outOfRange}`);
  if (parseFail)  extra.push(`时间解析失败 ${parseFail}`);
  log(`[${source.name}] LLM 解析 ${list.length} 篇 → 有效 ${filtered.length} 篇${extra.length ? ` (${extra.join('，')})` : ''} | ${timeRangeLog}`);
  filtered.forEach(a => log(`  来源:${source.name} 时间:${a.publishTime || '?'} 标题:${(a.title || '').slice(0, 60)}`));
  return filtered;
}

async function getArticlesFromListPage(source, bodyHtml, listPage, lastCrawlAt = null) {
  const opt = source.listOptions || {};
  const needPagination = !!(opt.pagination && (opt.listPageUrlTemplate || opt.nextPageSelector));
  let articles;
  if (!needPagination) {
    articles = await parseArticlesFromBody(source, bodyHtml, source.baseUrl, lastCrawlAt);
  } else {
    const maxPages = Math.max(1, opt.maxListPages || 5);
    articles = [];
    let currentBody = bodyHtml;
    let pageNum = 1;
    while (currentBody && pageNum <= maxPages) {
      const list = await parseArticlesFromBody(source, currentBody, source.baseUrl, lastCrawlAt);
      articles = articles.concat(list);
      if (pageNum >= maxPages || !list.length) break;
      currentBody = opt.listPageUrlTemplate
        ? await getListPageBodyByUrl(listPage, source, pageNum + 1)
        : await getNextListPageBody(listPage, source);
      if (!currentBody) break;
      pageNum++;
    }
  }
  articles = dedupByUrlAndTitle(articles);
  return articles;
}

// ---------- 详情页 ----------

async function fetchArticleDetail(page, url, source) {
  try {
    if (source?.headers && Object.keys(source.headers).length) page.setExtraHTTPHeaders(source.headers);
    const opt = { ...DEFAULT_DETAIL_OPTIONS, ...(source?.detailOptions || {}) };
    let bodyHtml = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await gotoWithRetry(page, url, { waitUntil: opt.waitUntil, timeout: opt.timeout });
        bodyHtml = await page.evaluate(() => document.body ? document.body.innerHTML : '');
        if (bodyHtml && bodyHtml.length >= DETAIL_BODY_MIN_LEN) break;
      } catch (e) {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, DETAIL_WAIT_FAIL_MS));
          try { bodyHtml = await page.evaluate(() => document.body ? document.body.innerHTML : ''); } catch (_) {}
        }
        if (bodyHtml && bodyHtml.length >= DETAIL_BODY_MIN_LEN) break;
        if (attempt === 2) throw e;
      }
    }
    if (!bodyHtml || bodyHtml.length < DETAIL_BODY_MIN_LEN) return { content: '', author: '', summary: '', contentBrief: '' };
    bodyHtml = shrinkBodyForDetail(bodyHtml, DETAIL_STRIP_SELECTORS);

    const prompt = `下面是一篇文章详情页的 body HTML（已去除脚本/样式/注释及导航页脚等）。请从中提取正文、作者、摘要与 contentBrief。\n\n作者可能是人名、机构名或公司名等，页面上有署名的都填入 author。summary 必须严格基于你提取出的正文概括，不得编造。contentBrief 必须基于 content：没有 content 就没有 contentBrief，content 为空时 contentBrief 必须填空字符串，不得自己编造；有 content 时再写正文精简版，保留全部要点与数据数字。\n\n${DETAIL_PAGE_SCHEMA}\n\nHTML：\n${bodyHtml}`;
    const messages = [
      { role: 'system', content: '你只输出符合要求的 JSON，不输出任何其他文字或 markdown。' },
      { role: 'user',   content: prompt },
    ];
    let raw;
    try {
      raw = await withRetry(async () => {
        const r = await callLLM(messages, { timeoutMs: 120000 });
        if (!r?.trim()) throw new Error('LLM 无返回');
        return r;
      }, { maxRetries: 2, delayMs: 3000, label: '详情页 LLM', log });
    } catch (e) {
      logError('详情页 LLM 失败:', e.message);
      appendErrorLog({ type: 'detail', url, error: e.message, prompt: messages.map(m=>`[${m.role}]\n${m.content}`).join('\n\n'), response: '(LLM 失败)' });
      return { content: '', author: '', summary: '', contentBrief: '' };
    }
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start === -1 || end < start) return { content: '', author: '', summary: '', contentBrief: '' };
    let parsed;
    try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch (e) {
      logError('详情页 JSON 解析失败:', e.message);
      appendErrorLog({ type: 'detail', url, error: e.message, prompt: messages.map(m=>`[${m.role}]\n${m.content}`).join('\n\n'), response: raw });
      return { content: '', author: '', summary: '', contentBrief: '' };
    }
    const content      = (parsed.content      && String(parsed.content).trim())      || '';
    const contentBrief = content ? ((parsed.contentBrief && String(parsed.contentBrief).trim()) || '') : '';
    return { content, author: (parsed.author && String(parsed.author).trim()) || '', summary: (parsed.summary && String(parsed.summary).trim()) || '', contentBrief };
  } catch (e) {
    logError(`抓取详情页失败 ${url}:`, e.message);
    return { content: '', author: '', summary: '', contentBrief: '' };
  }
}

async function fetchOneArticleDetail(page, a, source) {
  const detail      = await fetchArticleDetail(page, a.url, source);
  const author      = (a.author && String(a.author).trim()) || detail.author;
  const listSummary = (a.summary && String(a.summary).trim()) || '';
  const detSummary  = (detail.summary && String(detail.summary).trim()) || '';
  const preferDet   = !!source.preferDetailSummary;
  const summary     = preferDet ? (detSummary || listSummary) : (listSummary || detSummary);
  return { url: a.url, title: a.title || '', publishTime: a.publishTime || '', author: author || '', summary: summary || '', content: detail.content || '', contentBrief: detail.contentBrief || '', site: source.name };
}

async function getOrFetchArticleDetail(page, article, source) {
  if (dbConfigured()) {
    const cached = await getArticleByUrl(article.url);
    if (cached) { log(`[DB 命中] 跳过详情页 url=${article.url.slice(0, 50)}`); return { result: { ...cached, site: source.name }, fromCache: true }; }
  }
  const result = await fetchOneArticleDetail(page, article, source);
  return { result, fromCache: false };
}

// ---------- 页面池 ----------

function createPagePool(pages) {
  const available = [...pages];
  const waiting   = [];
  return {
    async acquire() {
      if (available.length > 0) return available.pop();
      return new Promise(resolve => waiting.push(resolve));
    },
    release(page) {
      if (waiting.length > 0) waiting.shift()(page);
      else available.push(page);
    },
  };
}

// ---------- 批量写 DB ----------

function makeMaybeFlushDb(source, pendingForDb) {
  let flushLock = Promise.resolve();
  let batchIdx  = 0;
  async function flush() {
    flushLock = flushLock.then(async () => {
      while (pendingForDb.length >= 10) {
        const batch   = pendingForDb.splice(0, 10);
        batchIdx++;
        const toWrite = await computeEmbeddingsOnly(batch);
        await writeArticlesBatchWithLock(toWrite, log);
      }
    });
    return flushLock;
  }
  async function flushAll() {
    await flush();
    let totalInserted = 0;
    while (pendingForDb.length > 0) {
      const batch   = pendingForDb.splice(0, 10);
      batchIdx++;
      const toWrite = await computeEmbeddingsOnly(batch);
      const r       = await writeArticlesBatchWithLock(toWrite, log);
      totalInserted += r.inserted || 0;
    }
    if (batchIdx > 0) log(`[${source.name}] 写 DB 完成：共 ${totalInserted} 条新增`);
  }
  return { flush, flushAll };
}

// ---------- 单源处理（流式翻页） ----------

async function runStreamingPagination(worker, source, bodyHtml, lastCrawlAt) {
  const opt      = source.listOptions || {};
  const maxPages = Math.max(1, opt.maxListPages || 5);
  const queue    = [];
  const state    = { listDone: false };
  const seen     = new Set();

  async function nextArticle() {
    while (queue.length === 0 && !state.listDone) await new Promise(r => setTimeout(r, 80));
    return queue.length > 0 ? queue.shift() : null;
  }

  async function listProducer() {
    let currentBody = bodyHtml, pageNum = 1;
    while (currentBody && pageNum <= maxPages) {
      const list = await parseArticlesFromBody(source, currentBody, source.baseUrl, lastCrawlAt);
      const deduped = dedupByUrlAndTitle(list);
      let added = 0;
      for (const a of deduped) {
        const k = articleKey(a);
        if (!k || seen.has(k)) continue;
        seen.add(k); queue.push(a); added++;
      }
      if (pageNum > 1) log(`[${source.name}] 第 ${pageNum} 页 → 新增 ${added} 篇`);
      if (pageNum >= maxPages || !list.length) break;
      currentBody = opt.listPageUrlTemplate
        ? await getListPageBodyByUrl(worker.listPage, source, pageNum + 1)
        : await getNextListPageBody(worker.listPage, source);
      if (!currentBody) break;
      pageNum++;
    }
    state.listDone = true;
  }

  const pool    = createPagePool(worker.detailPages);
  const results = [];
  const pending = [];
  const { flush, flushAll } = makeMaybeFlushDb(source, pending);

  let detailCount = 0;
  async function detailWorker() {
    while (true) {
      const article = await nextArticle();
      if (!article) break;
      await new Promise(r => setTimeout(r, DETAIL_STAGGER_MIN_MS + Math.floor(Math.random() * (DETAIL_STAGGER_MAX_MS - DETAIL_STAGGER_MIN_MS + 1))));
      const page = await pool.acquire();
      try {
        const n = ++detailCount;
        log(`  来源:${source.name} 详情[${n}] ${(article.title || '').slice(0, 50)}`);
        const { result } = await getOrFetchArticleDetail(page, article, source);
        results.push(result);
        if (result && dbConfigured()) { pending.push(result); flush().catch(e => logError('写 DB 失败', e)); }
      } catch (e) { logError(`[${source.name}] 详情页失败: ${e.message}`); }
      finally { pool.release(page); }
    }
  }

  const numWorkers = Math.min(SOURCE_CONCURRENCY, DETAIL_POOL_SIZE);
  await Promise.all([listProducer(), ...Array.from({ length: numWorkers }, () => detailWorker())]);

  const withContent = results.filter(Boolean);
  log(`[${source.name}] 完成 → ${withContent.length} 篇`);
  if (dbConfigured() && withContent.length > 0) await flushAll();
}

// ---------- 单源处理（非流式） ----------

async function processOneSource(worker, source, lastCrawlAt = null) {
  log(`[${source.name}] 抓取列表页 ${source.url}`);
  const bodyHtml = await getSiteBodyHtml(worker.listPage, source);
  if (!bodyHtml) return;

  const opt = source.listOptions || {};
  const needPagination = !!(opt.pagination && (opt.listPageUrlTemplate || opt.nextPageSelector));
  if (needPagination) {
    return runStreamingPagination(worker, source, bodyHtml, lastCrawlAt);
  }

  const articles = await getArticlesFromListPage(source, bodyHtml, worker.listPage, lastCrawlAt);
  if (articles.length === 0) { log(`[${source.name}] 无符合条件文章，跳过`); return; }
  log(`[${source.name}] 开始抓取详情 ${articles.length} 篇...`);

  const pool            = createPagePool(worker.detailPages);
  const resultsByIndex  = new Array(articles.length);
  const pending         = [];
  const { flush, flushAll } = makeMaybeFlushDb(source, pending);
  const promises = [];

  for (let i = 0; i < articles.length; i++) {
    const idx = i, article = articles[i];
    const startOne = async () => {
      const page = await pool.acquire();
      try {
        log(`  来源:${source.name} 详情[${idx + 1}/${articles.length}] ${(article.title || '').slice(0, 50)}`);
        const { result } = await getOrFetchArticleDetail(page, article, source);
        resultsByIndex[idx] = result;
        if (result && dbConfigured()) { pending.push(result); flush().catch(e => logError('写 DB 失败', e)); }
      } catch (e) { logError(`[${source.name}] 详情页失败: ${e.message}`); resultsByIndex[idx] = null; }
      finally { pool.release(page); }
    };
    promises.push(startOne());
    if (i < articles.length - 1)
      await new Promise(r => setTimeout(r, DETAIL_STAGGER_MIN_MS + Math.floor(Math.random() * (DETAIL_STAGGER_MAX_MS - DETAIL_STAGGER_MIN_MS + 1))));
  }
  await Promise.all(promises);

  const withContent = resultsByIndex.filter(Boolean);
  log(`[${source.name}] 完成 → ${withContent.length} 篇`);
  if (dbConfigured() && withContent.length > 0) await flushAll();
}

// ---------- 主入口 ----------

/**
 * 抓取所有来源并写入 DB。
 */
async function crawlAll() {
  log('===== 开始抓取 =====');

  if (scheduleConfigured()) {
    const { shouldExit, reason } = await checkRunning();
    if (shouldExit) { log(reason || '调度检查未通过，直接结束'); return; }
    const r = await setRunning();
    if (!r.ok) { logError('设置运行状态失败:', r.error || ''); throw new Error('setRunning failed'); }
  }

  let lastCrawlAt = null;
  if (scheduleConfigured()) {
    lastCrawlAt = await getLastCrawlAt();
    if (lastCrawlAt) {
      log(`增量模式：上次 ${localDateTimeStr(new Date(lastCrawlAt))}`);
    }
  }

  // 浏览器启动优先级：
  //   0. config.js 中 CHROME_EXECUTABLE 指定路径（安装时检测写入）
  //   1. playwright channel 'chrome'（系统 Chrome）
  //   2. playwright channel 'chromium'（系统 Chromium）
  //   3. 常见系统路径逐一尝试
  // 使用 playwright-core，不附带浏览器，依赖系统已安装的 Chrome 或 Chromium
  const sysChromiumPaths = [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/local/bin/chromium', '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  let browser;
  let launched = false;
  // 0. config.js 指定路径
  if (!launched && CHROME_EXECUTABLE && fs.existsSync(CHROME_EXECUTABLE)) {
    try { browser = await chromium.launch({ executablePath: CHROME_EXECUTABLE, headless: true }); log(`使用配置的浏览器: ${CHROME_EXECUTABLE}`); launched = true; } catch (_) {}
  }
  // 1. 系统 Chrome channel
  if (!launched) {
    try { browser = await chromium.launch({ channel: 'chrome', headless: true }); log('使用系统 Chrome'); launched = true; } catch (_) {}
  }
  // 2. 系统 Chromium channel
  if (!launched) {
    try { browser = await chromium.launch({ channel: 'chromium', headless: true }); log('使用系统 Chromium'); launched = true; } catch (_) {}
  }
  // 3. 常见可执行文件路径
  if (!launched) {
    for (const exe of sysChromiumPaths) {
      if (fs.existsSync(exe)) {
        try { browser = await chromium.launch({ executablePath: exe, headless: true }); log(`使用系统浏览器: ${exe}`); launched = true; break; } catch (_) {}
      }
    }
  }
  if (!launched) {
    throw new Error('未找到可用浏览器。请安装 Google Chrome 或 Chromium（macOS: brew install --cask google-chrome；Ubuntu: sudo apt install chromium-browser）');
  }

  try {
    const stealthScript = path.join(ROOT, 'tools', 'stealth.min.js');
    const workers = [];
    for (let w = 0; w < SOURCE_CONCURRENCY; w++) {
      const listPage = await browser.newPage();
      await listPage.setViewportSize({ width: 1280, height: 720 });
      if (fs.existsSync(stealthScript)) await listPage.addInitScript({ path: stealthScript });
      const detailPages = [];
      for (let i = 0; i < DETAIL_POOL_SIZE; i++) {
        const p = await browser.newPage();
        await p.setViewportSize({ width: 1280, height: 720 });
        if (fs.existsSync(stealthScript)) await p.addInitScript({ path: stealthScript });
        detailPages.push(p);
      }
      workers.push({ listPage, detailPages });
    }
    log(`抓取 ${SOURCES.length} 个源（并行 ${SOURCE_CONCURRENCY}）: ${SOURCES.map(s => s.name).join(', ')}`);

    for (let start = 0; start < SOURCES.length; start += SOURCE_CONCURRENCY) {
      const chunk = SOURCES.slice(start, start + SOURCE_CONCURRENCY);
      await Promise.all(chunk.map((source, i) => processOneSource(workers[i], source, lastCrawlAt)));
    }
    log('===== 抓取结束 =====');
  } finally {
    await browser.close();
    if (scheduleConfigured()) {
      const r = await setIdle();
      if (!r.ok) logError('释放锁失败:', r.error || '');
    }
    logStream.end();
  }
}

module.exports = { crawlAll };
