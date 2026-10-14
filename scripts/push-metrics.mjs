#!/usr/bin/env node
/**
 * Scrapes /api/metrics (Prometheus text format) once and pushes the samples
 * to Grafana Cloud via its OTLP/HTTP metrics gateway. Run on a GitHub
 * Actions cron — no long-running Prometheus/Alloy server needed anywhere;
 * this script IS the scrape+push cycle, invoked periodically.
 *
 * Uses OTLP (not classic Prometheus remote_write) because that's what this
 * Grafana Cloud stack's "Send Metrics over HTTP" setup wizard provisions —
 * plain JSON over HTTP, no protobuf/snappy encoding needed.
 *
 * Required env:
 *   METRICS_URL          e.g. https://jobs.manavmalavia.org/api/metrics
 *   METRICS_SECRET       shared secret, sent as x-metrics-secret
 *   GRAFANA_OTLP_URL     e.g. https://otlp-gateway-prod-us-east-3.grafana.net/otlp/v1/metrics
 *   GRAFANA_INSTANCE_ID  Basic auth username
 *   GRAFANA_API_TOKEN    Basic auth password (metrics:write scope)
 */
import { pathToFileURL } from 'url';

const METRICS_URL = process.env.METRICS_URL;
const METRICS_SECRET = process.env.METRICS_SECRET;
const OTLP_URL = process.env.GRAFANA_OTLP_URL;
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

/** Builds an OTLP /v1/metrics JSON payload (gauges) from parsed samples. */
export function buildOtlpPayload(samples, nowNs) {
  const metrics = samples.map((s) => ({
    name: s.name,
    unit: '1',
    description: '',
    gauge: {
      dataPoints: [{
        asDouble: s.value,
        timeUnixNano: nowNs.toString(),
        attributes: Object.entries(s.labels || {}).map(([key, v]) => ({
          key,
          value: { stringValue: String(v) },
        })),
      }],
    },
  }));

  return {
    resourceMetrics: [{
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'scoutgrid-dashboard' } }],
      },
      scopeMetrics: [{ metrics }],
    }],
  };
}

async function main() {
  for (const [name, val] of Object.entries({ METRICS_URL, OTLP_URL, INSTANCE_ID, API_TOKEN })) {
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

  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const payload = buildOtlpPayload(samples, nowNs);
  const auth = Buffer.from(`${INSTANCE_ID}:${API_TOKEN}`).toString('base64');

  const pushRes = await fetch(OTLP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${auth}`,
    },
    body: JSON.stringify(payload),
  });

  if (!pushRes.ok) {
    const body = await pushRes.text().catch(() => '');
    throw new Error(`OTLP push -> ${pushRes.status}: ${body.slice(0, 400)}`);
  }

  console.log(`pushed ${samples.length} samples to Grafana Cloud (OTLP)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error('push-metrics failed:', err.message || err);
    process.exit(1);
  });
}
