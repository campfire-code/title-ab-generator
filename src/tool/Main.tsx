// 主界面：「批量出标题」按选题 × 平台生成候选并打分；「A/B 对比」给两组标题打分并比较。都可导出 Excel。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileText, FolderOpen, Scale, Sparkles, Trophy, X } from 'lucide-react';
import type { CustomTool } from '../kit/types';
import { CopyButton, useDroppedFiles } from '../kit/parts';
import { defaultOutputDir, openFolder, pickFiles, pickFolder, reveal, settingsStore } from '../kit/platform';
import { PLATFORMS, byTotal, parseAbText, platformOf, riskLevel, splitTitles, titleLength, winnerText, type CompareResult, type Scored } from './core';
import { MAX_GROUP, MAX_TOPICS, compareAB, exportCompare, exportGenerate, generateAll, limitFn, planCalls } from './flow';
import { PREFS_KEY, readPrefs, type Prefs } from './prefs';
import { SAMPLE_A, SAMPLE_B, SAMPLE_COMPARE, SAMPLE_LIST, SAMPLE_TOPICS } from './sample';
import './tool.css';

type Ctx = Parameters<CustomTool['Main']>[0]['ctx'];
type Tab = 'gen' | 'ab';
type Msg = { kind: 'ok' | 'err'; text: string; path?: string } | null;
const TOOL_NAME = '爆款标题 A／B 生成';
const DEFAULTS: Prefs = { platforms: ['mp', 'xhs', 'douyin'], count: 6, extra: '', limit: 0, outDir: '', abPlatform: 'mp' };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Bar({ v, kind }: { v: number; kind?: 'risk' }) {
  const lv = kind === 'risk' ? riskLevel(v) : '';
  return (
    <span className={`ta-bar${kind ? ' risk' : ''}${lv === '高' ? ' hi' : lv === '中' ? ' mid' : ''}`} title={kind ? `合规风险 ${v}（${lv}）` : String(v)}>
      <i><s style={{ width: `${v * 10}%` }} /></i><b className="k-num">{v}</b>
    </span>
  );
}

function ScoreTable({ list, limitOf, showPlatform }: { list: Scored[]; limitOf: (p: string) => number; showPlatform?: boolean }) {
  return (
    <div className="k-table-wrap ta-table-wrap">
      <table className="k-table ta-table">
        <thead>
          <tr>
            <th>标题</th><th>三项评分</th><th>综合</th><th>理由</th><th aria-label="复制" />
          </tr>
        </thead>
        <tbody>
          {list.map((x, i) => {
            const len = titleLength(x.title);
            const lim = limitOf(x.platform);
            return (
              <tr key={i} className={x.missing ? 'ta-missing' : ''}>
                <td className="ta-title">
                  <span>{x.title}</span>
                  <small>{showPlatform && <em className="ta-pf">{platformOf(x.platform).name}</em>}<i className={`k-num ${lim && len > lim ? 'ta-over' : 'k-muted'}`}>{len} 字{lim && len > lim ? `，超过 ${lim} 字` : ''}</i></small>
                </td>
                {x.missing ? <td colSpan={2} className="k-muted">—</td> : <>
                  <td><div className="ta-scores"><span>吸引力</span><Bar v={x.attract} /><span>清晰度</span><Bar v={x.clarity} /><span>风险</span><Bar v={x.risk} kind="risk" /></div></td>
                  <td><b className="ta-total k-num">{x.total.toFixed(1)}</b></td>
                </>}
                <td className="ta-reason">
                  {x.reason}
                  {x.riskNote && <span className="ta-risknote">风险：{x.riskNote}</span>}
                </td>
                <td><CopyButton text={x.title} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Main({ ctx }: { ctx?: Ctx }) {
  const [tab, setTab] = useState<Tab>('gen');
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [defaultDir, setDefaultDir] = useState('');
  const loaded = useRef(false);
  const [topics, setTopics] = useState(SAMPLE_TOPICS);
  const [gen, setGen] = useState<{ list: Scored[]; example: boolean; calls?: number; failures?: string[] }>({ list: SAMPLE_LIST, example: true });
  const [filter, setFilter] = useState('all');
  const [topicFilter, setTopicFilter] = useState('all');
  const [textA, setTextA] = useState(SAMPLE_A);
  const [textB, setTextB] = useState(SAMPLE_B);
  const [abTopic, setAbTopic] = useState('');
  const [ab, setAb] = useState<{ r: CompareResult; example: boolean }>({ r: SAMPLE_COMPARE, example: true });
  const [busy, setBusy] = useState<'' | 'gen' | 'ab' | 'export'>('');
  const [progress, setProgress] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const stop = useRef<AbortController | null>(null);

  useEffect(() => {
    (async () => {
      try { setPrefs(readPrefs(await (await settingsStore()).get(PREFS_KEY), DEFAULTS)); } catch { /* 预览页或首次打开：用默认值 */ }
      try { setDefaultDir((await defaultOutputDir(TOOL_NAME)) || ''); } catch { /* 预览页没有本机路径 */ }
      loaded.current = true;
    })();
  }, []);
  useEffect(() => {
    if (!loaded.current) return;
    const id = setTimeout(async () => { try { await (await settingsStore()).set(PREFS_KEY, prefs); } catch { /* 预览页不保存 */ } }, 400);
    return () => clearTimeout(id);
  }, [prefs]);
  const set = (p: Partial<Prefs>) => setPrefs((o) => ({ ...o, ...p }));
  const outDir = prefs.outDir || defaultDir;
  const limitOf = useMemo(() => limitFn(prefs.limit), [prefs.limit]);

  const topicList = useMemo(() => splitTitles(topics, MAX_TOPICS + 1), [topics]);
  const listA = useMemo(() => splitTitles(textA, MAX_GROUP + 1), [textA]);
  const listB = useMemo(() => splitTitles(textB, MAX_GROUP + 1), [textB]);
  const calls = planCalls({ topics: topicList.slice(0, MAX_TOPICS), platforms: prefs.platforms, count: prefs.count });

  // 拖入 .txt：批量页当选题，对比页按「A组 / B组」或 --- 拆成两组
  const hover = useDroppedFiles((paths) => {
    const p = paths.find((x) => /\.(txt|md)$/i.test(x));
    if (p) void importText(p);
    else setMsg({ kind: 'err', text: '只支持拖入 .txt 文本文件' });
  });

  async function importText(path?: string) {
    if (!ctx) return setMsg({ kind: 'err', text: '预览模式下不能读取文件' });
    try {
      const p = path ?? (await pickFiles(['txt', 'md'], '文本文件'))[0];
      if (!p) return;
      const text = await ctx.readText(p);
      if (tab === 'gen') {
        const list = splitTitles(text, MAX_TOPICS + 1);
        if (!list.length) throw new Error('文件里没有内容');
        setTopics(list.join('\n'));
        setMsg({ kind: 'ok', text: `导入 ${Math.min(list.length, MAX_TOPICS)} 个选题${list.length > MAX_TOPICS ? `（一次最多 ${MAX_TOPICS} 个，多出的不处理）` : ''}` });
      } else {
        const g = parseAbText(text);
        if (!g.a.length && !g.b.length) throw new Error('文件里没有标题');
        setTextA(g.a.join('\n'));
        setTextB(g.b.join('\n'));
        setMsg({ kind: g.b.length ? 'ok' : 'err', text: g.b.length ? `导入 A 组 ${g.a.length} 个、B 组 ${g.b.length} 个标题` : '只找到一组标题：请用单独一行「A组」「B组」分组，或用一行 --- 隔开两组' });
      }
    } catch (e) {
      setMsg({ kind: 'err', text: `导入失败：${errText(e)}` });
    }
  }

  async function runGen() {
    if (!ctx) return setMsg({ kind: 'err', text: '预览模式下不能调用大模型' });
    const ac = new AbortController();
    stop.current = ac;
    setBusy('gen');
    setMsg(null);
    setProgress('');
    try {
      const r = await generateAll(
        { topics: topicList.slice(0, MAX_TOPICS), platforms: prefs.platforms, count: prefs.count, extra: prefs.extra, limit: prefs.limit },
        (m, o) => ctx.llm(m, o),
        (d, t) => setProgress(`${d} / ${t}`),
        ac.signal,
      );
      setGen({ list: r.list, example: false, calls: r.calls, failures: r.failures });
      setFilter('all');
      setTopicFilter('all');
      setMsg({ kind: r.failures.length ? 'err' : 'ok', text: `生成 ${r.list.length} 个标题，调用大模型 ${r.calls} 次${r.failures.length ? `；${r.failures.length} 组失败：${r.failures.join('；')}` : ''}` });
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e) });
    }
    stop.current = null;
    setBusy('');
  }

  async function runAb() {
    if (!ctx) return setMsg({ kind: 'err', text: '预览模式下不能调用大模型' });
    setBusy('ab');
    setMsg(null);
    try {
      const r = await compareAB({ a: listA, b: listB, platform: prefs.abPlatform, topic: abTopic }, (m, o) => ctx.llm(m, o));
      setAb({ r, example: false });
      setMsg({ kind: 'ok', text: `对比完成，调用大模型 ${r.calls} 次` });
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e) });
    }
    setBusy('');
  }

  async function runExport() {
    if (!ctx) return setMsg({ kind: 'err', text: '预览模式下不能导出' });
    setBusy('export');
    try {
      const path = tab === 'gen'
        ? await exportGenerate(ctx, outDir, new Date(), gen.list, prefs.limit)
        : await exportCompare(ctx, outDir, new Date(), ab.r, prefs.limit);
      setMsg({ kind: 'ok', text: `已导出 ${path}`, path });
    } catch (e) {
      setMsg({ kind: 'err', text: `导出失败：${errText(e)}` });
    }
    setBusy('');
  }

  const genTopics = [...new Set(gen.list.map((x) => x.topic))];
  const genPlatforms = PLATFORMS.filter((p) => gen.list.some((x) => x.platform === p.id));
  const shown = gen.list.filter((x) => (filter === 'all' || x.platform === filter) && (topicFilter === 'all' || x.topic === topicFilter));
  const pIdx = (id: string) => PLATFORMS.findIndex((p) => p.id === id);
  const sortedShown = [...shown].sort((a, b) => (filter === 'all' ? a.topic.localeCompare(b.topic) || pIdx(a.platform) - pIdx(b.platform) : 0) || byTotal(a, b));
  const togglePlatform = (id: string) => set({ platforms: prefs.platforms.includes(id) ? prefs.platforms.filter((x) => x !== id) : PLATFORMS.map((p) => p.id).filter((x) => x === id || prefs.platforms.includes(x)) });
  const limitHelp = prefs.limit > 0 ? `所有平台都按 ${prefs.limit} 字检查` : '填 0 时只检查公众号（32 字，依据微信开发者文档「新增草稿」接口）；其他平台的上限未核实，以平台为准，需要时自己填';

  return (
    <div className={`ta${hover ? ' ta-hover' : ''}`}>
      <div className="ta-tabs" role="tablist" aria-label="功能">
        <button role="tab" aria-selected={tab === 'gen'} className={`k-chip${tab === 'gen' ? ' on' : ''}`} onClick={() => { setTab('gen'); setMsg(null); }}><Sparkles size={14} />批量出标题</button>
        <button role="tab" aria-selected={tab === 'ab'} className={`k-chip${tab === 'ab' ? ' on' : ''}`} onClick={() => { setTab('ab'); setMsg(null); }}><Scale size={14} />A／B 对比</button>
        <span className="b-sp" />
        <button className="k-btn ta-dir" title={outDir || '选择保存位置'} onClick={async () => { const p = await pickFolder().catch(() => null); if (p) set({ outDir: p }); }}>
          <FolderOpen size={15} /><span className="k-ellipsis">{outDir ? `保存到 ${outDir}` : '选择保存位置'}</span>
        </button>
        <button className="k-btn primary" disabled={!!busy || (tab === 'gen' ? !gen.list.length : !ab.r.a.length)} onClick={runExport}><Download size={15} />{busy === 'export' ? '正在导出…' : '导出 Excel'}</button>
      </div>

      {msg && (
        <div className={`k-notice ${msg.kind}`} role={msg.kind === 'err' ? 'alert' : 'status'}>
          <span>{msg.text}</span>
          {msg.path && <><button className="k-link" onClick={() => reveal(msg.path!)}>在文件夹中显示</button><button className="k-link" onClick={() => openFolder(msg.path!)}>打开</button></>}
          <button className="k-icon-btn" aria-label="关闭提示" onClick={() => setMsg(null)}><X size={14} /></button>
        </div>
      )}

      {tab === 'gen' ? (
        <div className="ta-body">
          <section className="k-panel ta-form">
            <div className="k-field">
              <div className="ta-label-row">
                <label className="k-label" htmlFor="ta-topics">选题（一行一个，最多 {MAX_TOPICS} 个）</label>
                <button className="k-link" onClick={() => importText()}><FileText size={13} />从 txt 导入</button>
              </div>
              <textarea id="ta-topics" className="k-input k-textarea ta-topics" value={topics} onChange={(e) => setTopics(e.target.value)} placeholder={'例如：上班族 15 分钟早餐\n可以写一句话概括内容，也可以粘贴一段摘要'} />
            </div>
            <div className="k-field">
              <span className="k-label">平台风格（可多选）</span>
              <div className="ta-chips" role="group" aria-label="平台">
                {PLATFORMS.map((p) => (
                  <button key={p.id} aria-pressed={prefs.platforms.includes(p.id)} className={`k-chip${prefs.platforms.includes(p.id) ? ' on' : ''}`} onClick={() => togglePlatform(p.id)}>{p.name}</button>
                ))}
              </div>
            </div>
            <div className="ta-row2">
              <div className="k-field">
                <label className="k-label" htmlFor="ta-count">每个平台出几个</label>
                <input id="ta-count" className="k-input" type="number" min={3} max={20} value={prefs.count} onChange={(e) => set({ count: Math.max(3, Math.min(20, Number(e.target.value) || 6)) })} />
              </div>
              <div className="k-field">
                <label className="k-label" htmlFor="ta-limit">字数上限</label>
                <input id="ta-limit" className="k-input" type="number" min={0} max={200} value={prefs.limit} onChange={(e) => set({ limit: Math.max(0, Math.min(200, Number(e.target.value) || 0)) })} />
              </div>
            </div>
            <span className="k-help">{limitHelp}</span>
            <div className="k-field">
              <label className="k-label" htmlFor="ta-extra">补充要求（可不填）</label>
              <input id="ta-extra" className="k-input" value={prefs.extra} onChange={(e) => set({ extra: e.target.value })} placeholder="例如：面向宝妈；带上关键词「懒人」" />
            </div>
            <div className="k-actions">
              {busy === 'gen'
                ? <button className="k-btn" onClick={() => stop.current?.abort()}>停止（{progress || '准备中'}）</button>
                : <button className="k-btn primary" disabled={!!busy || !topicList.length || !prefs.platforms.length} onClick={runGen}><Sparkles size={15} />生成并打分</button>}
            </div>
            <span className="k-help">预计调用大模型 {calls} 次：每个选题 × 平台先生成 1 次，再按每 15 个一批打分。需要先在「设置」里填自己的大模型接口。</span>
          </section>

          <section className="ta-result">
            <div className="ta-result-hd">
              <b>候选标题</b>
              {gen.example && <span className="ta-tag">示例</span>}
              <span className="k-muted k-num">{shown.length} 个 · {filter === 'all' ? '按平台分组，组内按综合分排序' : '按综合分排序'}</span>
            </div>
            {genTopics.length > 1 && (
              <div className="ta-chips">
                {[['all', '全部选题'] as const, ...genTopics.map((t) => [t, t] as const)].map(([k, l]) => (
                  <button key={k} className={`k-chip ta-sm${topicFilter === k ? ' on' : ''}`} onClick={() => setTopicFilter(k)}><span className="k-ellipsis">{l}</span></button>
                ))}
              </div>
            )}
            <div className="ta-chips">
              {[['all', '全部平台'] as [string, string], ...genPlatforms.map((p) => [p.id, p.name] as [string, string])].map(([k, l]) => (
                <button key={k} className={`k-chip ta-sm${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>{l}</button>
              ))}
            </div>
            {gen.list.length ? <ScoreTable list={sortedShown} limitOf={limitOf} showPlatform={filter === 'all'} /> : <div className="k-empty">还没有结果</div>}
            <p className="k-help">综合分 = 吸引力 × 40% + 清晰度 × 30% + (10 − 合规风险) × 30%。分数和风险提示由大模型给出，仅供参考，不构成法律意见。</p>
          </section>
        </div>
      ) : (
        <div className="ta-body">
          <section className="k-panel ta-form">
            <div className="ta-label-row">
              <span className="k-label">两组标题（一行一个，每组最多 {MAX_GROUP} 个）</span>
              <button className="k-link" onClick={() => importText()}><FileText size={13} />从 txt 导入</button>
            </div>
            <div className="ta-ab-inputs">
              <div className="k-field">
                <label className="k-label" htmlFor="ta-a">A 组 <span className="k-muted k-num">{listA.length} 个</span></label>
                <textarea id="ta-a" className="k-input k-textarea ta-group" value={textA} onChange={(e) => setTextA(e.target.value)} placeholder="粘贴 A 组标题" />
              </div>
              <div className="k-field">
                <label className="k-label" htmlFor="ta-b">B 组 <span className="k-muted k-num">{listB.length} 个</span></label>
                <textarea id="ta-b" className="k-input k-textarea ta-group" value={textB} onChange={(e) => setTextB(e.target.value)} placeholder="粘贴 B 组标题" />
              </div>
            </div>
            <div className="k-field">
              <span className="k-label">按哪个平台评判</span>
              <div className="k-seg" role="radiogroup" aria-label="评判平台">
                {PLATFORMS.map((p) => <button key={p.id} role="radio" aria-checked={prefs.abPlatform === p.id} className={prefs.abPlatform === p.id ? 'on' : ''} onClick={() => set({ abPlatform: p.id })}>{p.name}</button>)}
              </div>
            </div>
            <div className="k-field">
              <label className="k-label" htmlFor="ta-abtopic">内容主题（可不填）</label>
              <input id="ta-abtopic" className="k-input" value={abTopic} onChange={(e) => setAbTopic(e.target.value)} placeholder="写上能让打分更准，例如：上班族早餐合集" />
            </div>
            <div className="k-actions">
              <button className="k-btn primary" disabled={!!busy || !listA.length || !listB.length || listA.length > MAX_GROUP || listB.length > MAX_GROUP} onClick={runAb}><Scale size={15} />{busy === 'ab' ? '正在打分…' : '打分并对比'}</button>
            </div>
            <span className="k-help">两组放在同一次调用里打分，尺度一致；通常调用 1 次大模型。</span>
          </section>

          <section className="ta-result">
            <div className="ta-result-hd">
              <b>对比结果</b>
              {ab.example && <span className="ta-tag">示例</span>}
              <span className="k-muted">按 {platformOf(ab.r.platform).name} 评判</span>
            </div>
            <div className="ta-vs">
              {(['A', 'B'] as const).map((g) => {
                const s = g === 'A' ? ab.r.statsA : ab.r.statsB;
                const win = ab.r.winner === g;
                return (
                  <div key={g} className={`k-panel ta-vs-card${win ? ' win' : ''}`}>
                    <div className="ta-vs-hd"><b>{g} 组</b>{win && <span className="ta-win"><Trophy size={13} />更好</span>}<span className="b-sp" /><b className="ta-big k-num">{s.total.toFixed(1)}</b></div>
                    <div className="ta-vs-rows">
                      <span>吸引力</span><Bar v={s.attract} />
                      <span>清晰度</span><Bar v={s.clarity} />
                      <span>合规风险</span><Bar v={s.risk} kind="risk" />
                    </div>
                    <span className="k-muted ta-small">{s.count} 个标题{s.highRisk ? ` · ${s.highRisk} 个高风险` : ''}</span>
                  </div>
                );
              })}
            </div>
            <div className="k-panel ta-verdict">
              <b>{winnerText(ab.r.winner, ab.r.statsA, ab.r.statsB)}</b>
              {ab.r.summary && <p>{ab.r.summary}</p>}
            </div>
            {(['A', 'B'] as const).map((g) => (
              <div key={g} className="ta-group-list">
                <b className="ta-sub">{g} 组逐条</b>
                <ScoreTable list={[...(g === 'A' ? ab.r.a : ab.r.b)].sort(byTotal)} limitOf={limitOf} />
              </div>
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
