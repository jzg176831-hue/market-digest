'use strict';
/**
 * 处理 + 报告一体：
 *   1. 从 DB 加载文章
 *   2. URL 去重
 *   3. Embedding 相似度预聚类 → LLM 同事件归类
 *   4. Step1 多源组总结 / Step2 单篇筛选总结
 *   5. 写 finance_clusters
 *   6. 格式化报告 → 输出 OpenClaw reply 标记（由 OpenClaw 统一推送；不落盘 reports/）
 *
 * 对外导出 processAndReport(date)。
 */

const fs   = require('fs');
const path = require('path');

const { callLLM }     = require('../lib/llm');
const { createLogger } = require('../lib/logger');
const {
  isConfigured: dbConfigured,
  loadArticlesByReportDate,
  loadArticlesByReportDateUpToNow,
  softDeleteByUrl,
  updateArticleByUrl,
} = require('../db/articles');
const {
  isConfigured: clustersDbConfigured,
  upsertCluster,
  getClusters,
} = require('../db/clusters');
const ROOT = path.join(__dirname, '..');

// ---------- 常量 ----------

const LLM_TIMEOUT_MS          = 180000;
const LLM_SUMMARY_MAX_CHARS   = 250;
const REPORT_BRIEF_MAX        = 800;
const REPORT_CONTENT_MAX      = 2800;
const SINGLE_CLUSTER_MAX      = 10;
const EMBEDDING_THRESHOLD     = 0.92;

const SCOPE_CHINA         = '**范围界定**：中国包括大陆及港澳台；主体或政策归属为中国（国内政策、央行与部委、本国企业、本国官员及对外表态、国内金融与实体经济）的纳入本段；主体为境外经济体、境外央行、境外企业且无中国官方/机构回应的，不纳入本段。纯政治争端不写。';
const SCOPE_INTERNATIONAL = '**范围界定**：主体或政策归属为境外（境外经济体、境外央行与监管、境外企业与跨境资本流动、国际经贸与关税等）的纳入本段；中国包括大陆及港澳台，港澳台相关归属中国市场，不纳入本段。纯政治争端不写。';

// ---------- 日志 / 文件工具 ----------

let _logger = null;

function getLogger() {
  if (!_logger) {
    const today = new Date().toLocaleDateString('sv'); // YYYY-MM-DD，系统本地时区
    _logger = createLogger('process', path.join(ROOT, 'logs', `${today}_process.log`));
  }
  return _logger;
}

function appendLog(filePath, text) {
  if (!filePath) return;
  try { fs.appendFileSync(filePath, text, 'utf-8'); } catch (_) {}
}

// ---------- LLM 调用（带日志记录） ----------

function logLlmIo(label, messages, response, logPath, dailyLogPath = null) {
  const promptText = messages.map(m => `[${m.role}]\n${m.content || ''}`).join('\n\n');
  const block = `\n\n${'='.repeat(60)}\nSTART ${label}\n${'='.repeat(60)}\n--- PROMPT ---\n${promptText}\n\n--- RESPONSE ---\n${response}\n${'='.repeat(60)}\nEND ${label}\n`;
  if (logPath)      appendLog(logPath,      block);
  if (dailyLogPath) appendLog(dailyLogPath, block);
  process.stdout.write(block);
}

async function callLlmWithLog(messages, label, logPath, timeoutMs = LLM_TIMEOUT_MS, dailyLogPath = null) {
  const content = await callLLM(messages, { timeoutMs });
  logLlmIo(label, messages, content || '', logPath, dailyLogPath);
  return content;
}

// ---------- 去重工具 ----------

function urlDedup(articles) {
  const seen = new Set();
  return articles.filter(a => {
    const u = (a.url || '').trim().split('#')[0].replace(/\/$/, '').toLowerCase();
    if (!u || seen.has(u)) return false;
    seen.add(u); return true;
  });
}

// ---------- Embedding 聚类 ----------

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom <= 0 ? 0 : dot / denom;
}

function clusterByEmbedding(articles, threshold = EMBEDDING_THRESHOLD) {
  const n      = articles.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const similarPairs = [];
  function find(i) { if (parent[i] !== i) parent[i] = find(parent[i]); return parent[i]; }
  function union(i, j) { const pi = find(i), pj = find(j); if (pi !== pj) parent[pi] = pj; }

  const embeddings = articles.map(a => (Array.isArray(a.embedding) && a.embedding.length > 0 ? a.embedding : null));
  for (let i = 0; i < n; i++) {
    if (!embeddings[i]) continue;
    for (let j = i + 1; j < n; j++) {
      if (!embeddings[j]) continue;
      const sim = cosineSimilarity(embeddings[i], embeddings[j]);
      if (sim >= threshold) { similarPairs.push({ i, j, sim }); union(i, j); }
    }
  }
  const map = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!map.has(r)) map.set(r, []);
    map.get(r).push(i);
  }
  return { clusters: Array.from(map.values()).sort((a, b) => b.length - a.length), similarPairs };
}

// ---------- LLM 同事件归类 ----------

async function clusterByLlm(articles, dailyLogPath = null, embeddingClusters = null) {
  const n    = articles.length;
  const rows = articles.map((a, i) => {
    let summary = (a.summary || '').trim();
    if (summary.length > LLM_SUMMARY_MAX_CHARS) summary = summary.slice(0, LLM_SUMMARY_MAX_CHARS) + '…';
    return { idx: i, title: (a.title || '').trim(), summary: summary || '(无摘要)' };
  });

  let prompt = `你是财经新闻聚合助手。下面这批文章为采集的金融资讯信息，包括宏观经济政策、行业动态、上市公司公告、监管政策解读、市场热点分析、机构研报摘要等。每篇有编号、标题、摘要。请把报道**同一具体事件/同一条具体新闻**的归为同一组（同事件多源），便于后续综合多篇视角。\n`;
  if (Array.isArray(embeddingClusters) && embeddingClusters.length > 0) {
    prompt += `\n以下已按 embedding 相似度预分组（同组多为同一或相关事件，组内篇数多通常表示事件越重要）。请在此基础上将报道**同一具体事件**的归为同一组，可合并预分组、可拆开预分组；输出 clusters 时使用下方文章列表的 idx。\n预分组（供参考）：\n`;
    embeddingClusters.forEach((group, gi) => {
      const idxs = group.filter(i => i >= 0 && i < n);
      if (idxs.length) prompt += `组${gi + 1} 共${idxs.length}篇 idx: ${idxs.join(', ')}\n`;
    });
    prompt += '\n';
  }
  prompt += `\n归类规则（严格）：\n- 只把报道**同一件具体事**的多篇归为同一组（不同来源、不同侧写可归为同一组，同事件多源）。\n- **不要**仅因属于同一大主题就归为一组；不同事件、不同角度应拆成多组或单独成组。\n- 标题说的明显不是同一件事的，必须分组。每篇文章的编号恰好出现在一个组里。拿不准的单独成组。\n- 直接输出一个 JSON，不要 markdown 代码块，格式：{"clusters": [[0,1,2],[3],[4,5],...]}，内层数组为同事件一组，数字为 idx。\n\n文章列表（每行：idx | title | summary）：\n`;
  for (const r of rows) prompt += `\n${r.idx} | ${r.title} | ${r.summary}`;

  process.stdout.write(`[LLM] clusterByLlm prompt 字符数: ${prompt.length}\n`);
  const messages = [
    { role: 'system', content: '你只输出符合要求的 JSON，不输出任何其他文字。' },
    { role: 'user',   content: prompt },
  ];
  const content = await callLLM(messages, { timeoutMs: LLM_TIMEOUT_MS });
  logLlmIo('ClusterByLlm', messages, content || '', null, dailyLogPath);

  let str = (content || '').trim();
  for (const f of ['```json', '```']) {
    if (str.startsWith(f))   str = str.slice(f.length).trimStart();
    if (str.endsWith('```')) str = str.slice(0, -3).trimEnd();
  }
  let clustersRaw = [];
  try { clustersRaw = (JSON.parse(str).clusters || []); } catch (_) {}

  const seen = new Set();
  const clusters = [];
  for (const c of clustersRaw) {
    if (!Array.isArray(c)) continue;
    const idxs = c.map(x => parseInt(x, 10)).filter(i => !isNaN(i) && i >= 0 && i < n);
    if (!idxs.length || idxs.some(i => seen.has(i))) continue;
    idxs.forEach(i => seen.add(i));
    clusters.push(idxs);
  }
  for (let i = 0; i < n; i++) if (!seen.has(i)) clusters.push([i]);
  return clusters;
}

function buildClustersOutput(articles, clusters) {
  return clusters
    .map((cluster, cid) => ({ cluster_id: cid, cluster_size: cluster.length, articles: cluster.map(j => ({ ...articles[j] })) }))
    .sort((a, b) => b.cluster_size - a.cluster_size);
}

// ---------- Step1：多源组总结 ----------

async function step1MultiCluster(cluster, rank, logPath, dailyLogPath = null) {
  const articles = cluster.articles || [];
  if (articles.length < 2) return null;

  const lines = articles.map((a, i) => {
    let body = (a.content || '').trim() || (a.contentBrief || '').trim();
    if (body.length > REPORT_CONTENT_MAX) body = body.slice(0, REPORT_CONTENT_MAX) + '…';
    return `【篇${i}】url: ${(a.url || '').trim()}\ntitle: ${(a.title || '').trim()}\ncontent: ${body}`;
  });

  const system = '你是财经日报编辑。只输出一个 JSON，不要 markdown 代码块，不要其他文字。china_summary、international_summary 每段 80 ~ 150 字以内，不要过长。两段不能写相同或雷同内容；通常只填其中一段，另一段空字符串。';
  const user   = `本组共 ${articles.length} 篇（同事件多源），请完成：\n1) 组内来源去重：判断哪些篇与其它篇信息完全重复、无新增，在 redundant_indices 中列出其下标（从0开始）。\n2) 是否金融资讯：若整组明显不属于金融资讯（宏观经济政策、行业动态、上市公司公告、监管政策解读、市场热点分析、机构研报摘要等），则 is_financial 填 false，且不填 china_summary/international_summary。\n3) 若 is_financial 为 true：写综合总结。要求：只写经济金融相关事实与关键数据，不写纯政治表述。china_summary 与 international_summary 分别写与中国市场相关、与国际市场相关的内容，无则空字符串。**每段控制在 200～400 字以内，精炼要点，不要太长。**\n**重要**：中国市场、国际市场两段**不能写相同或雷同的内容**。一般本组事件只归属一方，**通常只填其中一段、另一段填空字符串**即可；若确有中国侧与国际侧不同角度的内容，两段才都写，且必须**一边写中国市场、一边写国际市场**，内容明显不同，禁止两段大意相同或复制粘贴。\n${SCOPE_CHINA}\n${SCOPE_INTERNATIONAL}\n同时列出 contradiction_excluded：因相互矛盾、数据不一致、明显错误、虚假信息、夸大表述而剔除不写入总结的篇的下标。\n\n输出 JSON 格式（仅此一个 JSON 对象）：\n{"redundant_indices": [], "is_financial": true, "china_summary": "...", "international_summary": "...", "contradiction_excluded": []}\n\n文章内容：\n${lines.join('\n\n')}`;

  let content = await callLlmWithLog(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    `Step1_Cluster_Rank${rank}`, logPath, LLM_TIMEOUT_MS, dailyLogPath
  );
  content = (content || '').trim();
  for (const f of ['```json', '```']) {
    if (content.startsWith(f))   content = content.slice(f.length).trimStart();
    if (content.endsWith('```')) content = content.slice(0, -3).trimEnd();
  }
  let out;
  try { out = JSON.parse(content); } catch (_) { return null; }
  if (!out.is_financial) return null;

  const toIntArr = (arr, len) => (Array.isArray(arr) ? arr : []).map(x => parseInt(x, 10)).filter(i => !isNaN(i) && i >= 0 && i < len);
  return {
    china_summary:         (out.china_summary || '').trim(),
    international_summary: (out.international_summary || '').trim(),
    redundant_indices:     toIntArr(out.redundant_indices, articles.length),
    contradiction_excluded: toIntArr(out.contradiction_excluded, articles.length),
  };
}

// ---------- Step2：单篇优先级 ----------

async function step2SinglePriority(singleArticles, multiSummaries, logPath, dailyLogPath = null) {
  const singleBlock = singleArticles.map((a, i) => {
    let brief = (a.contentBrief || '').trim();
    if (brief.length > REPORT_BRIEF_MAX) brief = brief.slice(0, REPORT_BRIEF_MAX) + '…';
    return `【单篇${i}】\ntitle: ${(a.title || '').trim()}\nauthor: ${(a.author || '').trim() || '（无）'}\ncontentBrief: ${brief}`;
  }).join('\n\n');
  const multiBlock = (multiSummaries && multiSummaries.length) ? multiSummaries.join('\n\n') : '（无同事件多源综合总结）';
  const user = `下面有两部分：1) 同事件多源的综合总结（中国+国际）；2) 所有单篇的标题、作者、正文精简（contentBrief）。\n\n请判断每篇单篇是否保留（输出其下标，按重要性从高到低）：\n- 须为金融资讯（宏观政策、行业动态、上市公司公告、监管解读、市场热点、机构研报等）；宏观优先于企业，企业仅保留大公司或对宏观有较大影响的；小作文、传言不保留。\n- 作者不够权威（非知名媒体、机构、分析师、官方信源等）的可剔除。\n- 明显非金融新闻或对读者价值低的可剔除。\n- 若该篇内容已在同事件多源综合总结中覆盖，则删。虚假、夸大、矛盾内容也删。\n输出「保留的单篇下标」的优先级列表，仅保留的篇的下标。例如 [3, 0, 5] 表示保留第0、3、5篇且优先级 3>0>5。若全部删掉则输出 []。\n\n同事件多源综合总结：\n${multiBlock}\n\n单篇列表（含 author，用于判断信源是否权威）：\n${singleBlock}\n\n输出 JSON 数组，例如 [2, 0, 1] 或 []：`;

  let content = await callLlmWithLog(
    [{ role: 'system', content: '你只输出一个 JSON 数组，不要 markdown 代码块，不要其他文字。' }, { role: 'user', content: user }],
    'Step2_Single_Priority', logPath, LLM_TIMEOUT_MS, dailyLogPath
  );
  content = (content || '').trim();
  for (const f of ['```json', '```']) {
    if (content.startsWith(f))   content = content.slice(f.length).trimStart();
    if (content.endsWith('```')) content = content.slice(0, -3).trimEnd();
  }
  let idxList = [];
  try { idxList = JSON.parse(content); } catch (_) {}
  if (!Array.isArray(idxList)) idxList = [];
  return idxList.map(x => parseInt(x, 10)).filter(i => !isNaN(i) && i >= 0 && i < singleArticles.length);
}

async function step2SingleSections(singleArticles, keptIndices, logPath, dailyLogPath = null) {
  if (!keptIndices || !keptIndices.length) return [];
  const ordered = keptIndices.map(i => singleArticles[i]);
  const lines = ordered.map((a, i) => {
    let brief = (a.contentBrief || '').trim();
    if (brief.length > REPORT_BRIEF_MAX) brief = brief.slice(0, REPORT_BRIEF_MAX) + '…';
    return `【第${i + 1}篇】title: ${(a.title || '').trim()}\nauthor: ${(a.author || '').trim() || '（无）'}\ncontentBrief: ${brief}`;
  });
  const user = `以下为按优先级排序的单篇财经文章（标题、作者、正文精简）。对**每一篇**做两项判断：\n1) 是否纳入日报：非金融资讯、事实不准确、事实存疑、虚假/夸大、对读者价值低等均可**不纳入**（include 填 false），该类将不会写入日报且文章会被软删除。\n2) 若纳入（include 为 true）：再输出 priority（1=最重要、2=次之…）、china_summary、international_summary。日报单篇最多只取前 ${SINGLE_CLUSTER_MAX} 条，请按重要性对纳入的篇排序给出 priority。**单篇只能写中国市场或国际市场其中一段，二选一**：china_summary 与 international_summary 只能一个有内容，另一个必须填空字符串，不要两段都写。\n\n${SCOPE_CHINA}\n${SCOPE_INTERNATIONAL}\n要求：仅纳入确属金融资讯、事实可靠、有读者价值的内容。不纳入时 skip_reason 可简要说明原因。若纳入，每条精炼一两句话，**每段不超过 150 字**，且**只填中国或国际一段**。\n\n内容（共 ${ordered.length} 篇）：\n${lines.join('\n\n')}\n\n请输出一个 JSON 数组，且必须是一行（不要换行、不要 markdown 代码块）。每项必须包含 index（从 1 开始）、include（布尔）。include 为 true 时还需 priority（整数，1=最重要）、china_summary、international_summary；**china_summary 与 international_summary 二选一有内容，另一段填空字符串**。include 为 false 时可选 skip_reason。\n\n示例（一行）：${JSON.stringify([{ index: 1, include: true, priority: 1, china_summary: '...', international_summary: '' }, { index: 2, include: false, skip_reason: '非金融资讯' }, { index: 3, include: true, priority: 2, china_summary: '', international_summary: '...' }])}\n\n规则：index 为 1 到 ${ordered.length} 的整数。单篇只填中国或国际一段，不要两段都写。只输出该 JSON 数组，且整段为一行。`;

  const content = await callLlmWithLog(
    [{ role: 'system', content: '你只输出一个 JSON 数组，且必须是一行（不换行、无 markdown 代码块）。每项含 index、include；include 为 true 时含 priority、china_summary、international_summary，且 china_summary 与 international_summary 二选一有内容、另一段填空；include 为 false 时可选 skip_reason。' }, { role: 'user', content: user }],
    'Step2_Single_Sections', logPath, LLM_TIMEOUT_MS, dailyLogPath
  );
  let raw = (content || '').trim();
  for (const f of ['```json', '```']) {
    if (raw.startsWith(f))   raw = raw.slice(f.length).trimStart();
    if (raw.endsWith('```')) raw = raw.slice(0, -3).trimEnd();
  }
  let arr = [];
  try { arr = JSON.parse(raw); } catch (_) {}
  if (!Array.isArray(arr)) arr = [];

  const byIndex = new Map();
  arr.forEach(item => {
    if (!item || typeof item !== 'object') return;
    const idx = item.index != null ? parseInt(item.index, 10) : null;
    if (isNaN(idx) || idx < 1 || idx > ordered.length) return;
    const include  = item.include === true || item.include === 'true';
    const priority = typeof item.priority === 'number' ? item.priority : (parseInt(item.priority, 10) || 999);
    byIndex.set(idx, { include, priority, china_summary: String(item.china_summary || ''), international_summary: String(item.international_summary || ''), skip_reason: String(item.skip_reason || '') });
  });
  return Array.from({ length: ordered.length }, (_, i) => {
    const one = byIndex.get(i + 1);
    if (!one)         return { include: false, skip_reason: '未解析到' };
    if (!one.include) return { include: false, skip_reason: one.skip_reason || '' };
    return { include: true, priority: one.priority, china_summary: one.china_summary || '', international_summary: one.international_summary || '' };
  });
}

// ---------- 核心流程：去重 + 聚类 + 写 clusters ----------

async function processArticles(date, window = 'full') {
  const { log, logError } = getLogger();
  const logsDir       = path.join(ROOT, 'logs');
  const dailyLogPath  = path.join(logsDir, `${date}_dedup.log`);

  appendLog(dailyLogPath, `\n\n[${new Date().toISOString()}] ========== process 开始 ==========\n`);
  const flow = msg => { log(`[流程] ${msg}`); appendLog(dailyLogPath, `[${new Date().toISOString()}] [流程] ${msg}\n`); };
  flow(`开始，日期=${date}，window=${window}`);

  // Step0：加载文章
  flow('Step0 加载数据源');
  let articles = [];
  if (dbConfigured()) {
    articles = window === 'today'
      ? await loadArticlesByReportDateUpToNow(date)
      : await loadArticlesByReportDate(date);
    flow(`数据源=DB，共 ${articles.length} 篇`);
  } else {
    flow('未配置 DB，无法加载文章（已移除本地 data/ 回退）');
  }

  articles = urlDedup(articles);
  flow(`URL 去重后 ${articles.length} 篇`);
  if (!articles.length) { flow('无文章，退出'); return; }

  // Embedding 预聚类
  let embeddingClustersForLlm = null;
  if (dbConfigured()) {
    flow(`ClusterByEmbedding（阈值=${EMBEDDING_THRESHOLD}）`);
    const { clusters: embClusters, similarPairs } = clusterByEmbedding(articles);
    const embData = buildClustersOutput(articles, embClusters);
    flow(`ClusterByEmbedding 完成：${embData.length} 组`);
    const pairLog = similarPairs.length ? similarPairs.map(({ i, j, sim }) => `  [${i + 1}]↔[${j + 1}] sim=${sim.toFixed(4)}  "${(articles[i]?.title || '').slice(0, 36)}" ↔ "${(articles[j]?.title || '').slice(0, 36)}"`).join('\n') : '无相似配对';
    appendLog(dailyLogPath, `\n--- ClusterByEmbedding（阈值=${EMBEDDING_THRESHOLD}）---\n${pairLog}\n--- END ---\n`);
    embeddingClustersForLlm = embClusters;
  } else {
    flow('ClusterByEmbedding 跳过（未配置 DB）');
  }

  // LLM 同事件归类
  flow('Step1 LLM 同事件归类');
  let clusters;
  try {
    clusters = await clusterByLlm(articles, dailyLogPath, embeddingClustersForLlm);
  } catch (e) {
    logError('LLM 同事件归类失败:', e.message);
    return;
  }
  const clustersData = buildClustersOutput(articles, clusters);
  flow(`同事件归类：${clustersData.length} 组`);

  const multiClusters  = clustersData.filter(c => (c.cluster_size || 0) >= 2);
  const singleClusters = clustersData.filter(c => (c.cluster_size || 0) === 1);
  const singleArticles = singleClusters.map(c => c.articles?.[0] || {}).filter(a => a.url || a.title);

  appendLog(dailyLogPath, `\n--- 日报 LLM IO ---\n日期: ${date}\n多源组: ${multiClusters.length}  单篇: ${singleClusters.length}\n---\n`);
  flow(`Step1 多源 ${multiClusters.length} 组，单篇 ${singleClusters.length} 个`);

  // Step1：多源组并行总结
  flow('Step1 多源并行开始');
  const step1Results = await Promise.all(multiClusters.map((c, idx) => step1MultiCluster(c, idx + 1, null, dailyLogPath)));
  flow('Step1 多源并行结束');

  const multiSummaries       = [];
  const multiBlocksForMerge  = [];
  const multiRemainingForFile = [];

  multiClusters.forEach((c, idx) => {
    const result = step1Results[idx];
    if (!result) return;
    const arts     = c.articles || [];
    const dropped  = new Set([...(result.redundant_indices || []), ...(result.contradiction_excluded || [])]);
    const remaining = arts.filter((_, i) => !dropped.has(i));
    multiRemainingForFile.push({
      cluster_rank: idx + 1, cluster_size: arts.length, remaining_count: remaining.length,
      dropped_redundant_indices: result.redundant_indices, dropped_contradiction_indices: result.contradiction_excluded,
      remaining_articles: remaining,
    });
    multiSummaries.push(`${result.china_summary || ''}\n${result.international_summary || ''}`);
    multiBlocksForMerge.push({ cluster_rank: idx + 1, cluster_size: c.cluster_size || 0, china_summary: result.china_summary || '', international_summary: result.international_summary || '' });
  });
  multiBlocksForMerge.sort((a, b) => (b.cluster_size || 0) - (a.cluster_size || 0));

  // 写 finance_clusters（多源组）
  if (clustersDbConfigured()) {
    flow('写入 finance_clusters 多源组');
    for (const b of multiBlocksForMerge) {
      await upsertCluster(date, b.cluster_rank, { summary: [b.china_summary, b.international_summary].filter(Boolean).join('\n'), china_summary: b.china_summary, international_summary: b.international_summary });
      log(`[DB] clusters rank=${b.cluster_rank} size=${b.cluster_size} ch=${(b.china_summary || '').length}字 int=${(b.international_summary || '').length}字`);
    }
    flow(`写入 finance_clusters 多源组：共 ${multiBlocksForMerge.length} 组`);
  }

  // Step2：单篇优先级 + 两段
  flow('Step2 单篇开始');
  const keptIndices          = await step2SinglePriority(singleArticles, multiSummaries, null, dailyLogPath);
  const singleSectionResults = await step2SingleSections(singleArticles, keptIndices, null, dailyLogPath);
  const ordered              = keptIndices.map(i => singleArticles[i]);

  const singleIncluded = singleSectionResults
    .map((r, i) => r.include === true ? { ...r, orderIndex: i } : null).filter(Boolean)
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
    .slice(0, SINGLE_CLUSTER_MAX);
  const singleTopN            = singleIncluded;
  const singleSummaries       = singleTopN.map(r => ({ china_summary: r.china_summary || '', international_summary: r.international_summary || '' }));
  const singleExcludedOrders  = singleSectionResults.map((r, i) => r.include !== true ? i : -1).filter(i => i >= 0);
  const singleRemainingForFile = singleTopN.map(r => ({ ...ordered[r.orderIndex] }));

  log(`[Report] Step2 单篇：优先级保留 ${keptIndices.length}，纳入 ${singleIncluded.length}，排除 ${singleExcludedOrders.length}`);

  const multiCount = multiBlocksForMerge.length;
  if (singleSummaries.length > 0 && clustersDbConfigured()) {
    flow('写入 finance_clusters 单篇');
    for (let i = 0; i < singleSummaries.length; i++) {
      const s = singleSummaries[i];
      await upsertCluster(date, multiCount + 1 + i, { summary: [s.china_summary, s.international_summary].filter(Boolean).join('\n'), china_summary: s.china_summary, international_summary: s.international_summary });
    }
  }

  // 软删除 + 更新 cluster_rank
  if (dbConfigured()) {
    let softDeleted = 0;
    for (let idx = 0; idx < multiRemainingForFile.length; idx++) {
      const m         = multiRemainingForFile[idx];
      const clArts    = (multiClusters[idx] && multiClusters[idx].articles) || [];
      const droppedI  = new Set([...(m.dropped_redundant_indices || []), ...(m.dropped_contradiction_indices || [])]);
      for (const a of clArts.filter((_, i) => droppedI.has(i))) {
        if (!a.url) continue;
        const r = await softDeleteByUrl(a.url);
        if (r.updated) softDeleted++;
      }
      for (const a of (m.remaining_articles || [])) {
        if (a.url) await updateArticleByUrl(a.url, { cluster_rank: m.cluster_rank || idx + 1 });
      }
    }
    const singleDropped = singleArticles.filter((_, i) => !keptIndices.includes(i));
    for (const a of singleDropped) { if (!a.url) continue; const r = await softDeleteByUrl(a.url); if (r.updated) softDeleted++; }
    for (const j of singleExcludedOrders) { const a = ordered[j]; if (!a?.url) continue; const r = await softDeleteByUrl(a.url); if (r.updated) softDeleted++; }
    for (let i = 0; i < singleRemainingForFile.length; i++) {
      const a = singleRemainingForFile[i];
      if (a.url) await updateArticleByUrl(a.url, { cluster_rank: multiCount + 1 + i });
    }
    log(`[DB] 软删除 ${softDeleted} 条，cluster_rank 已更新`);
  }

  flow('process 完成');
}

// ---------- 报告生成 ----------

async function generateReport(date) {
  const { log } = getLogger();
  log(`开始生成报告 report_date=${date}`);

  const clusters = await getClusters(date);
  if (!clusters || clusters.length === 0) {
    log(`${date} 无 clusters 数据，跳过`);
    return null;
  }

  const chinaParts         = clusters.filter(c => (c.china_summary || '').trim()).map(c => c.china_summary.trim());
  const internationalParts = clusters.filter(c => (c.international_summary || '').trim()).map(c => c.international_summary.trim());
  const chinaBody          = chinaParts.join('\n\n').trim() || '无';
  const internationalBody  = internationalParts.join('\n\n').trim() || '无';

  const reportContent = [
    `# 📊 金融市场日报 - ${date}`,
    '',
    `## 🇨🇳 中国市场`,
    '',
    chinaBody,
    '',
    `## 🌍 国际市场`,
    '',
    internationalBody,
    '',
  ].join('\n');

  log(`报告已生成（仅 stdout OpenClaw 标记 + DB clusters，未写 reports/）`);

  // 通过 OpenClaw reply 标记回传内容，由 OpenClaw 统一推送到配置的渠道（飞书/企微/微信等）
  process.stdout.write(`__OPENCLAW_REPLY_START__\n${reportContent}\n__OPENCLAW_REPLY_END__\n`);

  return { reportContent, reportPath: null };
}

// ---------- 对外主入口 ----------

/**
 * 完整处理流程：去重聚类 + 生成报告。
 * @param {string} date   - YYYY-MM-DD
 * @param {'full'|'today'} [window] - 文章时间窗口，默认 'full'（昨天 08:00 → 今天 08:00）
 */
async function processAndReport(date, window = 'full') {
  await processArticles(date, window);
  await generateReport(date);
}

module.exports = { processAndReport, processArticles, generateReport };
