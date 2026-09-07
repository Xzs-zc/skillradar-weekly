// 离线测试：node --test scripts/build.test.mjs（零依赖、零网络）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shanghaiDate, addDays, normalizeStarHistory, dropIncompleteWeek, calcStats,
  parseSkillFrontmatter, skillRepoEligible, dataFilesWithinDays, pickTopEntities,
  parseLlmJson, interpretItems, DEFAULT_LIMIT, COOLDOWN_DAYS,
} from './build.mjs';

// ---------- 日期：UTC 周日 23:00 = 上海周一 07:00 ----------
test('shanghaiDate：UTC 周日 23:00 落到上海周一（含跨月跨年）', () => {
  assert.equal(shanghaiDate(Date.parse('2026-08-30T23:00:00Z')), '2026-08-31');
  assert.equal(shanghaiDate(Date.parse('2026-12-31T23:00:00Z')), '2027-01-01');
  assert.equal(shanghaiDate(Date.parse('2026-08-31T16:00:00Z')), '2026-09-01');
});
test('addDays 跨月正确', () => {
  assert.equal(addDays('2026-03-01', -30), '2026-01-30');
  assert.equal(addDays('2026-01-01', 31), '2026-02-01');
});

// ---------- star-history 归一化：三种字段组合 ----------
test('normalizeStarHistory 兼容三种字段名并统一为最新在前', () => {
  const a = [{ week_start: '2026-09-01', stars: 10 }, { week_start: '2026-08-25', stars: 4 }];
  const b = [{ week: '2026-09-01', stargazers_count: 10 }, { week: '2026-08-25', stargazers_count: 4 }];
  const c = [{ date: '2026-08-25', count: 4 }, { date: '2026-09-01', count: 10 }]; // 乱序输入
  for (const raw of [a, b, c]) {
    const out = normalizeStarHistory(raw);
    assert.equal(out.length, 2);
    assert.equal(out[0].weekStart, '2026-09-01');
    assert.equal(out[0].stars, 10);
  }
  assert.deepEqual(normalizeStarHistory([]), []);
  assert.equal(normalizeStarHistory([{ week_start: '2026-09-01', stars: 5 }]).length, 1);
  assert.deepEqual(normalizeStarHistory(null), []);
});

// ---------- 残缺当前周必须剔除（最隐蔽的 bug） ----------
test('dropIncompleteWeek 剔除尚未结束的当前周，保留上一完整周', () => {
  const buckets = [
    { weekStart: '2026-09-07', stars: 3 },  // 本周只过 2 天（残缺）
    { weekStart: '2026-08-31', stars: 40 }, // 上一完整周
    { weekStart: '2026-08-24', stars: 5 },
  ];
  const out = dropIncompleteWeek(buckets, '2026-09-09');
  assert.equal(out.length, 2);
  assert.equal(out[0].weekStart, '2026-08-31'); // v_now 取上一完整周
  assert.equal(out[0].stars, 40);
});
test('dropIncompleteWeek：周一（新周起点）也剔除刚开的新周', () => {
  const buckets = [
    { weekStart: '2026-09-07', stars: 0 },
    { weekStart: '2026-08-31', stars: 40 },
  ];
  const out = dropIncompleteWeek(buckets, '2026-09-07');
  assert.deepEqual(out.map((b) => b.weekStart), ['2026-08-31']);
});

// ---------- 打分 ----------
test('calcStats：同增星数下小仓库 score 更高', () => {
  const b = (n) => Array.from({ length: 9 }, (_, i) => ({ weekStart: `2026-0${1 + i}`, stars: i === 0 ? 30 : 5 }));
  const small = calcStats(b(1), 100);
  const big = calcStats(b(1), 10000);
  assert.ok(small.score > big.score);
  assert.equal(small.vNow, 30);
});
test('calcStats：burst 在 3× 基线临界两侧行为正确', () => {
  const mk = (v0, base) => {
    const buckets = [{ weekStart: '2026-09-07', stars: v0 }];
    for (let i = 1; i < 9; i++) buckets.push({ weekStart: `2026-08-${String(31 - i).padStart(2, '0')}`, stars: base });
    return calcStats(buckets, 1000);
  };
  assert.equal(mk(15, 5).burst, true);   // 15 >= 3*5
  assert.equal(mk(14, 5).burst, false);  // 14 < 15
  assert.equal(mk(4, 1).burst, false);   // v_now < 5 不爆
});
test('calcStats：vNow=0 / baseline=0 不产生 NaN/Infinity；桶不足返回 null', () => {
  const zero = [{ weekStart: '2026-09-07', stars: 0 }, { weekStart: '2026-08-31', stars: 0 }];
  const st = calcStats(zero, 0);
  assert.ok(Number.isFinite(st.score));
  assert.equal(st.vNow, 0);
  assert.equal(calcStats([{ weekStart: '2026-09-07', stars: 5 }], 100), null);
  assert.equal(calcStats([], 100), null);
});

// ---------- SKILL.md frontmatter ----------
test('parseSkillFrontmatter：缺 name 或 description 即判不合格', () => {
  assert.deepEqual(parseSkillFrontmatter('---\nname: foo\ndescription: 做某事\n---\n正文'), { name: 'foo', description: '做某事' });
  assert.equal(parseSkillFrontmatter('---\nname: foo\n---\n'), null);
  assert.equal(parseSkillFrontmatter('# 没有 frontmatter'), null);
  assert.equal(parseSkillFrontmatter(''), null);
});

// ---------- 仓库级过滤：claude-only / MCP / agent-framework 排除，种子与 codex 信号通过 ----------
test('skillRepoEligible：排除 claude-only、MCP、agent-framework；放行种子与 codex 信号', () => {
  const meta = (topics = [], extra = {}) => ({ archived: false, topics, ...extra });
  assert.equal(skillRepoEligible(meta(['claude-skills']), 'Claude Code skill。', { fromSeed: false }), false);
  assert.equal(skillRepoEligible(meta(['mcp-server']), 'codex skills add xxx', { fromSeed: false }), false);
  assert.equal(skillRepoEligible(meta(['agent-framework']), 'anything', { fromSeed: false }), false);
  assert.equal(skillRepoEligible(meta(['codex-skills']), '', { fromSeed: false }), true);
  assert.equal(skillRepoEligible(meta([]), '安装：codex skills add repo。', { fromSeed: false }), true);
  assert.equal(skillRepoEligible(meta([]), '通用描述', { fromSeed: true }), true);   // 种子放行
  assert.equal(skillRepoEligible(meta([], { archived: true }), 'codex skills add x', { fromSeed: false }), false);
});

// ---------- 冷却按日期过滤（跨月），非按文件个数 ----------
test('dataFilesWithinDays：按 30 天日期窗口过滤而非文件个数，跨月正确', () => {
  const files = ['2026-03-01.json', '2026-03-15.json', '2026-03-31.json', '2026-04-02.json', '2026-04-20.json', 'junk.json'];
  const out = dataFilesWithinDays(files, '2026-04-20', 30); // cutoff = 2026-03-21
  assert.deepEqual(out, ['2026-03-31.json', '2026-04-02.json', '2026-04-20.json']);
  assert.ok(!out.includes('2026-03-15.json'));
});

// ---------- 选择：冷却 / burst 豁免 / 多样性 / repeat 补齐 / 确定性 ----------
function ent(fullName, skillPath, { burst = false, score = 1, total = 100, v = 10, lastSeen = null } = {}) {
  return { key: `${fullName}#${skillPath}`, fullName, owner: fullName.split('/')[0],
    repo: fullName.split('/')[1], skillPath, burst, score, totalStars: total, vNow: v, lastSeen };
}
test('pickTopEntities：冷却跳过，burst 豁免；不足按冷却时长从旧到新补齐并标 repeat', () => {
  const entities = [
    ent('alpha/x', 's1', { score: 9, lastSeen: '2026-08-20' }), // seen → 冷却跳过
    ent('alpha/x', 's2', { score: 8 }),                         // 新 → 选入
    ent('beta/y', 's1', { score: 7, burst: true, lastSeen: '2026-08-20' }), // seen 但 burst 豁免
    ent('gamma/z', 's1', { score: 6, lastSeen: '2026-08-10' }), // seen → 冷却，最旧 → repeat 补齐
  ];
  const seen = new Map([['alpha/x#s1', '2026-08-20'], ['beta/y#s1', '2026-08-20'], ['gamma/z#s1', '2026-08-10']]);
  const picked = pickTopEntities(entities, { limit: 3, seen });
  assert.deepEqual(picked.map((e) => e.key), ['alpha/x#s2', 'beta/y#s1', 'gamma/z#s1']);
  assert.equal(picked[1].repeat, false); // burst 豁免非 repeat
  assert.equal(picked[1].burst, true);
  assert.equal(picked[2].repeat, true);  // 冷却补齐
});
test('pickTopEntities：同一仓库最多 2 个 skill、同一 owner 最多 2 条', () => {
  const entities = [
    ent('duo/multi', 's1', { score: 10 }),
    ent('duo/multi', 's2', { score: 9 }),
    ent('duo/multi', 's3', { score: 8 }),  // 同仓库第 3 个 → 排除
    ent('duo/multi', 's4', { score: 7 }),  // 同仓库第 4 个 → 排除
    ent('duo/other', 's1', { score: 6 }),  // owner duo 已 2 条 → 排除
    ent('solo/one', 's1', { score: 5 }),
  ];
  const picked = pickTopEntities(entities, { limit: 5 });
  assert.deepEqual(picked.map((e) => e.key), ['duo/multi#s1', 'duo/multi#s2', 'solo/one#s1']);
});
test('pickTopEntities：默认 limit 为 5、重复运行结果一致', () => {
  assert.equal(DEFAULT_LIMIT, 5);
  const entities = Array.from({ length: 8 }, (_, i) => ent(`o${i}/repo${i}`, 's', { score: 10 - i }));
  const a = pickTopEntities(entities);
  const b = pickTopEntities(entities);
  assert.equal(a.length, 5);
  assert.deepEqual(a.map((e) => e.key), b.map((e) => e.key));
  assert.equal(COOLDOWN_DAYS, 30);
});

// ---------- LLM：六字段解析 / 失败留空 / 不阻塞 ----------
test('parseLlmJson：六字段解析；非法输入返回 null', () => {
  const ok = parseLlmJson('{"what":"A","why":"B","design":"C","usage":"D","insight":"E","notes":"F"}');
  assert.deepEqual(ok, { what: 'A', why: 'B', design: 'C', usage: 'D', insight: 'E', notes: 'F' });
  const wrapped = parseLlmJson('```json\n{"what":"甲"}\n```');
  assert.equal(wrapped.what, '甲');
  assert.equal(parseLlmJson('不是 json'), null);
  assert.equal(parseLlmJson(''), null);
});
test('interpretItems：假 client 成功填充六字段；抛错条目留空不阻塞整体', async () => {
  const items = [
    { key: 'a/r#s1', name: 'one' },
    { key: 'b/r#s1', name: 'two' },
    { key: 'c/r#s1', name: 'three' },
  ];
  const client = async (it) => {
    if (it.name === 'two') throw new Error('boom');
    return JSON.stringify({ what: `what-${it.name}`, why: 'x', design: 'x', usage: 'x', insight: 'x', notes: 'x' });
  };
  const out = await interpretItems(items, { client });
  assert.equal(out[0].llm.what, 'what-one');
  assert.equal(out[1].llm, null);   // 单条失败不阻塞
  assert.equal(out[2].llm.what, 'what-three');
  const noClient = await interpretItems(items);
  assert.ok(noClient.every((it) => it.llm === null));
});
