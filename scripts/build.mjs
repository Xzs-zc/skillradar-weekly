#!/usr/bin/env node
// SkillRadar · 每周 Codex Skill 雷达 —— 全流程构建脚本（Node 24，零 npm 依赖）
// 用法见文件末尾 CLI 解析；纯函数均已导出供 build.test.mjs 离线测试。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const DATA_DIR = path.join(DOCS, 'data');
const ARCHIVE_DIR = path.join(DOCS, 'archive');

export const DEFAULT_LIMIT = 5;
export const COOLDOWN_DAYS = 30;          // 冷却窗口：读取最近 30 天内的历史 JSON
export const MIN_TOTAL_STARS = 30;        // 仓库准入门槛
export const MAX_PUSHED_DAYS = 120;       // pushed_at 新鲜度门槛
export const MAX_SKILLS_PER_REPO = 2;
export const MAX_ENTITIES_PER_OWNER = 2;
export const SEED_REPOS = [
  'openai/skills',
  'composio-community/awesome-codex-skills',
  'am-will/codex-skills',
  'orkes-io/codex-skills',
  'proflead/codex-skills-library',
];
export const SEARCH_TOPICS = ['topic:codex-skills', 'topic:codex-cli'];
export const EXCLUDE_TOPICS = new Set([
  'mcp-server', 'mcp', 'agent-framework', 'ai-agents',
  'autonomous-agents', 'llm-agents', 'claude-skills', 'claude-code', 'claude',
]);

// ---------------------------------------------------------------- 日期工具
export function shanghaiDate(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
export function todayShanghai() {
  return shanghaiDate(Date.now());
}
export function parseDay(s) {
  return Date.parse(`${s}T00:00:00Z`);
}
export function addDays(s, n) {
  const d = new Date(parseDay(s));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- star-history
// 归一化响应为 [{weekStart:'YYYY-MM-DD', stars:n}]，返回顺序最新在前。
const WEEK_KEYS = ['week_start', 'weekStart', 'week', 'date', 'start', 'bucket', 'period', 'timestamp'];
const STAR_KEYS = ['stars', 'stargazers_count', 'count', 'added', 'new_stars', 'added_stars', 'increment', 'delta'];
function firstStr(obj, keys) {
  for (const k of keys) if (obj[k] != null && String(obj[k]).trim()) return String(obj[k]).trim();
  return null;
}
function firstNum(obj, keys) {
  for (const k of keys) {
    const v = Number(obj[k]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}
export function normalizeStarHistory(raw) {
  let arr = Array.isArray(raw) ? raw : null;
  if (!arr && raw && typeof raw === 'object') {
    for (const k of ['buckets', 'data', 'items', 'weeks', 'series', 'entries', 'history']) {
      if (Array.isArray(raw[k])) { arr = raw[k]; break; }
    }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue;
    const ws = firstStr(b, WEEK_KEYS);
    const st = firstNum(b, STAR_KEYS);
    if (ws == null || st == null) continue;
    out.push({ weekStart: ws.slice(0, 10), stars: st });
  }
  // 不假设返回顺序：若相邻桶按周升序则反转，保证最新在前。
  if (out.length >= 2) {
    const a = Date.parse(out[0].weekStart);
    const b = Date.parse(out[1].weekStart);
    if (Number.isFinite(a) && Number.isFinite(b) && a < b) out.reverse();
  }
  return out;
}

// 剔除「尚未结束的当前周」：桶覆盖 [start, start+7d)，今天落在此区间内即残缺。
export function dropIncompleteWeek(buckets, today) {
  const t = parseDay(today);
  return buckets.filter((b) => {
    const s = Date.parse(b.weekStart);
    if (!Number.isFinite(s)) return true; // 无法解析的桶保守保留
    return !(t >= s && t < s + 7 * 86400 * 1000);
  });
}

export function calcStats(buckets, totalStars) {
  if (!Array.isArray(buckets) || buckets.length < 2) return null;
  const vNow = buckets[0].stars;
  const rest = buckets.slice(1, 9); // 前 8 个完整周作基线
  const baseline = rest.reduce((a, b) => a + b.stars, 0) / rest.length;
  const burst = vNow >= 3 * Math.max(baseline, 1) && vNow >= 5;
  const score = vNow / Math.log(1 + Math.max(totalStars || 0, 1));
  return { vNow, baseline, burst, score: Number.isFinite(score) ? score : 0 };
}

// ---------------------------------------------------------------- 发现过滤
export function parseSkillFrontmatter(text) {
  if (!text) return null;
  const body = text.replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    fm[kv[1].toLowerCase()] = v;
  }
  if (!fm.name || !fm.description) return null; // Codex 硬性要求 name + description
  return { name: fm.name, description: fm.description };
}

export function topicExcluded(topics = []) {
  return topics.some((t) => EXCLUDE_TOPICS.has(String(t).toLowerCase()));
}
export function hasCodexSignal(meta, readme = '') {
  const topics = meta.topics || [];
  if (topics.some((t) => /codex/i.test(String(t)))) return true;
  return /\bcodex\b/i.test(readme);
}
// 准入：非 archived、非 MCP/agent-framework/claude-only 类；来自 Codex 种子或
// topics/README 明确含 Codex 信号。
export function skillRepoEligible(meta, readme = '', { fromSeed = false } = {}) {
  if (!meta || meta.archived) return false;
  if (topicExcluded(meta.topics || [])) return false;
  return fromSeed || hasCodexSignal(meta, readme);
}

// 冷却：只取最近 N 天内的历史数据文件（按日期，而非文件个数）。
export function dataFilesWithinDays(filenames, today, days = COOLDOWN_DAYS) {
  const cutoff = addDays(today, -days);
  return filenames.filter((f) => {
    const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
    return m && m[1] >= cutoff && m[1] <= today;
  });
}
export function loadSeenKeys(dataDir, today) {
  if (!fs.existsSync(dataDir)) return new Map();
  const files = dataFilesWithinDays(fs.readdirSync(dataDir), today);
  const seen = new Map();
  for (const f of files) {
    const date = f.slice(0, 10);
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
      for (const it of data.items || []) if (it && it.key) seen.set(it.key, date);
    } catch { /* 损坏的历史文件忽略 */ }
  }
  return seen;
}

// ---------------------------------------------------------------- 打分与选择
export function sortEntities(entities) {
  return [...entities].sort(
    (a, b) =>
      (b.score - a.score) ||
      (b.vNow - a.vNow) ||
      (b.totalStars - a.totalStars) ||
      a.fullName.localeCompare(b.fullName) ||
      a.skillPath.localeCompare(b.skillPath)
  );
}

// 确定性选择：冷却跳过（burst 豁免）→ 多样性（同仓库 ≤2、同 owner ≤2）→
// 候选不足时按「最近一次出现」从旧到新补齐并标 repeat。
export function pickTopEntities(entities, { limit = DEFAULT_LIMIT, seen = new Map() } = {}) {
  const sorted = sortEntities(entities);
  const picked = [];
  const pickedKeys = new Set();
  const repoCount = new Map();   // 按 fullName 计数，避免跨 owner 同名仓库误合并
  const ownerCount = new Map();
  const canAdd = (e) =>
    (repoCount.get(e.fullName) || 0) < MAX_SKILLS_PER_REPO &&
    (ownerCount.get(e.owner) || 0) < MAX_ENTITIES_PER_OWNER;
  const add = (e, repeat) => {
    picked.push({ ...e, repeat });
    pickedKeys.add(e.key);
    repoCount.set(e.fullName, (repoCount.get(e.fullName) || 0) + 1);
    ownerCount.set(e.owner, (ownerCount.get(e.owner) || 0) + 1);
  };
  for (const e of sorted) {
    if (picked.length >= limit) break;
    if (seen.has(e.key) && !e.burst) continue;
    if (!canAdd(e)) continue;
    add(e, false);
  }
  if (picked.length < limit) {
    const cooled = sorted
      .filter((e) => seen.has(e.key) && !pickedKeys.has(e.key))
      .sort((a, b) => (a.lastSeen || '9999').localeCompare(b.lastSeen || '9999'));
    for (const e of cooled) {
      if (picked.length >= limit) break;
      if (!canAdd(e)) continue;
      add(e, true);
    }
  }
  return picked;
}

// ---------------------------------------------------------------- LLM（DeepSeek）
// 提示词必须含 "json" 字样并给出键名示例（DeepSeek json_object 模式要求）。
export function buildLlmPrompt(item) {
  const repo = item.fullName;
  const readme = (item.readmeText || '').slice(0, 4000);
  const skill = (item.skillText || '').slice(0, 1500);
  return [
    '你是中文技术写作专家。请阅读下面这个 GitHub 上的 Codex skill 信息，',
    '写一段约 200 字的中文深度解读，并严格输出一个 json 对象（不要输出 markdown 代码块外的任何内容），',
    '字段固定为：{"what":"是什么","why":"为什么好用","design":"核心设计","usage":"怎么上手","insight":"对理解 Agent 的启发","notes":"注意事项"}。',
    '',
    `仓库：${repo}`,
    `Star 总数：${item.totalStars}`,
    `近 9 周新增 star：${(item.weekly || []).map((w) => `${w.weekStart}:${w.stars}`).join('，') || '无'}`,
    `仓库描述：${item.repoDesc || ''}`,
    '',
    '=== README（前 4000 字）===',
    readme,
    '',
    '=== SKILL.md（前 1500 字）===',
    skill,
    '',
    '请只输出上述六个字段的 json。',
  ].join('\n');
}

export function parseLlmJson(text) {
  if (!text) return null;
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  let obj = null;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const map = {
    what: ['what', '是什么', 'summary'],
    why: ['why', '为什么好用'],
    design: ['design', '核心设计'],
    usage: ['usage', '怎么上手', 'howto'],
    insight: ['insight', '启发'],
    notes: ['notes', '注意事项', 'caveats'],
  };
  const out = {};
  for (const [k, alts] of Object.entries(map)) {
    let v = '';
    for (const a of alts) if (obj[a] != null && String(obj[a]).trim()) { v = String(obj[a]).trim(); break; }
    out[k] = v;
  }
  return out;
}

// items 数组 → 每项补 llm 字段；单条失败不阻塞（置 null）。client(item, prompt) 返回文本或抛错。
export async function interpretItems(items, { client, concurrency = 3 } = {}) {
  const result = items.map((it) => ({ ...it, llm: null }));
  if (!client) return result;
  const queue = items.map((it, i) => ({ it, i }));
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const { it, i } = queue[next++];
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) { // 失败重试 1 次
        try {
          const text = await client(it, buildLlmPrompt(it));
          const parsed = parseLlmJson(text);
          if (parsed) { result[i] = { ...it, llm: parsed }; ok = true; }
        } catch { /* 重试或留空 */ }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
  return result;
}

async function deepseekChatText(item, prompt) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('missing DEEPSEEK_API_KEY');
  const base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.4,
    }),
  });
  if (!res.ok) throw new Error(`deepseek ${res.status}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('deepseek empty content');
  return content;
}

// ---------------------------------------------------------------- 渲染
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function badge(item) {
  const parts = [];
  if (item.burst) parts.push('<span class="badge burst">爆发中</span>');
  if (item.repeat) parts.push('<span class="badge repeat">近期已推荐</span>');
  return parts.join(' ');
}
function sparkline(weekly) {
  if (!weekly || weekly.length < 2) return '';
  const w = weekly.slice(-9); // 近 9 周，时间从左到右
  const max = Math.max(...w.map((x) => x.stars), 1);
  const bw = 14, gap = 3, h = 44;
  const rects = w.map((x, i) => {
    const bh = Math.max(1, Math.round((x.stars / max) * (h - 4)));
    return `<rect x="${i * (bw + gap)}" y="${h - bh}" width="${bw}" height="${bh}" rx="2"/>`;
  }).join('');
  return `<svg class="spark" width="${w.length * (bw + gap) - gap}" height="${h}" viewBox="0 0 ${w.length * (bw + gap) - gap} ${h}" role="img" aria-label="近9周新增star">${rects}</svg>`;
}
function llmSections(llm) {
  if (!llm) return '<p class="muted">本次未生成解读（可稍后手动补跑生成）。</p>';
  const labels = [
    ['what', '是什么'], ['why', '为什么好用'], ['design', '核心设计'],
    ['usage', '怎么上手'], ['insight', '对理解 Agent 的启发'], ['notes', '注意事项'],
  ];
  return labels.map(([k, label]) => (llm[k] ? `<h4>${label}</h4><p>${esc(llm[k])}</p>` : '')).join('');
}
function skillCard(item, rank) {
  const url = `https://github.com/${item.fullName}`;
  const skillUrl = `${url}/blob/${item.defaultBranch || 'HEAD'}/${item.skillPath}`;
  return `<article class="card">
  <div class="card-head"><span class="rank">#${rank}</span>
    <div><h3><a href="${url}" target="_blank" rel="noopener">${esc(item.name)}</a></h3>
    <div class="meta">${esc(item.fullName)} · ${item.skillPath}</div></div>
    ${badge(item)}
  </div>
  <div class="stats">
    <span>⭐ ${item.totalStars}</span><span>本周 +${item.vNow}</span>
    ${sparkline(item.weekly)}
  </div>
  <p class="desc">${esc(item.description || item.repoDesc || '')}</p>
  <p class="topics">${(item.topics || []).map((t) => `<code>${esc(t)}</code>`).join(' ')}</p>
  <div class="llm">${llmSections(item.llm)}</div>
  <details><summary>SKILL.md 预览</summary><pre>${esc((item.skillText || '').slice(0, 1500))}</pre></details>
  <div class="foot"><a href="${skillUrl}" target="_blank" rel="noopener">查看 SKILL.md ↗</a>
    <span class="muted">更新于 ${esc(item.pushedAt || '')}</span></div>
</article>`;
}
export function renderPage(date, { items, generatedAt, archives = [], isArchive = false } = {}) {
  const cards = items.map((it, i) => skillCard(it, i + 1)).join('');
  const nav = isArchive
    ? '<p><a href="../index.html">← 返回最新榜单</a></p>'
    : archives.length
      ? `<p>归档：${archives.map((a) => `<a href="archive/${a}.html">${a}</a>`).join(' · ')}</p>`
      : '';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>SkillRadar · ${date} · 每周 Codex Skill 雷达</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0d1117;color:#e6edf3;font:15px/1.65 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 20px 60px}
header h1{font-size:22px;margin:0 0 4px}
.muted{color:#8b949e;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;margin-top:16px}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:8px}
.card-head{display:flex;align-items:flex-start;gap:10px}
.rank{color:#f0b429;font-weight:700}
h3{margin:0;font-size:16px}a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
.meta,.foot{color:#8b949e;font-size:12px}
.badge{font-size:11px;border-radius:20px;padding:1px 8px;white-space:nowrap;margin-left:auto}
.badge.burst{background:#3d2b00;color:#f0b429;border:1px solid #f0b429}
.badge.repeat{background:#1f3a2d;color:#3fb950;border:1px solid #3fb950}
.stats{display:flex;align-items:center;gap:12px;font-size:13px;flex-wrap:wrap}
.spark{display:block}.spark rect{fill:#58a6ff}
.desc{margin:0;color:#c9d1d9}
.topics code{background:#21262d;border-radius:6px;padding:1px 6px;font-size:12px;margin-right:4px}
.llm h4{margin:10px 0 2px;font-size:13px;color:#f0b429}
.llm p{margin:0 0 4px;color:#c9d1d9}
details pre{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:10px;overflow:auto;font-size:12px;white-space:pre-wrap}
.foot{display:flex;justify-content:space-between;gap:8px;margin-top:auto}
</style></head><body><main>
<header><h1>SkillRadar · 每周 Codex Skill 雷达</h1>
<p class="muted">数据时间：${date}（上海时区）${isArchive ? '· 历史归档' : ''} · 生成于 ${esc(generatedAt)} · 共 ${items.length} 个 Codex skill</p>
${nav}</header>
<section class="grid">${cards}</section>
</main></body></html>`;
}

// ---------------------------------------------------------------- GitHub API
const UA = 'SkillRadar/1.0 (weekly codex skill radar)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ghFetch(url, { token, accept = 'application/vnd.github+json', retries = 3 } = {}) {
  const headers = { 'User-Agent': UA, Accept: accept };
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, { headers });
    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const remaining = Number(res.headers.get('x-ratelimit-remaining'));
      if (remaining === 0 || retryAfter > 0) {
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 60_000);
        continue;
      }
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`gh ${res.status} ${url}`);
    const text = await res.text();
    try { return { status: res.status, json: JSON.parse(text), remaining: Number(res.headers.get('x-ratelimit-remaining')) }; }
    catch { return { status: res.status, json: null, text }; }
  }
  throw new Error(`gh rate-limited ${url}`);
}
async function rawReadme(fullName) {
  for (const file of ['README.md', 'readme.md', 'Readme.md', 'README']) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${fullName}/HEAD/${file}`);
      if (res.ok) return (await res.text()).slice(0, 12000);
    } catch { /* 尝试下一个文件名 */ }
  }
  return '';
}
async function mapLimit(arr, n, fn) {
  const out = new Array(arr.length);
  let next = 0;
  const worker = async () => {
    while (next < arr.length) {
      const i = next++;
      out[i] = await fn(arr[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, () => worker()));
  return out;
}
function repoLinkRegex() {
  return /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g;
}

async function discover({ token, date, log }) {
  const repos = new Map(); // fullName -> repo record
  const record = (fullName, meta, { fromSeed = false } = {}) => {
    const [owner, repo] = fullName.split('/');
    const key = fullName.toLowerCase();
    if (repos.has(key)) return repos.get(key);
    const r = { fullName, owner, repo, fromSeed, meta, readmeText: '', entities: [] };
    repos.set(key, r);
    return r;
  };

  // 1) 种子仓库自身 + README 中抽取的仓库链接（零配额）
  for (const seed of SEED_REPOS) {
    try {
      const m = await ghFetch(`https://api.github.com/repos/${seed}`, { token });
      if (m) record(seed, m.json, { fromSeed: true });
      const readme = await rawReadme(seed);
      if (readme) {
        const r = record(seed); r.readmeText = readme;
        for (const mm of readme.matchAll(repoLinkRegex())) {
          const full = mm[1];
          if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(full)) record(full, null, { fromSeed: true });
        }
      }
    } catch (e) { log(`seed 失败 ${seed}: ${e.message}`); }
  }
  // 2) topic 搜索
  for (const q of SEARCH_TOPICS) {
    try {
      for (let page = 1; page <= 3; page++) {
        const r = await ghFetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=100&page=${page}`, { token });
        if (!r || !r.json) break;
        for (const it of r.json.items || []) record(it.full_name, it);
        if ((r.json.items || []).length < 100) break;
      }
    } catch (e) { log(`topic 搜索失败 ${q}: ${e.message}`); }
  }
  // 3) code search filename:SKILL.md（翻 2 页）
  try {
    for (let page = 1; page <= 2; page++) {
      const r = await ghFetch(`https://api.github.com/search/code?q=${encodeURIComponent('filename:SKILL.md')}&per_page=100&page=${page}`, { token });
      if (!r || !r.json) break;
      for (const it of r.json.items || []) if (it.repository?.full_name) record(it.repository.full_name, null);
      if ((r.json.items || []).length < 100) break;
    }
  } catch (e) { log(`code search 失败: ${e.message}`); }

  // 4) 补齐元数据并做仓库级准入过滤
  const cutoff = addDays(date, -MAX_PUSHED_DAYS);
  const eligible = [];
  const repoList = [...repos.values()];
  log(`候选仓库 ${repoList.length} 个，补齐元数据…`);
  await mapLimit(repoList, 5, async (r) => {
    if (!r.meta || r.meta.stargazers_count == null || !r.meta.topics) {
      const m = await ghFetch(`https://api.github.com/repos/${r.fullName}`, { token });
      if (!m) { r.skip = true; return; }
      r.meta = m.json;
    }
    const meta = r.meta;
    if (meta.archived || (meta.stargazers_count || 0) < MIN_TOTAL_STARS) { r.skip = true; return; }
    const pushed = (meta.pushed_at || '').slice(0, 10);
    if (pushed && pushed < cutoff) { r.skip = true; return; }
    const topics = meta.topics || [];
    if (!r.fromSeed && !topics.some((t) => /codex/i.test(String(t)))) {
      if (!r.readmeText) r.readmeText = await rawReadme(r.fullName);
    }
    if (!skillRepoEligible(meta, r.readmeText, { fromSeed: r.fromSeed })) { r.skip = true; return; }
    eligible.push(r);
  });
  log(`仓库级准入通过 ${eligible.length} 个，扫描 SKILL.md…`);

  // 5) 树扫描 + frontmatter 校验，产出 skill 实体
  const entities = [];
  await mapLimit(eligible, 5, async (r) => {
    const meta = r.meta;
    const branches = [meta.default_branch, 'HEAD', 'main', 'master'].filter(Boolean);
    let tree = null;
    for (const ref of [...new Set(branches)]) {
      const t = await ghFetch(`https://api.github.com/repos/${r.fullName}/git/trees/${ref}?recursive=1`, { token });
      if (t?.json?.tree) { tree = t.json.tree; r.branch = ref === 'HEAD' ? 'HEAD' : ref; break; }
    }
    if (!tree) return;
    const skillPaths = tree
      .filter((t) => t.type === 'blob' && /(^|\/)SKILL\.md$/.test(t.path))
      .map((t) => t.path)
      .slice(0, 50);
    await mapLimit(skillPaths, 5, async (p) => {
      try {
        const res = await fetch(`https://raw.githubusercontent.com/${r.fullName}/${r.branch || 'HEAD'}/${p}`);
        if (!res.ok) return;
        const text = (await res.text()).slice(0, 6000);
        const fm = parseSkillFrontmatter(text);
        if (!fm) return;
        entities.push({
          key: `${r.fullName}#${p}`,
          fullName: r.fullName, owner: r.owner, repo: r.repo, skillPath: p,
          name: fm.name, description: fm.description, skillText: text,
          totalStars: meta.stargazers_count || 0, topics: meta.topics || [],
          repoDesc: meta.description || '', pushedAt: meta.pushed_at || '',
          defaultBranch: r.branch || 'HEAD', readmeText: r.readmeText || '',
        });
      } catch { /* 单文件失败跳过 */ }
    });
  });
  log(`解析出 skill 实体 ${entities.length} 个，拉取 star-history…`);

  // 6) 逐仓库 star-history → 打分
  const histCache = new Map();
  const scored = [];
  const uniq = [...new Map(entities.map((e) => [e.fullName, e])).values()];
  await mapLimit(uniq, 5, async (e) => {
    const h = await ghFetch(`https://api.github.com/repos/${e.fullName}/star-history`, { token });
    histCache.set(e.fullName, h?.json ?? null);
  });
  const samples = [];
  for (const e of entities) {
    const raw = histCache.get(e.fullName);
    const buckets = dropIncompleteWeek(normalizeStarHistory(raw), date);
    const st = calcStats(buckets, e.totalStars);
    if (!st) {
      if (samples.length < 3) {
        samples.push({
          fullName: e.fullName,
          buckets: buckets.length,
          raw: raw != null ? JSON.stringify(raw).slice(0, 600) : 'NO_RESPONSE',
        });
      }
      continue;
    }
    const weekly = buckets.slice(0, 9).slice().reverse(); // 时间从左到右
    scored.push({ ...e, ...st, weekly });
  }
  return { entities: scored, diag: { candidates: repoList.length, eligible: eligible.length, entities: entities.length, scored: scored.length, samples } };
}

// ---------------------------------------------------------------- 输出
function writeOutputs({ date, items, generatedAt, skipIndex = false }) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const payload = {
    digestDate: date,
    generatedAt,
    items: items.map((it, i) => ({
      rank: i + 1, key: it.key, fullName: it.fullName, owner: it.owner, repo: it.repo,
      skillPath: it.skillPath, name: it.name, description: it.description,
      repoDesc: it.repoDesc, topics: it.topics, totalStars: it.totalStars,
      vNow: it.vNow, burst: !!it.burst, repeat: !!it.repeat, pushedAt: it.pushedAt,
      weekly: it.weekly || [], llm: it.llm,
    })),
  };
  fs.writeFileSync(path.join(DATA_DIR, `${date}.json`), JSON.stringify(payload, null, 2));
  const archives = fs.existsSync(DATA_DIR)
    ? dataFilesWithinDays(fs.readdirSync(DATA_DIR), date, 60).sort().reverse().map((f) => f.slice(0, 10))
    : [];
  const html = renderPage(date, { items: payload.items, generatedAt, archives, isArchive: false });
  // index.html 带底部归档导航；归档页独立成页，仅提供返回首页入口，避免相对路径失效
  const archiveHtml = renderPage(date, { items: payload.items, generatedAt, archives: [], isArchive: true });
  fs.writeFileSync(path.join(ARCHIVE_DIR, `${date}.html`), archiveHtml);
  if (!skipIndex) fs.writeFileSync(path.join(DOCS, 'index.html'), html);
  fs.writeFileSync(path.join(DOCS, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
}

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
  const get = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    dryRun: argv.includes('--dry-run'),
    noLlm: argv.includes('--no-llm'),
    limit: Number(get('--limit') || DEFAULT_LIMIT),
    date: get('--date') || todayShanghai(),
    raw: get('--raw-star-history'),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const cli = parseArgs(argv);
  const token = process.env.GITHUB_TOKEN || '';
  const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

  if (cli.raw) {
    const h = await ghFetch(`https://api.github.com/repos/${cli.raw}/star-history`, { token });
    console.log(JSON.stringify(h?.json ?? null, null, 2));
    return;
  }
  if (!cli.date || !/^\d{4}-\d{2}-\d{2}$/.test(cli.date)) throw new Error('--date 需为 YYYY-MM-DD');

  log(`开始构建：date=${cli.date} limit=${cli.limit} dryRun=${cli.dryRun} noLlm=${cli.noLlm}`);
  const { entities, diag } = await discover({ token, date: cli.date, log });
  const seen = loadSeenKeys(DATA_DIR, cli.date);
  const picked = pickTopEntities(entities, { limit: cli.limit, seen });
  const generatedAt = new Date().toISOString();

  if (picked.length === 0) {
    log('⚠️ 本次未选出任何 skill。诊断信息：');
    console.log(JSON.stringify({ ...diag, picked: picked.length }, null, 2));
    log('请把上方诊断贴给维护者，或在本地先跑：node scripts/build.mjs --raw-star-history openai/skills 查看真实字段。');
    process.exit(1);
  }

  if (cli.dryRun) {
    for (const [i, it] of picked.entries()) {
      console.log(`${i + 1}. [${it.burst ? '爆发' : '—'}${it.repeat ? '/repeat' : ''}] ${it.fullName} # ${it.skillPath} | score=${it.score.toFixed(3)} 本周+${it.vNow} total=${it.totalStars} name=${it.name}`);
    }
    console.log(`dry-run 共 ${picked.length} 条，未写文件、未调 LLM。`);
    return;
  }

  const useLlm = !cli.noLlm && process.env.DEEPSEEK_API_KEY;
  if (!useLlm && !cli.noLlm) log('未设置 DEEPSEEK_API_KEY，跳过解读（可用 --no-llm 静默跳过）。');
  const items = useLlm ? await interpretItems(picked, { client: deepseekChatText, concurrency: 3 }) : picked.map((it) => ({ ...it, llm: null }));

  const skipIndex = cli.date !== todayShanghai(); // 补生成历史日期只写该日期归档
  writeOutputs({ date: cli.date, items, generatedAt, skipIndex });
  log(`完成：写入 docs/（${items.length} 条，index${skipIndex ? ' 跳过' : ' 已更新'}）。`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
