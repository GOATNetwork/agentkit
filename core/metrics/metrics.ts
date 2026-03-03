export interface RuntimeMetrics {
  incCounter(name: string, value?: number, tags?: Record<string, string>): void;
  observe(name: string, value: number, tags?: Record<string, string>): void;
}

export function buildSeriesKey(name: string, tags?: Record<string, string>): string {
  if (!tags || Object.keys(tags).length === 0) return name;
  const ordered = Object.entries(tags)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  return `${name}|${ordered}`;
}

export function parseSeriesKey(seriesKey: string): { name: string; tags: Record<string, string> } {
  const [name, raw] = seriesKey.split('|', 2);
  if (!raw) return { name, tags: {} };

  const tags: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k) tags[k] = v ?? '';
  }
  return { name, tags };
}

export class NoopRuntimeMetrics implements RuntimeMetrics {
  incCounter(_name: string, _value = 1, _tags?: Record<string, string>): void {}
  observe(_name: string, _value: number, _tags?: Record<string, string>): void {}
}

export class InMemoryRuntimeMetrics implements RuntimeMetrics {
  counters = new Map<string, number>();
  histograms = new Map<string, number[]>();

  incCounter(name: string, value = 1, tags?: Record<string, string>): void {
    const key = buildSeriesKey(name, tags);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  observe(name: string, value: number, tags?: Record<string, string>): void {
    const key = buildSeriesKey(name, tags);
    const arr = this.histograms.get(key) ?? [];
    arr.push(value);
    this.histograms.set(key, arr);
  }
}
