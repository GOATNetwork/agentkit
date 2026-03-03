import { InMemoryRuntimeMetrics, parseSeriesKey } from './metrics';

function sanitize(v: string): string {
  return v.replace(/[^a-zA-Z0-9_:\-\.]/g, '_');
}

function labelsToProm(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (!entries.length) return '';
  return '{' + entries.map(([k, v]) => `${sanitize(k)}="${sanitize(v)}"`).join(',') + '}';
}

export function renderPrometheus(metrics: InMemoryRuntimeMetrics): string {
  const lines: string[] = [];

  lines.push('# TYPE agentkit_runtime_counter_total counter');
  for (const [seriesKey, value] of metrics.counters.entries()) {
    const { name, tags } = parseSeriesKey(seriesKey);
    const labels = { metric: name, ...tags };
    lines.push(`agentkit_runtime_counter_total${labelsToProm(labels)} ${value}`);
  }

  lines.push('# TYPE agentkit_runtime_histogram_count gauge');
  lines.push('# TYPE agentkit_runtime_histogram_avg gauge');
  lines.push('# TYPE agentkit_runtime_histogram_max gauge');
  for (const [seriesKey, arr] of metrics.histograms.entries()) {
    if (!arr.length) continue;
    const { name, tags } = parseSeriesKey(seriesKey);
    const labels = { metric: name, ...tags };
    const promLabels = labelsToProm(labels);
    const sum = arr.reduce((a, b) => a + b, 0);
    const avg = sum / arr.length;

    lines.push(`agentkit_runtime_histogram_count${promLabels} ${arr.length}`);
    lines.push(`agentkit_runtime_histogram_avg${promLabels} ${avg}`);
    lines.push(`agentkit_runtime_histogram_max${promLabels} ${Math.max(...arr)}`);
  }

  return lines.join('\n') + '\n';
}
