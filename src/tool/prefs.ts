// 偏好设置：选过的平台、每个平台条数、补充要求、字数上限、保存位置、对比用的平台。读出时逐项兜底。
import { PLATFORMS } from './core';

export interface Prefs {
  platforms: string[];
  count: number;
  extra: string;
  limit: number;
  outDir: string;
  abPlatform: string;
}
export const PREFS_KEY = 'c20.prefs';

const ids = new Set(PLATFORMS.map((p) => p.id));

export function readPrefs(raw: unknown, fb: Prefs): Prefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (k: 'extra' | 'outDir') => (typeof o[k] === 'string' ? (o[k] as string) : fb[k]);
  const num = (k: 'count' | 'limit', min: number, max: number) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? Math.max(min, Math.min(max, Math.round(o[k] as number))) : fb[k]);
  const platforms = Array.isArray(o.platforms) ? (o.platforms as unknown[]).filter((x): x is string => typeof x === 'string' && ids.has(x)) : fb.platforms;
  return {
    platforms: platforms.length ? platforms : fb.platforms,
    count: num('count', 3, 20),
    extra: str('extra'),
    limit: num('limit', 0, 200),
    outDir: str('outDir'),
    abPlatform: typeof o.abPlatform === 'string' && ids.has(o.abPlatform) ? o.abPlatform : fb.abPlatform,
  };
}
