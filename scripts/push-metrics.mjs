#!/usr/bin/env node
/**
 * Scrapes /api/metrics (Prometheus text format) once and remote_writes the
 * samples to Grafana Cloud. Run on a GitHub Actions cron — no long-running
 * Prometheus/Alloy server needed anywhere; this script IS the scrape+push
 * cycle, invoked periodically.
 *
 * Required env:
 *   METRICS_URL                e.g. https://jobs.manavmalavia.org/api/metrics
 *   METRICS_SECRET             shared secret, sent as x-metrics-secret
 *   GRAFANA_REMOTE_WRITE_URL   from Grafana Cloud -> Send Metrics -> Prometheus
 *   GRAFANA_INSTANCE_ID        Basic auth username
 *   GRAFANA_API_TOKEN          Basic auth password (metrics:write scope)
 */
import { pushTimeseries } from 'prometheus-remote-write';
import { pathToFileURL } from 'url';

const METRICS_URL = process.env.METRICS_URL;
const METRICS_SECRET = process.env.METRICS_SECRET;
const REMOTE_WRITE_URL = process.env.GRAFANA_REMOTE_WRITE_URL;
const INSTANCE_ID = process.env.GRAFANA_INSTANCE_ID;
const API_TOKEN = process.env.GRAFANA_API_TOKEN;

/** Parses Prometheus text exposition format into {name, labels, value}[]. */
export function parsePrometheusText(text) {
  const out = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(-?[\d.eE+]+)\s*$/);
    if (!m) continue;
    const [, name, , labelStr, valueStr] = m;
    const labels = {};
    if (labelStr) {
      for (const part of labelStr.split(',')) {
        const lm = part.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"([^"]*)"\s*$/);
        if (lm) labels[lm[1]] = lm[2];
      }
    }
    const value = Number(valueStr);
    if (Number.isFinite(value)) out.push({ name, labels, value });
  }
  return out;
}

async function main() {
  for (const [name, val] of Object.entries({ METRICS_URL, REMOTE_WRITE_URL, INSTANCE_ID, API_TOKEN })) {
    if (!val) {
      console.error(`missing required env: ${name}`);
      process.exit(1);
    }
  }

  const res = await fetch(METRICS_URL, {
    headers: METRICS_SECRET ? { 'x-metrics-secret': METRICS_SECRET } : {},
  });
  if (!res.ok) {
    throw new Error(`fetch ${METRICS_URL} -> ${res.status}`);
  }
  const text = await res.text();
  const samples = parsePrometheusText(text);
  if (!samples.length) {
    console.log('no samples parsed from /api/metrics — nothing to push');
    return;
  }

  const now = Date.now();
  const timeseries = samples.map((s) => ({
    labels: { __name__: s.name, job: 'scoutgrid-dashboard', ...s.labels },
    samples: [{ value: s.value, timestamp: now }],
  }));

  await pushTimeseries(timeseries, {
    url: REMOTE_WRITE_URL,
    auth: { username: INSTANCE_ID, password: API_TOKEN },
  });

  console.log(`pushed ${timeseries.length} samples to Grafana Cloud`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error('push-metrics failed:', err.message || err);
    process.exit(1);
  });
}
