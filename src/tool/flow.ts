// 流程：批量生成并打分、A/B 两组对比、导出 Excel。大模型和文件读写都从外面传进来，方便用假函数测试。
import type { RunContext } from '../kit/types';
import { errText, isFatalLlmError, safeName } from './common';
import {
  PLATFORMS, buildGenerateMessages, buildScoreMessages, byTotal, compareSheets, effectiveLimit, generateSheets, groupStats, parseScores, parseTitles,
  pickWinner, platformOf, stamp, toScored, type CompareResult, type Score, type ScoreItem, type Scored,
} from './core';
import { writeXlsx } from './xlsx';

export type Llm = RunContext['llm'];
export type Io = Pick<RunContext, 'join' | 'writeFile'>;

/** 每次打分最多放多少条标题 */
export const SCORE_BATCH = 15;
export const MAX_TOPICS = 10;
export const MAX_GROUP = 30;

/** 打分：分批调用，漏掉的再补一次；返回 id → 分数、点评和调用次数 */
async function scoreItems(items: ScoreItem[], platformId: string, topic: string, llm: Llm, compare: boolean, count: () => void): Promise<{ scores: Map<number, Score>; summary: string }> {
  const platform = platformOf(platformId);
  const scores = new Map<number, Score>();
  let summary = '';
  // 对比时两组放进同一次调用，保证打分尺度一致（每组最多 30 条，合计不超过 60 条）
  const batches: ScoreItem[][] = [];
  const size = compare ? items.length : SCORE_BATCH;
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  let lastErr: unknown;
  for (const batch of batches) {
    let pending = batch;
    for (let attempt = 0; attempt < 2 && pending.length; attempt++) {
      try {
        count();
        // 用 1..n 的局部编号发给模型，减少编号错乱
        const local = pending.map((x, i) => ({ ...x, id: i + 1 }));
        const r = parseScores(await llm(buildScoreMessages(local, platform, topic, compare && attempt === 0), { json: true, temperature: 0.2 }), local.length);
        pending.forEach((x, i) => { const s = r.scores.get(i + 1); if (s) scores.set(x.id, s); });
        if (r.summary && !summary) summary = r.summary;
        pending = pending.filter((x) => !scores.has(x.id));
      } catch (e) {
        if (isFatalLlmError(e)) throw e;
        lastErr = e;
      }
    }
  }
  if (!scores.size && lastErr) throw lastErr;
  return { scores, summary };
}

export interface GenInput {
  topics: string[];
  platforms: string[];
  count: number;
  extra: string;
  /** 用户填的字数上限，0 = 按平台（只有核实过的平台才有） */
  limit: number;
}

export interface GenOutput {
  list: Scored[];
  calls: number;
  /** 某个选题 × 平台失败的说明 */
  failures: string[];
}

export function planCalls(input: Pick<GenInput, 'topics' | 'platforms' | 'count'>) {
  return input.topics.length * input.platforms.length * (1 + Math.ceil(input.count / SCORE_BATCH));
}

export async function generateAll(input: GenInput, llm: Llm, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<GenOutput> {
  if (!input.topics.length) throw new Error('先写一个选题');
  if (!input.platforms.length) throw new Error('至少选一个平台');
  const jobs = input.topics.flatMap((topic) => input.platforms.map((platform) => ({ topic, platform })));
  const list: Scored[] = [];
  const failures: string[] = [];
  let calls = 0;
  let done = 0;
  for (const job of jobs) {
    if (signal?.aborted) throw new Error('已停止');
    const platform = platformOf(job.platform);
    const limit = effectiveLimit(platform, input.limit);
    try {
      calls++;
      const titles = parseTitles(await llm(buildGenerateMessages({ topic: job.topic, platform, count: input.count, extra: input.extra, limit }), { temperature: 0.9 }), input.count);
      if (!titles.length) throw new Error('大模型没有返回标题');
      const items = titles.map((title, i) => ({ id: i + 1, title }));
      const { scores } = await scoreItems(items, job.platform, job.topic, llm, false, () => calls++);
      list.push(...items.map((x) => toScored(x.title, job.platform, job.topic, scores.get(x.id))).sort(byTotal));
    } catch (e) {
      if (isFatalLlmError(e)) throw e;
      failures.push(`「${job.topic.slice(0, 12)}」· ${platform.name}：${errText(e).slice(0, 60)}`);
    }
    onProgress?.(++done, jobs.length);
  }
  if (!list.length) throw new Error(`全部失败：${failures[0] ?? '没有结果'}`);
  return { list, calls, failures };
}

export interface CompareInput {
  a: string[];
  b: string[];
  platform: string;
  topic: string;
}

export async function compareAB(input: CompareInput, llm: Llm): Promise<CompareResult & { calls: number }> {
  if (!input.a.length || !input.b.length) throw new Error('A、B 两组都至少要有一个标题');
  if (input.a.length > MAX_GROUP || input.b.length > MAX_GROUP) throw new Error(`每组最多 ${MAX_GROUP} 个标题`);
  const items: ScoreItem[] = [
    ...input.a.map((title, i) => ({ id: i + 1, title, group: 'A' as const })),
    ...input.b.map((title, i) => ({ id: input.a.length + i + 1, title, group: 'B' as const })),
  ];
  let calls = 0;
  const { scores, summary } = await scoreItems(items, input.platform, input.topic, llm, true, () => calls++);
  const a = items.filter((x) => x.group === 'A').map((x) => toScored(x.title, input.platform, input.topic, scores.get(x.id)));
  const b = items.filter((x) => x.group === 'B').map((x) => toScored(x.title, input.platform, input.topic, scores.get(x.id)));
  const statsA = groupStats(a);
  const statsB = groupStats(b);
  return { platform: input.platform, topic: input.topic, a, b, statsA, statsB, winner: pickWinner(statsA, statsB), summary, calls };
}

/** 每个平台生效的字数上限 */
export const limitFn = (userLimit: number) => (platform: string) => effectiveLimit(platformOf(platform), userLimit);

export async function exportGenerate(io: Io, dir: string, now: Date, list: Scored[], userLimit: number): Promise<string> {
  if (!dir) throw new Error('还没有选择保存位置');
  if (!list.length) throw new Error('没有可以导出的标题');
  const path = await io.join(dir, `${safeName(`候选标题-${stamp(now)}`)}.xlsx`);
  await io.writeFile(path, await writeXlsx(generateSheets(list, limitFn(userLimit)), '篝火 · 爆款标题 A/B 生成'));
  return path;
}

export async function exportCompare(io: Io, dir: string, now: Date, r: CompareResult, userLimit: number): Promise<string> {
  if (!dir) throw new Error('还没有选择保存位置');
  // check-zh: 忽略（导出文件名，不改）
  const path = await io.join(dir, `${safeName(`标题AB对比-${stamp(now)}`)}.xlsx`);
  await io.writeFile(path, await writeXlsx(compareSheets(r, limitFn(userLimit)), '篝火 · 爆款标题 A/B 生成'));
  return path;
}

export const ALL_PLATFORM_IDS = PLATFORMS.map((p) => p.id);
