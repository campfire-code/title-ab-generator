import { describe, expect, it } from 'vitest';
import {
  PLATFORMS, buildGenerateMessages, buildScoreMessages, byTotal, compareSheets, effectiveLimit, generateSheets, groupStats, overall, parseAbText,
  parseScores, parseTitles, pickWinner, platformOf, riskLevel, splitTitles, stamp, titleLength, toScored, winnerText, type Scored,
} from './core';
import { readPrefs } from './prefs';
import { SAMPLE_COMPARE, SAMPLE_LIST } from './sample';

const sc = (title: string, attract: number, clarity: number, risk: number, platform = 'mp', topic = '早餐'): Scored => toScored(title, platform, topic, { attract, clarity, risk, reason: 'r', riskNote: '' });

describe('平台与字数', () => {
  it('五个平台齐全，只有公众号预设了核实过的 32 字上限', () => {
    expect(PLATFORMS.map((p) => p.name)).toEqual(['公众号', '小红书', '抖音', '视频号', 'B 站']);
    expect(PLATFORMS.filter((p) => p.limit > 0).map((p) => [p.id, p.limit])).toEqual([['mp', 32]]);
    expect(platformOf('xxx').id).toBe('mp');
  });
  it('字数按字符算，表情算 1 个；用户填的上限优先', () => {
    expect(titleLength('早餐🍳ab，')).toBe(6);
    expect(effectiveLimit(platformOf('xhs'), 0)).toBe(0);
    expect(effectiveLimit(platformOf('mp'), 0)).toBe(32);
    expect(effectiveLimit(platformOf('xhs'), 20)).toBe(20);
  });
});

describe('拆分标题', () => {
  it('去编号、项目符号、引号、空行和重复', () => {
    expect(splitTitles('1. 标题一\n- 标题二\n\n「标题三」\n标题一\n（4）标题四')).toEqual(['标题一', '标题二', '标题三', '标题四']);
    expect(splitTitles('a\nb\nc', 2)).toEqual(['a', 'b']);
  });
  it('A/B 文本：按「A组」「B组」分组', () => {
    expect(parseAbText('A组：\n标题1\n标题2\n\nB 组\n标题3')).toEqual({ a: ['标题1', '标题2'], b: ['标题3'] });
    expect(parseAbText('【A】\nx\n【B】\ny')).toEqual({ a: ['x'], b: ['y'] });
  });
  it('A/B 文本：用 --- 隔开；没有分隔时只有 A 组', () => {
    expect(parseAbText('x\ny\n---\nz')).toEqual({ a: ['x', 'y'], b: ['z'] });
    expect(parseAbText('x\ny')).toEqual({ a: ['x', 'y'], b: [] });
  });
});

describe('提示词', () => {
  it('生成：带平台风格、数量、字数上限和补充要求', () => {
    const m = buildGenerateMessages({ topic: '露营装备', platform: platformOf('bili'), count: 5, extra: '面向新手', limit: 30 });
    const u = m[1].content;
    expect(u).toContain('平台：B 站');
    expect(u).toContain('写 5 个');
    expect(u).toContain('不超过 30 个字');
    expect(u).toContain('补充要求：面向新手');
    expect(buildGenerateMessages({ topic: 't', platform: platformOf('xhs'), count: 3, extra: ' ', limit: 0 })[1].content).not.toMatch(/不超过 \d+ 个字|补充要求/);
  });
  it('打分：逐条带编号；对比时带组别并要求 summary', () => {
    const u = buildScoreMessages([{ id: 1, title: '甲', group: 'A' }, { id: 2, title: '乙', group: 'B' }], platformOf('douyin'), '', true)[1].content;
    expect(u).toContain('[1]（A 组） 甲');
    expect(u).toContain('[2]（B 组） 乙');
    expect(u).toContain('"summary"');
    expect(u).not.toContain('内容主题');
    expect(buildScoreMessages([{ id: 1, title: '甲' }], platformOf('mp'), '早餐')[1].content).toContain('内容主题：早餐');
  });
});

describe('解析回复', () => {
  it('标题：兼容代码块、对象数组和纯文本', () => {
    expect(parseTitles('```json\n{"titles":["一","二","一"]}\n```', 10)).toEqual(['一', '二']);
    expect(parseTitles('[{"title":"甲"},{"标题":"乙"}]', 10)).toEqual(['甲', '乙']);
    expect(parseTitles('好的：\n1. 第一个\n2. 第二个\n3. 第三个', 2)).toEqual(['第一个', '第二个']);
  });
  it('打分：按 id 对应，分数夹到 0～10，缺项的丢弃，读出 summary', () => {
    const r = parseScores('结果如下 {"results":[{"id":2,"attract":"8分","clarity":12,"risk":-1,"reason":"好","riskNote":""},{"id":1,"吸引力":5,"清晰度":6,"合规风险":7,"理由":"一般","风险提示":"绝对化"},{"id":3,"attract":5}],"summary":"B 更好"}', 3);
    expect(r.summary).toBe('B 更好');
    expect(r.scores.get(2)).toEqual({ attract: 8, clarity: 10, risk: 0, reason: '好', riskNote: '' });
    expect(r.scores.get(1)).toMatchObject({ attract: 5, clarity: 6, risk: 7, riskNote: '绝对化' });
    expect(r.scores.has(3)).toBe(false);
  });
  it('打分：超出范围的 id 和重复 id 忽略', () => {
    const r = parseScores('{"results":[{"id":9,"attract":1,"clarity":1,"risk":1},{"id":1,"attract":1,"clarity":1,"risk":1},{"id":1,"attract":9,"clarity":9,"risk":9}]}', 2);
    expect([...r.scores.keys()]).toEqual([1]);
    expect(r.scores.get(1)!.attract).toBe(1);
  });
  it('不是 JSON 时报错', () => {
    expect(() => parseScores('我不会', 1)).toThrow('不是有效的 JSON');
  });
});

describe('打分汇总', () => {
  it('综合分 = 吸引力 40% + 清晰度 30% + (10-风险) 30%', () => {
    expect(overall({ attract: 8, clarity: 8, risk: 1 })).toBe(8.3);
    expect(overall({ attract: 10, clarity: 10, risk: 0 })).toBe(10);
    expect(riskLevel(7)).toBe('高');
    expect(riskLevel(4)).toBe('中');
    expect(riskLevel(3)).toBe('低');
  });
  it('排序：综合分高的在前，缺分数的排最后', () => {
    const list = [sc('低', 3, 3, 5), toScored('缺', 'mp', 't', undefined), sc('高', 9, 9, 0)].sort(byTotal);
    expect(list.map((x) => x.title)).toEqual(['高', '低', '缺']);
  });
  it('组统计与胜负：差距不到 0.3 算持平', () => {
    const a = groupStats([sc('a1', 8, 8, 1), sc('a2', 8, 5, 8), toScored('缺', 'mp', 't', undefined)]);
    expect(a).toMatchObject({ count: 2, attract: 8, clarity: 6.5, risk: 4.5, highRisk: 1 });
    expect(a.best!.title).toBe('a1');
    const b = groupStats([sc('b1', 9, 9, 0)]);
    expect(pickWinner(a, b)).toBe('B');
    expect(winnerText('B', a, b)).toBe(`B 组更好：平均综合分 9.3，比另一组高 ${Math.round((9.3 - a.total) * 10) / 10} 分`);
    expect(pickWinner(b, groupStats([sc('c', 9, 9, 0.5)]))).toBe('tie');
    expect(pickWinner(groupStats([]), b)).toBe('B');
  });
  it('示例数据：B 组胜出', () => {
    expect(SAMPLE_COMPARE.winner).toBe('B');
    expect(SAMPLE_LIST.every((x) => x.total > 0)).toBe(true);
  });
});

describe('导出表格', () => {
  it('候选标题：按选题和平台分组排名，超字数和高风险标红', () => {
    const list = [sc('短', 5, 5, 1, 'xhs'), sc('这是一个特别特别长的标题啊', 9, 9, 8, 'xhs'), sc('公众号标题', 7, 7, 0, 'mp')];
    const [sheet] = generateSheets(list, () => 10);
    expect(sheet.rows.map((r) => [r[0], r[1], r[3]])).toEqual([[1, '公众号', '公众号标题'], [1, '小红书', '这是一个特别特别长的标题啊'], [2, '小红书', '短']]);
    expect(sheet.rows[1][12]).toBe('超过 10 字');
    expect([...sheet.red!].sort()).toEqual(['1,4', '1,7']);
  });
  it('A/B 对比：汇总页 + 逐条页，B 组的标红行号接在 A 组后面', () => {
    const r = { ...SAMPLE_COMPARE, b: [...SAMPLE_COMPARE.b, sc('全网最好用的方法', 8, 6, 9)] };
    const [sum, detail] = compareSheets(r, () => 0);
    expect(sum.rows[0].slice(0, 2)).toEqual(['A 组', 3]);
    expect(sum.rows[3]).toEqual(['结论', expect.stringContaining('B 组更好')]);
    expect(detail.header[1]).toBe('组别');
    expect(detail.rows).toHaveLength(7);
    // A 组排序后「全网最省时…」风险 8 在第 3 行（下标 2），B 组新增那条排第 4（下标 3+3=6）
    expect([...detail.red!].sort()).toEqual(['2,8', '6,8']);
  });
  it('时间戳', () => {
    expect(stamp(new Date(2026, 9, 3, 9, 5))).toBe('20261003-0905');
  });
});

describe('偏好设置', () => {
  const fb = { platforms: ['mp'], count: 6, extra: '', limit: 0, outDir: '', abPlatform: 'mp' };
  it('坏数据逐项兜底', () => {
    expect(readPrefs(null, fb)).toEqual(fb);
    expect(readPrefs({ platforms: ['xhs', 'zzz', 3], count: 99, limit: -5, extra: 1, outDir: '/d', abPlatform: 'nope' }, fb)).toEqual({ platforms: ['xhs'], count: 20, extra: '', limit: 0, outDir: '/d', abPlatform: 'mp' });
    expect(readPrefs({ platforms: [] }, fb).platforms).toEqual(['mp']);
  });
});
