import { describe, expect, it } from 'vitest';
import { compareAB, exportCompare, exportGenerate, generateAll, planCalls, type Llm } from './flow';
import { readSheets } from './xlsx';

type Msg = Parameters<Llm>[0];

/** 假大模型：生成请求按平台名返回标题；打分请求按标题里的关键词给分（含「最」的风险高） */
function fakeLlm(log: string[], opts: { dropFirst?: boolean; failPlatform?: string } = {}): Llm {
  let dropped = false;
  return async (m: Msg) => {
    const u = m[1].content;
    log.push(u);
    const platform = u.match(/^平台：(\S+)/m)?.[1] ?? '';
    if (u.includes('"titles"')) {
      if (opts.failPlatform && platform === opts.failPlatform) return '抱歉，我不能回答';
      const n = Number(u.match(/写 (\d+) 个/)![1]);
      return '```json\n' + JSON.stringify({ titles: Array.from({ length: n }, (_, i) => `${platform}标题${i + 1}${i === 0 ? '最好用' : ''}`) }) + '\n```';
    }
    const items = [...u.matchAll(/^\[(\d+)\](?:（[AB] 组）)? (.+)$/gm)].map(([, id, t]) => ({ id: Number(id), t }));
    const results = items
      .filter((x) => !(opts.dropFirst && !dropped && x.id === 1))
      .map((x) => ({ id: x.id, attract: /最/.test(x.t) ? 9 : 6, clarity: 7, risk: /最/.test(x.t) ? 8 : 1, reason: `评${x.t}`, riskNote: /最/.test(x.t) ? '绝对化用语' : '' }));
    if (opts.dropFirst) dropped = true;
    return JSON.stringify({ results, ...(u.includes('"summary"') ? { summary: 'B 组更稳' } : {}) });
  };
}

describe('批量生成并打分', () => {
  it('每个选题 × 平台：生成 1 次 + 每 15 个打分 1 次', async () => {
    const log: string[] = [];
    const progress: string[] = [];
    const r = await generateAll({ topics: ['早餐', '露营'], platforms: ['mp', 'xhs'], count: 16, extra: '', limit: 0 }, fakeLlm(log), (d, t) => progress.push(`${d}/${t}`));
    expect(planCalls({ topics: ['早餐', '露营'], platforms: ['mp', 'xhs'], count: 16 })).toBe(12);
    expect(r.calls).toBe(12);
    expect(log).toHaveLength(12);
    expect(r.list).toHaveLength(64);
    expect(progress).toEqual(['1/4', '2/4', '3/4', '4/4']);
    // 组内按综合分排序：普通标题 6/7/1 → 7.2，排在带「最」的 9/7/8 → 6.3 前面
    const first = r.list.filter((x) => x.topic === '早餐' && x.platform === 'mp');
    expect(first[0]).toMatchObject({ attract: 6, clarity: 7, risk: 1, total: 7.2 });
    expect(first.at(-1)).toMatchObject({ title: '公众号标题1最好用', risk: 8, riskNote: '绝对化用语' });
    expect(log[0]).toContain('不超过 32 个字');
    expect(log[2]).not.toContain('不超过');
  });

  it('漏掉的条目单独补一次', async () => {
    const log: string[] = [];
    const r = await generateAll({ topics: ['早餐'], platforms: ['douyin'], count: 3, extra: '', limit: 0 }, fakeLlm(log, { dropFirst: true }));
    expect(r.calls).toBe(3);
    expect(r.list.every((x) => !x.missing)).toBe(true);
    expect(log[2]).toMatch(/^\[1\] 抖音标题1最好用$/m);
  });

  it('某个平台失败不影响其他平台，并记下原因', async () => {
    const r = await generateAll({ topics: ['早餐'], platforms: ['mp', 'bili'], count: 3, extra: '', limit: 0 }, fakeLlm([], { failPlatform: 'B' }));
    expect(r.list.map((x) => x.platform)).toEqual(['mp', 'mp', 'mp']);
    expect(r.failures).toEqual(['「早餐」· B 站：大模型没有返回标题']);
  });

  it('没设置大模型这类错误直接停下', async () => {
    const llm: Llm = async () => { throw new Error('还没有设置大模型：请到「设置」里填写'); };
    await expect(generateAll({ topics: ['早餐'], platforms: ['mp', 'xhs'], count: 3, extra: '', limit: 0 }, llm)).rejects.toThrow('还没有设置大模型');
  });

  it('输入为空时提示', async () => {
    await expect(generateAll({ topics: [], platforms: ['mp'], count: 3, extra: '', limit: 0 }, fakeLlm([]))).rejects.toThrow('先写一个选题');
    await expect(generateAll({ topics: ['a'], platforms: [], count: 3, extra: '', limit: 0 }, fakeLlm([]))).rejects.toThrow('至少选一个平台');
  });
});

describe('A/B 对比', () => {
  it('两组一次调用打分，判出胜负并带点评', async () => {
    const log: string[] = [];
    const r = await compareAB({ a: ['全网最省时的早餐', '早餐指南'], b: ['一口锅做五天早餐', '15 分钟早餐'], platform: 'xhs', topic: '早餐' }, fakeLlm(log));
    expect(r.calls).toBe(1);
    expect(log[0]).toContain('[3]（B 组） 一口锅做五天早餐');
    expect(r.winner).toBe('B');
    expect(r.summary).toBe('B 组更稳');
    expect(r.statsA).toMatchObject({ count: 2, highRisk: 1 });
    expect(r.statsB).toMatchObject({ count: 2, total: 7.2, highRisk: 0 });
  });
  it('某组为空或超过 30 条时提示', async () => {
    await expect(compareAB({ a: ['x'], b: [], platform: 'mp', topic: '' }, fakeLlm([]))).rejects.toThrow('两组都至少要有一个标题');
    await expect(compareAB({ a: Array.from({ length: 31 }, (_, i) => `t${i}`), b: ['y'], platform: 'mp', topic: '' }, fakeLlm([]))).rejects.toThrow('每组最多 30 个');
  });
});

describe('导出 Excel', () => {
  const io = (files: Map<string, Uint8Array>) => ({ join: async (...p: string[]) => p.join('/'), writeFile: async (p: string, d: Uint8Array) => void files.set(p, d) });
  const now = new Date(2026, 9, 23, 9, 15);

  it('候选标题导出到保存位置，文件名带时间', async () => {
    const files = new Map<string, Uint8Array>();
    const r = await generateAll({ topics: ['早餐'], platforms: ['mp'], count: 3, extra: '', limit: 0 }, fakeLlm([]));
    const path = await exportGenerate(io(files), '/out', now, r.list, 0);
    expect(path).toBe('/out/候选标题-20261023-0915.xlsx');
    const [sheet] = await readSheets(files.get(path)!, 'x.xlsx');
    expect(sheet.name).toBe('候选标题');
    expect(sheet.grid[0].slice(0, 4)).toEqual(['排名', '平台', '选题', '标题']);
    expect(sheet.grid).toHaveLength(4);
    expect(sheet.grid[3].slice(3, 10)).toEqual(['公众号标题1最好用', 9, 9, 7, 8, '高', 6.3]);
  });

  it('A/B 对比导出两张表', async () => {
    const files = new Map<string, Uint8Array>();
    const r = await compareAB({ a: ['全网最省时的早餐'], b: ['一口锅做五天早餐'], platform: 'mp', topic: '' }, fakeLlm([]));
    const path = await exportCompare(io(files), '/out', now, r, 0);
    expect(path).toBe('/out/标题AB对比-20261023-0915.xlsx');
    const sheets = await readSheets(files.get(path)!, 'x.xlsx');
    expect(sheets.map((s) => s.name)).toEqual(['A／B 对比', '逐条打分']);
    expect(sheets[0].grid.flat()).toContain('大模型点评');
    expect(sheets[1].grid.map((row) => row[1])).toEqual(['组别', 'A', 'B']);
  });

  it('没有保存位置时报错', async () => {
    await expect(exportGenerate(io(new Map()), '', now, [], 0)).rejects.toThrow('还没有选择保存位置');
  });
});
