import { describe, it, expect } from 'vitest';
import { InMemoryRuntimeMetrics, buildSeriesKey, parseSeriesKey } from '../../core/metrics/metrics';
import { renderPrometheus } from '../../core/metrics/prometheus';

describe('buildSeriesKey / parseSeriesKey', () => {
  it('returns name without tags', () => {
    expect(buildSeriesKey('counter')).toBe('counter');
  });

  it('returns name with sorted tags', () => {
    const key = buildSeriesKey('counter', { b: '2', a: '1' });
    expect(key).toBe('counter|a=1,b=2');
  });

  it('parses key without tags', () => {
    expect(parseSeriesKey('counter')).toEqual({ name: 'counter', tags: {} });
  });

  it('parses key with tags', () => {
    expect(parseSeriesKey('counter|a=1,b=2')).toEqual({ name: 'counter', tags: { a: '1', b: '2' } });
  });
});

describe('InMemoryRuntimeMetrics', () => {
  it('increments counters', () => {
    const m = new InMemoryRuntimeMetrics();
    m.incCounter('hits', 1, { action: 'test' });
    m.incCounter('hits', 3, { action: 'test' });
    const key = buildSeriesKey('hits', { action: 'test' });
    expect(m.counters.get(key)).toBe(4);
  });

  it('observes histogram values as aggregated summary', () => {
    const m = new InMemoryRuntimeMetrics();
    m.observe('latency', 100, { action: 'test' });
    m.observe('latency', 200, { action: 'test' });
    const key = buildSeriesKey('latency', { action: 'test' });
    const summary = m.histograms.get(key);
    expect(summary).toEqual({ count: 2, sum: 300, min: 100, max: 200 });
  });
});

describe('renderPrometheus', () => {
  it('renders counters and histograms', () => {
    const m = new InMemoryRuntimeMetrics();
    m.incCounter('runtime.success', 1, { action: 'test.action' });
    m.observe('runtime.latency_ms', 50, { action: 'test.action' });
    m.observe('runtime.latency_ms', 150, { action: 'test.action' });

    const output = renderPrometheus(m);
    expect(output).toContain('agentkit_runtime_counter_total');
    expect(output).toContain('agentkit_runtime_histogram_count');
    expect(output).toContain('agentkit_runtime_histogram_avg');
    expect(output).toContain('agentkit_runtime_histogram_max');
    expect(output).toContain('action="test.action"');
  });
});
