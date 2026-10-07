import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { all as html } from './web_assets.js';
const strings = JSON.parse(readFileSync(new URL('../web/strings.en.json', import.meta.url), 'utf8'));

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const token = (block, name) => block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];

test('timeline repo colours reach 3:1 against the surface in light and dark', () => {
  const light = html.match(/:root \{ --vz-1[^}]*\}/)[0];
  const dark = html.match(/:root\[data-theme="dark"\] \{ --vz-1[^}]*\}/)[0];
  const lightSurface = token(html.slice(html.indexOf(':root {')), 'surface');
  const darkSurface = token(html.slice(html.indexOf(':root[data-theme="dark"]')), 'surface');
  assert.ok(lightSurface && darkSurface);
  for (const n of ['vz-1', 'vz-2', 'vz-3', 'vz-other']) {
    assert.ok(ratio(token(light, n), lightSurface) >= 3, `light ${n}`);
  }
  for (const n of ['vz-1', 'vz-2', 'vz-3']) {
    assert.ok(ratio(token(dark, n), darkSurface) >= 3, `dark ${n}`);
  }
  assert.ok(ratio(token(light, 'vz-other'), darkSurface) >= 3, 'other on dark (shared token)');
});

test('each repo slot has its own shape, on marks and legend swatches', () => {
  for (const cls of ['s1', 's2', 's-other']) {
    assert.match(html, new RegExp(`\\.vz-mark\\.${cls}::before`), `mark ${cls}`);
    assert.match(html, new RegExp(`\\.vz-sw\\.${cls}`), `swatch ${cls}`);
  }
  assert.match(html, /clip-path: polygon\(50% 0, 100% 50%/); // diamond
  assert.match(html, /vz-sw s-other/); // legend entry for "other repos"
});

test('day marks are focusable buttons with a name, reached by arrows from the lane label', () => {
  assert.match(html, /<button type="button" class="vz-mark[^`]*tabindex="-1" aria-label=/);
  assert.doesNotMatch(html, /class="vz-mark[^`]*aria-hidden/);
  assert.match(html, /"ArrowRight", "ArrowLeft", "Home", "End"/);
  assert.match(html, /const mk = e\.target\.closest\("\.vz-mark"\)/); // tooltip on focus
  assert.ok(strings.tl_mark_label);
  for (const v of ['{key}', '{repo}', '{day}', '{prompts}']) assert.ok(strings.tl_mark_label.includes(v), v);
});

test('phone layout puts the lane label above its track and drops the fixed chart width', () => {
  const m = html.match(/@media \(max-width: 560px\) \{\s*:root \{ --vz-label-w: 112px; \}[\s\S]*?\n\}/)[0];
  assert.match(m, /\.vz-chart \{ min-width: 0/);
  assert.match(m, /\.vz-row \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(m, /\.vz-label \{ position: static/);
});
