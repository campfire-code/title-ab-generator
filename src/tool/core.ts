// 纯函数：平台风格、提示词构造、回复解析、打分汇总、A/B 两组对比、导出表格内容。
// 不依赖界面和本机能力，便于单元测试。
import { extractJson, pick, stripBullet, toStringList, type Cell } from './common';
import type { OutSheet } from './xlsx';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export interface Platform {
  id: string;
  name: string;
  /** 写给模型的风格提示：只是写法建议，不是平台规则 */
  style: string;
  /** 已核实的标题字数上限；0 表示未核实，不检查 */
  limit: number;
  /** 上限的出处（界面和 README 里展示） */
  limitSource?: string;
}

// 字数上限只写核实过的：公众号「新增草稿」接口文档写明标题总长度不超过 32 个字。
// 其他平台没有找到官方说明，不预设上限，由用户在「字数上限」里自己填。
export const PLATFORMS: Platform[] = [
  { id: 'mp', name: '公众号', limit: 32, limitSource: '微信开发者文档「新增草稿」接口：标题总长度不超过 32 个字', style: '信息量足、有观点或悬念，像一篇值得点开细读的文章；可以用数字、对比、提问，避免低俗和夸张' },
  { id: 'xhs', name: '小红书', limit: 0, style: '真实分享的口吻，有情绪和画面感，口语化，可以用一个表情符号；突出「对我有用」' },
  { id: 'douyin', name: '抖音', limit: 0, style: '短促有冲击力，前几个字就抓住注意力，口语化，适合配合视频画面；可以制造反差或悬念' },
  { id: 'channels', name: '视频号', limit: 0, style: '贴近熟人社交和中年以上人群的阅读习惯，朴实、可信、有温度，突出实用价值，避免过度网络用语' },
  { id: 'bili', name: 'B 站', limit: 0, style: '有梗、有态度，体现内容的硬核程度或趣味，可以用自嘲、玩梗、反问，标题和内容要对得上，不要标题党' },
];

export const platformOf = (id: string) => PLATFORMS.find((p) => p.id === id) ?? PLATFORMS[0];

/** 字数：每个字符（含标点、英文、表情）按 1 个算 */
export const titleLength = (s: string) => [...s].length;

/** 实际生效的上限：用户填了用用户的，否则用平台核实过的（可能是 0 = 不检查） */
export const effectiveLimit = (p: Platform, userLimit: number) => (userLimit > 0 ? userLimit : p.limit);

export interface Score {
  /** 吸引力 0～10，越高越好 */
  attract: number;
  /** 清晰度 0～10，越高越好 */
  clarity: number;
  /** 合规风险 0～10，越高风险越大 */
  risk: number;
  reason: string;
  riskNote: string;
}

export interface Scored extends Score {
  title: string;
  platform: string;
  topic: string;
  /** 综合分：吸引力 40% + 清晰度 30% + (10 - 风险) 30%，保留一位小数 */
  total: number;
  /** 大模型没给出这条的分数 */
  missing?: boolean;
}

export const overall = (s: Pick<Score, 'attract' | 'clarity' | 'risk'>) => Math.round((s.attract * 0.4 + s.clarity * 0.3 + (10 - s.risk) * 0.3) * 10) / 10;

export const riskLevel = (risk: number) => (risk >= 7 ? '高' : risk >= 4 ? '中' : '低');

const SYSTEM_WRITER = '你是资深新媒体编辑，擅长为不同平台写标题。只输出 JSON，不要任何解释。';
const SYSTEM_JUDGE = '你是严格的新媒体主编兼内容合规审核。按要求给标题打分，分数要拉开差距，理由具体。只输出 JSON。';

/** 把多行文本拆成标题列表：去掉编号和项目符号、去空行、去重 */
export function splitTitles(text: string, max = 50): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = stripBullet(line);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export interface GenRequest {
  topic: string;
  platform: Platform;
  count: number;
  /** 补充要求，例如目标人群、关键词 */
  extra: string;
  limit: number;
}

export function buildGenerateMessages(r: GenRequest): ChatMessage[] {
  const lines = [
    `平台：${r.platform.name}`,
    `平台风格：${r.platform.style}`,
    `选题 / 内容：${r.topic}`,
    r.extra.trim() ? `补充要求：${r.extra.trim()}` : '',
    r.limit > 0 ? `每个标题不超过 ${r.limit} 个字（标点、表情也算字）。` : '',
    `写 ${r.count} 个风格各不相同的候选标题，角度尽量拉开（如数字型、提问型、对比型、场景型、结果型）。`,
    '不要使用「最」「第一」「100%」「国家级」之类的绝对化用语，不要编造数据和权威背书，不要标题党。',
    '输出格式：{"titles":["标题1","标题2"]}',
  ];
  return [{ role: 'system', content: SYSTEM_WRITER }, { role: 'user', content: lines.filter(Boolean).join('\n') }];
}

/** 解析生成的标题：兼容 {"titles":[...]}、直接数组、对象数组、纯文本逐行 */
export function parseTitles(reply: string, max: number): string[] {
  let list: string[];
  try {
    const j = extractJson(reply);
    list = toStringList(Array.isArray(j) ? j : pick(j, ['titles', 'title', '标题', 'list', 'items', 'data']));
  } catch {
    // 纯文本：拒答不算标题；去掉「好的，以下是…：」这类引导语
    if (/^\s*(抱歉|对不起|很遗憾|我无法|我不能|sorry|i can['’]?t|i cannot)/i.test(reply)) return [];
    list = toStringList(reply).filter((l) => !/[:：]$/.test(l));
  }
  return splitTitles(list.join('\n'), max);
}

export interface ScoreItem {
  id: number;
  title: string;
  /** A/B 对比时的组别 */
  group?: 'A' | 'B';
}

export function buildScoreMessages(items: ScoreItem[], platform: Platform, topic: string, compare = false): ChatMessage[] {
  const lines = [
    `平台：${platform.name}（风格：${platform.style}）`,
    topic.trim() ? `内容主题：${topic.trim()}` : null,
    '给下面每个标题打三项分（0～10 的整数）：',
    '- attract 吸引力：在该平台信息流里让人想点开的程度；',
    '- clarity 清晰度：一眼看懂讲什么、对谁有用；',
    '- risk 合规风险：越高越危险。绝对化用语（最、第一、100% 等）、夸大功效、编造数据或权威背书、低俗擦边、诱导点击（标题党）、医疗或投资承诺都要扣分。没有问题给 0～2。',
    'reason 用一句话说明优缺点；riskNote 写具体风险点，没有风险写空字符串。',
    compare ? '标题分 A、B 两组，打分标准对两组完全一致。打完分后在 summary 里用 2～3 句话比较两组整体的差别、哪组更适合该平台以及原因。' : null,
    '',
    ...items.map((x) => `[${x.id}]${x.group ? `（${x.group} 组）` : ''} ${x.title}`),
    '',
    `输出格式：{"results":[{"id":1,"attract":8,"clarity":7,"risk":1,"reason":"…","riskNote":""}]${compare ? ',"summary":"…"' : ''}}`,
  ];
  return [{ role: 'system', content: SYSTEM_JUDGE }, { role: 'user', content: lines.filter((l) => l !== null).join('\n') }];
}

const clamp10 = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(10, Math.round(n)));
};

/** 解析打分：按 id 对应；缺分数的不算。返回 id → 分数，以及 summary（对比时有） */
export function parseScores(reply: string, n: number): { scores: Map<number, Score>; summary: string } {
  const j = extractJson(reply);
  const raw = Array.isArray(j) ? j : pick(j, ['results', 'scores', 'items', 'data', '结果']);
  const summary = Array.isArray(j) ? '' : String(pick(j, ['summary', 'verdict', '总结', '结论']) ?? '').trim();
  const scores = new Map<number, Score>();
  if (!Array.isArray(raw)) return { scores, summary };
  raw.forEach((x, i) => {
    const id = Number(pick(x, ['id', '编号', 'index'])) || i + 1;
    if (id < 1 || id > n || scores.has(id)) return;
    const attract = clamp10(pick(x, ['attract', 'attraction', '吸引力']));
    const clarity = clamp10(pick(x, ['clarity', '清晰度']));
    const risk = clamp10(pick(x, ['risk', 'compliance', '合规风险', '风险']));
    if (attract == null || clarity == null || risk == null) return;
    scores.set(id, {
      attract, clarity, risk,
      reason: String(pick(x, ['reason', '理由', 'comment']) ?? '').trim(),
      riskNote: String(pick(x, ['riskNote', 'risk_note', '风险提示', '风险点']) ?? '').trim(),
    });
  });
  return { scores, summary };
}

export function toScored(title: string, platform: string, topic: string, s: Score | undefined): Scored {
  if (!s) return { title, platform, topic, attract: 0, clarity: 0, risk: 0, total: 0, reason: '（大模型没有返回这条的分数，可重新生成）', riskNote: '', missing: true };
  return { title, platform, topic, ...s, total: overall(s) };
}

export const byTotal = (a: Scored, b: Scored) => Number(!!a.missing) - Number(!!b.missing) || b.total - a.total || a.risk - b.risk;

export interface GroupStats {
  count: number;
  attract: number;
  clarity: number;
  risk: number;
  total: number;
  /** 高风险（≥7）条数 */
  highRisk: number;
  best: Scored | null;
}

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);

export function groupStats(list: Scored[]): GroupStats {
  const ok = list.filter((x) => !x.missing);
  return {
    count: ok.length,
    attract: avg(ok.map((x) => x.attract)),
    clarity: avg(ok.map((x) => x.clarity)),
    risk: avg(ok.map((x) => x.risk)),
    total: avg(ok.map((x) => x.total)),
    highRisk: ok.filter((x) => x.risk >= 7).length,
    best: [...ok].sort(byTotal)[0] ?? null,
  };
}

export type Winner = 'A' | 'B' | 'tie';

/** 按平均综合分判胜负；相差不到 0.3 分算持平 */
export function pickWinner(a: GroupStats, b: GroupStats): Winner {
  if (!a.count || !b.count) return a.count ? 'A' : b.count ? 'B' : 'tie';
  const d = a.total - b.total;
  return Math.abs(d) < 0.3 ? 'tie' : d > 0 ? 'A' : 'B';
}

export function winnerText(w: Winner, a: GroupStats, b: GroupStats): string {
  if (w === 'tie') return `两组差不多（平均综合分 A ${a.total} / B ${b.total}）`;
  const [win, lose] = w === 'A' ? [a, b] : [b, a];
  return `${w} 组更好：平均综合分 ${win.total}，比另一组高 ${Math.round((win.total - lose.total) * 10) / 10} 分`;
}

/** 解析「导入两组标题」的文本：可以用「A组」「B组」单独一行做分组标题，也可以用一行 --- 分开 */
export function parseAbText(text: string): { a: string[]; b: string[] } {
  const lines = String(text ?? '').split(/\r?\n/);
  const head = (l: string) => l.trim().match(/^[【\[]?\s*([AaBb])\s*组?\s*[】\]]?\s*[:：]?\s*$/)?.[1]?.toUpperCase();
  if (lines.some((l) => head(l))) {
    const g: Record<string, string[]> = { A: [], B: [] };
    let cur = '';
    for (const l of lines) {
      const h = head(l);
      if (h) cur = h;
      else if (cur) g[cur].push(l);
    }
    return { a: splitTitles(g.A.join('\n')), b: splitTitles(g.B.join('\n')) };
  }
  const i = lines.findIndex((l) => /^\s*-{3,}\s*$/.test(l));
  if (i < 0) return { a: splitTitles(text), b: [] };
  return { a: splitTitles(lines.slice(0, i).join('\n')), b: splitTitles(lines.slice(i + 1).join('\n')) };
}

/** 文件名用的时间戳：20261023-0915 */
export function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

const HEAD = ['排名', '平台', '选题', '标题', '字数', '吸引力', '清晰度', '合规风险', '风险等级', '综合分', '理由', '风险提示', '字数提示'];

function scoredRows(list: Scored[], limitOf: (platform: string) => number, group?: string) {
  const red = new Set<string>();
  const rows: Cell[][] = list.map((x, i) => {
    const len = titleLength(x.title);
    const lim = limitOf(x.platform);
    const over = lim > 0 && len > lim;
    const row: Cell[] = [i + 1, platformOf(x.platform).name, x.topic, x.title, len, x.missing ? '' : x.attract, x.missing ? '' : x.clarity, x.missing ? '' : x.risk, x.missing ? '' : riskLevel(x.risk), x.missing ? '' : x.total, x.reason, x.riskNote, over ? `超过 ${lim} 字` : ''];
    if (group) row.splice(1, 0, group);
    const off = group ? 1 : 0;
    if (over) red.add(`${i},${4 + off}`);
    if (!x.missing && x.risk >= 7) red.add(`${i},${7 + off}`);
    return row;
  });
  return { rows, red };
}

/** 批量生成结果导出：每个选题 × 平台按综合分从高到低 */
export function generateSheets(list: Scored[], limitOf: (platform: string) => number): OutSheet[] {
  const sorted = [...list].sort((a, b) => a.topic.localeCompare(b.topic) || PLATFORMS.findIndex((p) => p.id === a.platform) - PLATFORMS.findIndex((p) => p.id === b.platform) || byTotal(a, b));
  // 排名按「选题 + 平台」分组内重新编号
  const { rows, red } = scoredRows(sorted, limitOf);
  let prev = '';
  let k = 0;
  sorted.forEach((x, i) => {
    const key = x.topic + '|' + x.platform;
    k = key === prev ? k + 1 : 1;
    prev = key;
    rows[i][0] = k;
  });
  return [{ name: '候选标题', header: HEAD, rows, red, wrap: [3, 10, 11] }];
}

export interface CompareResult {
  platform: string;
  topic: string;
  a: Scored[];
  b: Scored[];
  statsA: GroupStats;
  statsB: GroupStats;
  winner: Winner;
  summary: string;
}

export function compareSheets(r: CompareResult, limitOf: (platform: string) => number): OutSheet[] {
  const line = (name: string, s: GroupStats): Cell[] => [name, s.count, s.attract, s.clarity, s.risk, s.total, s.highRisk, s.best?.title ?? ''];
  const summary: OutSheet = {
    name: 'A／B 对比',
    header: ['组别', '标题数', '平均吸引力', '平均清晰度', '平均合规风险', '平均综合分', '高风险条数', '最佳标题'],
    rows: [
      line('A 组', r.statsA),
      line('B 组', r.statsB),
      [],
      ['结论', winnerText(r.winner, r.statsA, r.statsB)],
      ['大模型点评', r.summary || '（没有返回点评）'],
      ['平台', platformOf(r.platform).name],
      ...(r.topic ? [['主题', r.topic] as Cell[]] : []),
      ['综合分算法', '吸引力 × 40% + 清晰度 × 30% + (10 − 合规风险) × 30%'],
    ],
    plain: true,
    wrap: [1, 7],
  };
  const a = scoredRows([...r.a].sort(byTotal), limitOf, 'A');
  const b = scoredRows([...r.b].sort(byTotal), limitOf, 'B');
  const offset = a.rows.length;
  const red = new Set([...a.red, ...[...b.red].map((k) => { const [x, y] = k.split(',').map(Number); return `${x + offset},${y}`; })]);
  const head = [...HEAD];
  head.splice(1, 0, '组别');
  return [summary, { name: '逐条打分', header: head, rows: [...a.rows, ...b.rows], red, wrap: [4, 11, 12] }];
}
