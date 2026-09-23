export interface Settings {
  quality: 0 | 1 | 2;
  shake: boolean;
  lines: boolean;
  sfx: number;
  music: number;
  autoThrottle: boolean;
}

const KEY = 'celrush.settings';
const DEFAULTS: Settings = { quality: 2, shake: true, lines: true, sfx: 0.8, music: 0.45, autoThrottle: false };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* blocked storage: defaults */
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

const bestKey = (course: string, mode: string) => `celrush.best.${course}.${mode}`;

export function loadBest(course: string, mode: string): number | null {
  try {
    const v = localStorage.getItem(bestKey(course, mode));
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}

/** lower is better except survival distance */
export function saveBest(course: string, mode: string, value: number): boolean {
  const prev = loadBest(course, mode);
  const better = prev === null || (mode === 'survival' ? value > prev : value < prev);
  if (better) {
    try {
      localStorage.setItem(bestKey(course, mode), String(value));
    } catch {
      /* ignore */
    }
  }
  return better;
}
