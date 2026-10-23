// 内置示例：首次打开时显示的示例结果（标明「示例」），也用于截图和 samples/。内容为本工具自己编写。
import { byTotal, groupStats, overall, pickWinner, type CompareResult, type Scored } from './core';

export const SAMPLE_TOPICS = '上班族 15 分钟早餐，一周不重样';

type Raw = [platform: string, title: string, attract: number, clarity: number, risk: number, reason: string, riskNote?: string];
const T1 = '上班族 15 分钟早餐，一周不重样';
const RAW: Raw[] = [
  ['mp', '每天早起 15 分钟，我把一周早餐吃出了花样', 8, 8, 1, '有具体时间和结果，读者能代入自己的早晨'],
  ['mp', '上班族早餐指南：5 个前一晚就能备好的方法', 7, 9, 0, '信息明确、实用，吸引力略平'],
  ['mp', '别再空腹上班了！这份早餐清单请收好', 7, 7, 3, '有提醒感，但「别再」略带说教', '「请收好」偏诱导收藏，问题不大'],
  ['mp', '全网最省时的早餐做法，第一名太绝了', 8, 5, 8, '悬念强但内容不明确', '「全网最」「第一名」属于绝对化用语'],
  ['xhs', '打工人 15 分钟早餐｜一周不重样🍳', 9, 9, 0, '关键词前置，口吻贴近真实分享'],
  ['xhs', '原来早餐可以这么快！周一到周五照抄就行', 8, 8, 1, '有惊喜感，「照抄」降低门槛'],
  ['xhs', '谁懂啊，早起做饭居然比点外卖还快', 8, 6, 1, '情绪到位，但没点明是早餐合集'],
  ['xhs', '吃了一周这样的早餐，瘦了 5 斤', 9, 7, 7, '结果诱人但和选题偏离', '暗示减重功效，缺少依据，容易被判夸大'],
  ['douyin', '15 分钟搞定早餐，第三种最省事', 8, 8, 2, '数字加悬念，适合配合视频画面', '「最省事」是比较说法，风险较低'],
  ['douyin', '一口锅做五天早餐，打工人看过来', 8, 8, 0, '场景清晰，口语化'],
  ['douyin', '早餐这样做，同事都来问我要做法', 7, 6, 1, '有社交反馈，但信息量少'],
  ['douyin', '不看后悔！上班族必学的早餐神操作', 6, 5, 6, '套路感重，容易被当成标题党', '「不看后悔」「必学」属于诱导点击'],
];

export const SAMPLE_LIST: Scored[] = RAW.map(([platform, title, attract, clarity, risk, reason, riskNote = '']) => ({
  title, platform, topic: T1, attract, clarity, risk, reason, riskNote, total: overall({ attract, clarity, risk }),
})).sort((a, b) => RAW.findIndex((r) => r[0] === a.platform) - RAW.findIndex((r) => r[0] === b.platform) || byTotal(a, b));

export const SAMPLE_A = `每天早起 15 分钟，我把一周早餐吃出了花样
上班族早餐指南：5 个前一晚就能备好的方法
全网最省时的早餐做法，第一名太绝了`;

export const SAMPLE_B = `打工人 15 分钟早餐｜一周不重样
一口锅做五天早餐，照着做就行
早餐这样吃，上午不犯困`;

const AB: [string, number, number, number, string, string?][] = [
  ['每天早起 15 分钟，我把一周早餐吃出了花样', 8, 8, 1, '具体、有结果，代入感强'],
  ['上班族早餐指南：5 个前一晚就能备好的方法', 7, 9, 0, '清楚实用，吸引力一般'],
  ['全网最省时的早餐做法，第一名太绝了', 8, 5, 8, '悬念强但看不出讲什么', '「全网最」「第一名」属于绝对化用语'],
  ['打工人 15 分钟早餐｜一周不重样', 8, 9, 0, '关键词清楚，适合搜索和推荐'],
  ['一口锅做五天早餐，照着做就行', 8, 8, 0, '门槛低，画面感好'],
  ['早餐这样吃，上午不犯困', 7, 7, 4, '击中痛点，但效果说法需要依据', '「不犯困」带有功效暗示'],
];
const toS = ([title, attract, clarity, risk, reason, riskNote = '']: (typeof AB)[number]): Scored => ({ title, platform: 'mp', topic: T1, attract, clarity, risk, reason, riskNote, total: overall({ attract, clarity, risk }) });
const a = AB.slice(0, 3).map(toS);
const b = AB.slice(3).map(toS);
const statsA = groupStats(a);
const statsB = groupStats(b);
export const SAMPLE_COMPARE: CompareResult = {
  platform: 'mp', topic: T1, a, b, statsA, statsB, winner: pickWinner(statsA, statsB),
  summary: 'B 组整体更稳：三个标题都直接点明「15 分钟」「一周」「一口锅」这类具体信息，没有绝对化用语。A 组第三条悬念强但用了「全网最」「第一名」，拉低了整组的合规分。',
};
