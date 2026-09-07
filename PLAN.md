# SkillRadar · 每周 Codex Skill 雷达（DeepSeek 解读版）

## 摘要
每周一 07:00（上海时间，= UTC 周日 23:00）由 GitHub Actions 跑 `scripts/build.mjs`：
发现 Codex 生态候选仓库 → 拉 GitHub `/stargazers/history` 周增星数据 → 归一化周增速打分 →
30 天冷却去重 → 选出 **Top 5 Codex skill** → 各调一次 **DeepSeek** 生成中文深度解读 →
渲染静态 HTML 提交到 `docs/`，由 GitHub Pages 发布。仅 Skill 分区，无 agent 项目/MCP。

成本 ≈ $0（GitHub Actions 免费额度 + 每周 5 次 DeepSeek flash 调用）。零 npm 依赖、
无数据库、无框架、无 JS。需配置 1 个 Actions secret：`DEEPSEEK_API_KEY`（你提供）。

## 文件
- `.github/workflows/daily.yml` —— cron（`0 23 * * 0`）+ `workflow_dispatch`，跑脚本并 commit `docs/`
- `scripts/build.mjs` —— 全流程；纯函数具名导出，末尾 main() 守卫
- `scripts/build.test.mjs` —— `node --test`，全离线 fixture
- 生成物：`docs/index.html`、`docs/archive/YYYY-MM-DD.html`、`docs/data/YYYY-MM-DD.json`、`docs/robots.txt`

## 为什么每周
- `/stargazers/history` 按自然周分桶（返回 `week`/`total`/`days`，最新在前，`total` 为该周新增）：同一周内每天跑排序数据几乎不变，只有周界才换新桶；
  周一 07:00 跑正好取到「刚结束的完整周」。
- Codex skill 生态比全 agent 池小，叠加 30 天冷却后每天跑会大量产生 `repeat` 填充。
- `workflow_dispatch` 保留用于手动补跑/校准。

## 发现（Codex 生态限定）
- 种子仓库（零配额，README 正则抽外链 + 自身入池）：`openai/skills`、
  `composio-community/awesome-codex-skills`、`am-will/codex-skills`、
  `orkes-io/codex-skills`、`proflead/codex-skills-library`
- Search topics：`topic:codex-skills`、`topic:codex-cli`；code search `filename:SKILL.md` 翻 2 页
- 准入：仓库非 archived、`stargazers_count ≥ 30`、`pushed_at` 在 120 天内；
  来自种子 或 topics/README 含 codex 信号；排除仅标注 Claude、MCP server、agent-framework 类。
- SKILL.md 校验：frontmatter 必须含 `name` + `description`（Codex 硬性要求），不合格跳过。
- 树扫描定位 `SKILL.md`（每仓库 ≤50 个），raw 拉取前 6000 字符解析。

## 打分
```
buckets = `/stargazers/history` 周桶（`week` 为 Unix 秒、`total` 为周增星；自适应归一化），剔除「尚未结束的当前周」，最新在前
v_now    = buckets[0].stars
baseline = mean(buckets[1..8].stars)
burst    = v_now >= 3 * max(baseline, 1) && v_now >= 5
score    = v_now / ln(1 + total_stars)
```
- **剔除残缺当前周是正确性关键**：否则周一至周三的榜单被系统性低估。
- 桶不足 2 个则该仓库本次跳过。

## 选择
- 冷却：读 `docs/data/` 中最近 **30 天**内的 JSON（按日期过滤，非文件个数），出现过即跳过；`burst` 豁免。
- 多样性：同一仓库 ≤2 个 skill、同一 owner ≤2 条。
- 排序：`score desc → v_now desc → total_stars desc → fullName asc`，完全确定性。
- 取前 5；不足时按「最近一次出现」从旧到新补齐并标 `repeat`（页面显示「近期已推荐」）。

## DeepSeek 解读（构建时生成）
- 端点 `https://api.deepseek.com/chat/completions`（OpenAI 兼容，可用 `DEEPSEEK_BASE_URL` 覆盖）。
- Secret：`DEEPSEEK_API_KEY`；模型 `DEEPSEEK_MODEL`（默认 `deepseek-v4-flash`，可改 `deepseek-v4-pro`）。
- `response_format: {type:'json_object'}`；提示词含 "json" 字样并给定六字段键名
  （`what/why/design/usage/insight/notes`），解析失败即留空。
- 上下文：仓库元信息 + README 前 4000 字 + SKILL.md 前 1500 字；并发 3、失败重试 1 次。
- **单条失败不阻塞发布**：该条留空，榜单照常上线。

## 页面
深色主题、内容区最大 1200px、CSS grid `auto-fit` 双栏回落单栏、无 JS。
5 张卡片含：排名、skill 名与仓库外链、总 star、近 9 周新增 star 的内联 SVG 迷你条形图、
周增星、「爆发中」/「近期已推荐」徽章、topics、描述、更新时间、六段中文解读、
`<details>` 折叠 SKILL.md 预览。顶部「数据时间（上海时区）」一眼看出是否过期。
`index.html` 底部列最近 60 天归档；全站 `noindex,nofollow` + `robots.txt` Disallow。

## CLI
`node scripts/build.mjs [--dry-run] [--limit N] [--date YYYY-MM-DD] [--no-llm] [--raw-star-history owner/repo]`
- `--dry-run`：打印榜单与 score 明细，不写文件、不调 LLM
- `--date`：补生成指定日期（只写该日归档与数据，不覆盖 index）
- `--raw-star-history`：打印某仓库 `/stargazers/history` 原始响应，用于排查字段

## 部署
1. 建 public 仓库，推送本目录代码。
2. Settings → Pages → Source: `main` / `/docs`。
3. Settings → Secrets and variables → Actions：新建 secret `DEEPSEEK_API_KEY`（可选加
   variable `DEEPSEEK_MODEL` / `DEEPSEEK_BASE_URL`）。
4. Actions 页手动 Run 一次 `skillradar` 生成首份榜单。
之后浏览器打开 `https://<用户名>.github.io/<仓库名>/`。

## 测试
`node --test scripts/build.test.mjs`（离线、零依赖）覆盖：
- 残缺当前周剔除（含周一新周起点）；`/stargazers/history` 的 unix `week`+`total` 适配；多种字段名组合；空/单桶安全
- 归一化打分（小仓库更高分）；burst 3× 临界两侧；vNow/baseline 为 0 无 NaN
- 30 天冷却按日期过滤（跨月）；burst 豁免；同仓库 ≤2 / 同 owner ≤2；不足补齐标 `repeat`；
  同一输入两次输出一致
- 发现过滤：claude-only / MCP / agent-framework 排除、种子与 codex 信号放行；
  缺 name/description 的 SKILL.md 被跳过
- LLM：假响应六字段解析、失败留空不阻塞；UTC 周日 23:00 → 上海周一（含跨月跨年）

## 假设
- 数据源接口：`GET /repos/{owner}/{repo}/stargazers/history`（2026-09-04 上线，privacy-safe）。
  每条：`week`=周起始 Unix 秒、`total`=该周新增 star、`days`=周内每日分布。最新在前；
  不带 auth 也可调（公开仓库），Actions 用 `GITHUB_TOKEN`；422 视为无数据跳过，404 跳过。
  周界不保证与 UTC 对齐：我们用 `week` 转日期并按「今天是否落在该桶区间」判残缺当前周。
- `GITHUB_TOKEN` 足以调用 `/stargazers/history`、code search 与仓库元数据；若 401/403，回退为加零 scope PAT。
- 仓库必须 public（Pages + Actions 定时任务稳定）；站点公开但 noindex。
- 大陆网络访问 `*.github.io` 可能需代理，由桌面端自行解决。
