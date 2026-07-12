#!/usr/bin/env node
/**
 * Median Absolute Deviation analysis for nightly performance (§11.2).
 */
import fs from 'node:fs';
import path from 'node:path';

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mad(values) {
  const med = median(values);
  return median(values.map((v) => Math.abs(v - med)));
}

const root = process.argv[2] || 'artifacts';
const walls = [];
for (const dir of fs.readdirSync(root)) {
  const p = path.join(root, dir, 'wall_ms.txt');
  if (fs.existsSync(p)) walls.push(Number(fs.readFileSync(p, 'utf8').trim()));
}

if (walls.length === 0) {
  console.error('No wall_ms samples');
  process.exit(1);
}

const med = median(walls);
const m = mad(walls);
const k = 3;
const threshold = k * 1.4826 * (m || 1);
const inliers = walls.filter((v) => Math.abs(v - med) <= threshold);
const robust = median(inliers);

console.log(
  JSON.stringify({ samples: walls, median: med, mad: m, robustMedian: robust }, null, 2),
);

// Alert only when robust median crosses historical threshold (placeholder 60s)
const HISTORICAL_P95 = Number(process.env.PERF_P95_MS || 60_000);
if (robust > HISTORICAL_P95) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  const text = `[HIGH] Performance regression robustMedian=${robust}ms > p95=${HISTORICAL_P95}`;
  console.error(text);
  if (webhook) {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  }
  process.exit(1);
}
