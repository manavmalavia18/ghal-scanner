import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePrometheusText } from '../scripts/push-metrics.mjs';

test('parses gauges without labels', () => {
  const samples = parsePrometheusText('scoutgrid_users_total 12\n');
  assert.deepEqual(samples, [{ name: 'scoutgrid_users_total', labels: {}, value: 12 }]);
});

test('parses gauges with one or more labels', () => {
  const text = 'scoutgrid_jobs_total{track="software"} 724\nscoutgrid_track_switches{window="24h",track="data"} 6\n';
  const samples = parsePrometheusText(text);
  assert.deepEqual(samples, [
    { name: 'scoutgrid_jobs_total', labels: { track: 'software' }, value: 724 },
    { name: 'scoutgrid_track_switches', labels: { window: '24h', track: 'data' }, value: 6 },
  ]);
});

test('ignores HELP/TYPE comment lines and blank lines', () => {
  const text = '# HELP scoutgrid_users_total blah\n# TYPE scoutgrid_users_total gauge\n\nscoutgrid_users_total 5\n';
  const samples = parsePrometheusText(text);
  assert.deepEqual(samples, [{ name: 'scoutgrid_users_total', labels: {}, value: 5 }]);
});

test('skips unparseable lines instead of throwing', () => {
  const samples = parsePrometheusText('not a valid metric line\nscoutgrid_users_total 3\n');
  assert.deepEqual(samples, [{ name: 'scoutgrid_users_total', labels: {}, value: 3 }]);
});
