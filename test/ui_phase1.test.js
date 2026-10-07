import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, css, indexHtml, js } from './web_assets.js';

const webDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const html = all;
const strings = JSON.parse(fs.readFileSync(path.join(webDir, 'strings.en.json'), 'utf8'));
const EMOJI = /[\u{1F300}-\u{1FAFF}✨⚠]/u;

test('skip link: string, element and handler exist', () => {
  assert.equal(strings.skip_link, 'Skip to main content');
  assert.match(html, /<a class="skip" id="skip" href="#"><\/a>/);
  assert.match(html, /\$\("skip"\)\.textContent = S\.skip_link/);
  assert.match(html, /\$\("skip"\)\.addEventListener\("click", \(e\) => \{ e\.preventDefault\(\)/); // must not change the hash route
});

test('main landmarks are focusable and headings can take focus', () => {
  assert.match(html, /<main id="home" tabindex="-1" hidden>/);
  assert.match(html, /<main id="detail" tabindex="-1" hidden>/);
  assert.match(html, /<h1 id="home-title" tabindex="-1">/);
  assert.match(html, /<h1 tabindex="-1">\$\{esc\(key\)\}<\/h1>/);
  assert.match(html, /focus\(\{ preventScroll: true \}\)/);
});

test('home scroll position is saved when opening a task and restored on return', () => {
  assert.match(html, /homeScroll = window\.scrollY/);
  assert.match(html, /await renderHome\(\); window\.scrollTo\(0, routed \? homeScroll : 0\)/);
  assert.match(html, /window\.scrollTo\(0, 0\); await renderDetail/);
});

test('no emoji used as structural icons in the UI or its strings', () => {
  const body = indexHtml.slice(indexHtml.indexOf('<body>')) + js;
  assert.doesNotMatch(body, EMOJI);
  assert.doesNotMatch(JSON.stringify(strings), EMOJI);
  assert.match(html, /<svg class="ico"[^>]*focusable="false">/);
});

test('no font size under 12px', () => {
  const sizes = [...css.matchAll(/font-size:\s*([\d.]+)(px|em|rem)/g)];
  for (const [, n, unit] of sizes) if (unit === 'px') assert.ok(Number(n) >= 12, `font-size ${n}px`);
  for (const m of css.matchAll(/font:\s*([\d.]+)(px|em)\s/g)) {
    if (m[2] === 'px') assert.ok(Number(m[1]) >= 12, `font ${m[1]}px`);
    else assert.ok(Number(m[1]) >= 0.8, `font ${m[1]}em`);
  }
});

test('small interactive controls keep a 24px minimum target', () => {
  for (const sel of ['button.cite', 'button.filelink', '.linkbtn', '.capfilter button']) {
    const rule = css.split('\n').find((l) => l.startsWith(sel + ' {'));
    assert.ok(rule && /min-height:\s*24px/.test(rule), sel);
  }
  assert.match(css, /\.cta\.sm \{ min-height: 36px/);
});
