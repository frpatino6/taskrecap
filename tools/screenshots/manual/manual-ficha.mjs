// Manual (part 2 — detail/capsule page) screenshots. Maintainer tooling, never published.
// Drives the SYNTHETIC demo data with Playwright, annotates the controls being documented and
// saves PNGs to docs/manual/img/. It NEVER calls the real LLM: the AI progress panel is fed by a
// scripted NDJSON stream (same technique as shots.mjs).
//   cd tools/screenshots && node manual/manual-ficha.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = path.join(ROOT, 'docs', 'manual', 'img');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push({ name, ok: true }); console.log('PASS', name); }
  catch (e) { results.push({ name, ok: false, error: e.message }); console.log('FAIL', name, '-', e.message.split('\n')[0]); }
};

// --- isolated demo server on port 8812, its own cache dir, demo sessions only ---
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-manual-'));
const server = spawn(process.execPath, [path.join(ROOT, 'bin', 'taskrecap.js'), '--demo', '--no-open', '--port', '8812'], {
  cwd: ROOT, env: { ...process.env, TASKRECAP_HOME: home, TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'],
});
const base = await new Promise((resolve, reject) => {
  let out = '';
  const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 15000);
  server.stdout.on('data', (d) => {
    out += d;
    const m = out.match(/http:\/\/127\.0\.0\.1:\d+\//);
    if (m) { clearTimeout(t); resolve(m[0]); }
  });
  server.on('exit', (c) => reject(new Error('server exited ' + c + ': ' + out)));
});
console.log('demo server at', base, '(cache:', home + ')');

const browser = await chromium.launch();
const consoleErrors = [];

async function newPage(scheme = 'light', init) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'es-ES', colorScheme: scheme, timezoneId: 'UTC' });
  const page = await ctx.newPage();
  await page.addInitScript(() => { try { localStorage.setItem('tr-lang', 'es'); } catch (e) { /* ignore */ } });
  if (scheme === 'dark') await page.addInitScript(() => { try { localStorage.setItem('wc-theme', 'dark'); } catch (e) { /* ignore */ } });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  if (init) await page.addInitScript(init);
  return page;
}
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(OUT, name), ...opts });
const settle = (page, ms = 600) => page.waitForTimeout(ms);

async function openTask(page, key) {
  await page.goto(base + '#/task/' + encodeURIComponent(key));
  await page.waitForSelector('#detail:not([hidden]) h1, #detail:not([hidden]) h2', { timeout: 10000 });
  await settle(page);
}

// --- annotation helper: numbered red outlines + a caption panel listing "N. label" ---
async function annotate(page, items, { caption = 'fixed' } = {}) {
  await page.evaluate(({ items, caption }) => {
    const old = document.getElementById('tr-annot');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.id = 'tr-annot';
    wrap.style.cssText = 'position:absolute;inset:0;z-index:99998;pointer-events:none;';
    const sx = window.scrollX, sy = window.scrollY;
    items.forEach((it, i) => {
      const el = document.querySelector(it.selector);
      if (!el) return;
      const r = el.getBoundingClientRect();
      const box = document.createElement('div');
      box.style.cssText = `position:absolute;left:${r.left + sx - 2}px;top:${r.top + sy - 2}px;width:${r.width + 4}px;height:${r.height + 4}px;border:3px solid #e11f26;border-radius:4px;box-sizing:border-box;`;
      const b = document.createElement('span');
      b.textContent = String(i + 1);
      b.style.cssText = 'position:absolute;top:-13px;left:-3px;background:#e11f26;color:#fff;font:700 13px/1 system-ui,sans-serif;padding:3px 7px;border-radius:999px;white-space:nowrap;';
      box.appendChild(b);
      wrap.appendChild(box);
    });
    const cap = document.createElement('div');
    const pos = caption === 'end'
      ? `left:12px;top:${(document.documentElement.scrollHeight - 12 - items.length * 20)}px;`
      : 'left:12px;bottom:12px;';
    cap.style.cssText = `position:${caption === 'end' ? 'absolute' : 'fixed'};${pos}max-width:460px;background:#111;color:#fff;font:400 13px/1.45 system-ui,sans-serif;padding:12px 14px;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.45);z-index:99999;`;
    cap.innerHTML = items.map((it, i) => `<div><b>${i + 1}.</b> ${it.label}</div>`).join('');
    wrap.appendChild(cap);
    document.body.appendChild(wrap);
  }, { items, caption });
}
const clearAnnot = (page) => page.evaluate(() => { const e = document.getElementById('tr-annot'); if (e) e.remove(); });

async function annotated(page, name, selector, items, { scrollTo = null, fullPage = false, caption = 'fixed' } = {}) {
  if (scrollTo !== null) { await page.locator(scrollTo).first().scrollIntoViewIfNeeded(); await settle(page, 250); }
  await annotate(page, items, { caption });
  await shot(page, name, { fullPage });
  await clearAnnot(page);
}

// AI progress: scripted NDJSON stream replaces POST /api/generate (no LLM call, zero spend).
const FAKE_STREAM = () => {
  const orig = window.fetch.bind(window);
  let started = false;
  window.fetch = (url, opts) => {
    if (started && String(url).includes('/api/usage')) {
      const u = { calls: 2, input_tokens: 3000, output_tokens: 600, usd: 0.024, tokens: 3600 };
      return Promise.resolve(new Response(JSON.stringify({ session: u, total: u }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (String(url).includes('/api/generate') && opts && opts.method === 'POST') {
      started = true;
      const enc = new TextEncoder();
      const usage = (calls, tokens, cost) => ({ calls, tokens, cost_usd: cost });
      const events = [
        { type: 'start', stages: ['scan', 'redact', 'votes', 'merge', 'evidence', 'write', 'validate', 'save'] },
        { type: 'stage', id: 'scan', status: 'running' },
        { type: 'stage', id: 'scan', status: 'done', code: 'scan_done', vars: { sessions: 1, turns: 8 } },
        { type: 'stage', id: 'redact', status: 'done', code: 'redact_none', vars: { turns: 8 } },
        { type: 'stage', id: 'votes', status: 'running', code: 'votes_start', vars: { session: 'f9a9b9c9', votes: 3, turns: 8 } },
        { type: 'log', code: 'vote_done', vars: { n: 1, of: 3, ranges: 1, turns: 8, session: 'f9a9b9c9' }, level: 'info', usage: usage(1, 1800, 0.012) },
        { type: 'log', code: 'vote_done', vars: { n: 2, of: 3, ranges: 1, turns: 8, session: 'f9a9b9c9' }, level: 'info', usage: usage(2, 3600, 0.024) },
      ];
      let i = 0;
      return Promise.resolve(new Response(new ReadableStream({
        start(c) {
          const push = () => { if (i < events.length) { c.enqueue(enc.encode(JSON.stringify(events[i++]) + '\n')); setTimeout(push, 140); } };
          push();
          if (opts.signal) opts.signal.addEventListener('abort', () => { try { c.error(new DOMException('aborted', 'AbortError')); } catch { /* closed */ } });
        },
      }), { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }));
    }
    return orig(url, opts);
  };
};

// ============================ SHOP-101: ready capsule ============================
let page = await newPage('light');
await check('ficha: overview + objective/detail header', async () => {
  await openTask(page, 'SHOP-101');
  await annotated(page, 'ficha-overview-light.png', null, [
    { selector: '#back', label: 'Volver a la lista de tareas' },
    { selector: '.hero .chip', label: 'Chip de tipo de unidad (Clave de tarea / Rama / Sesión / Grupo)' },
    { selector: '#detail h1', label: 'Título de la cápsula' },
    { selector: '.hero .t', label: 'Objetivo (subtítulo)' },
    { selector: '#unit-menu', label: 'Menú «Acciones» (renombrar, unir, mover…)' },
    { selector: '#resume', label: '«Retomar esta tarea» (copia el resumen)' },
    { selector: '.genslim', label: 'Barra de IA: «Regenerar con IA…»' },
    { selector: '#detail .block h2', label: 'Secciones de la cápsula' },
  ], { fullPage: true, caption: 'end' });
});

await check('ficha: objective closeup', async () => {
  await page.goto(base + '#/task/SHOP-101'); await settle(page);
  await annotated(page, 'ficha-encabezado-light.png', null, [
    { selector: '#detail .hero', label: 'Encabezado: tipo, título, objetivo y fecha de generación' },
  ], { scrollTo: '#detail .hero', caption: 'fixed' });
});

await check('ficha: timeline table + citations', async () => {
  await annotated(page, 'ficha-linea-tiempo-light.png', null, [
    { selector: '#detail table.tl2', label: 'Línea de tiempo: fecha y hora, repo, resultado y evidencia' },
    { selector: '#detail table.tl2 tbody tr:first-child td:first-child span', label: 'Fecha y hora del primer mensaje que cita la fila (título emergente)' },
    { selector: '#detail table.tl2 button.cite', label: 'Cita: abre el panel de evidencia' },
  ], { scrollTo: '#detail table.tl2' });
});

await check('ficha: decisions with reasons', async () => {
  await annotated(page, 'ficha-decisiones-light.png', null, [
    { selector: '#detail .block:nth-of-type(2)', label: '«Decisiones y por qué»: la decisión y su motivo' },
    { selector: '#detail .decision .chip.warn', label: 'Marca «incierto» cuando el motivo no es seguro' },
  ], { scrollTo: '#detail .decision' });
});

await check('ficha: files (final / reverted)', async () => {
  await annotated(page, 'ficha-archivos-light.png', null, [
    { selector: '#detail .block:nth-of-type(3)', label: '«Archivos tocados»: finales y revertidos, con nº de ediciones' },
    { selector: '#detail button.filelink', label: 'Archivo: abre qué otras tareas lo tocaron' },
  ], { scrollTo: '#detail button.filelink' });
});

await check('ficha: commits', async () => {
  await annotated(page, 'ficha-commits-light.png', null, [
    { selector: '#detail .block:nth-of-type(4)', label: '«Commits»: hash, rama, mensaje y marcas «subido» / posible deshecho' },
  ], { scrollTo: '#detail .block:nth-of-type(4)' });
});

await check('ficha: dead ends / left out / pending', async () => {
  await annotated(page, 'ficha-cierre-light.png', null, [
    { selector: '#detail .block:nth-of-type(5)', label: '«Callejones sin salida»: intentos que no funcionaron' },
    { selector: '#detail .block:nth-of-type(6)', label: '«Dejado fuera»: lo que quedó fuera del alcance' },
    { selector: '#detail .block:nth-of-type(7)', label: '«Pendiente»: lo que falta por hacer' },
  ], { scrollTo: '#detail .block:nth-of-type(5)' });
});

await check('ficha: resume briefing + copy command', async () => {
  await annotated(page, 'ficha-resumen-light.png', null, [
    { selector: '#detail #briefing', label: '«Resumen para retomar»: el texto que se copia' },
    { selector: '#detail #resume', label: '«Retomar esta tarea»: copia el resumen y muestra «¡Copiado!»' },
  ], { scrollTo: '#detail #briefing' });
});

await check('ficha: a citation opens the evidence panel', async () => {
  await page.locator('#detail button.cite').first().scrollIntoViewIfNeeded();
  await page.locator('#detail button.cite').first().click();
  await page.waitForSelector('#evidence:not([hidden]) .evturn.cited', { timeout: 8000 });
  await settle(page);
  await annotated(page, 'ficha-evidencia-light.png', null, [
    { selector: '#evidence .evhead h2', label: 'Título: sesión y número de mensaje citado' },
    { selector: '#evidence .evmeta', label: 'Datos de la sesión (fecha, repo, rama, carpeta, nº de mensajes)' },
    { selector: '#evidence .evwarn', label: 'Aviso si la cita apunta fuera de los mensajes de la cápsula' },
    { selector: '#evidence .evturn.cited', label: 'El mensaje citado, resaltado' },
    { selector: '#evidence .evturn.dim', label: 'Mensajes de contexto, atenuados' },
    { selector: '#evidence .evresume', label: 'Comando «claude --resume …» con botón de copiar' },
    { selector: '#ev-close', label: 'Cerrar (o tecla Escape; el foco vuelve a la cita)' },
  ], { caption: 'fixed' });
  await page.keyboard.press('Escape');
  await page.waitForSelector('#evidence', { state: 'hidden' });
});

await check('ficha: a file opens the file -> tasks panel', async () => {
  const btn = page.locator('#detail button.filelink', { hasText: 'total.test.js' }).first();
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  await page.waitForFunction(() => /Otras tareas/i.test((document.getElementById('filebox') || {}).innerText || ''), null, { timeout: 8000 });
  await settle(page);
  await annotated(page, 'ficha-archivo-tareas-light.png', null, [
    { selector: '#filebox .filepanel', label: '«Otras tareas que tocaron …»: lista de tareas y su estado' },
    { selector: '#filebox button.tasklink', label: 'Abre esa otra tarea' },
    { selector: '#filebox .note', label: 'Aviso de que la lista puede estar incompleta' },
  ], { scrollTo: '#filebox' });
});

// ============================ sessions (free) ============================
await check('ficha: no-capsule state + sessions list (free)', async () => {
  await openTask(page, 'SHOP-106');
  await annotated(page, 'ficha-sin-capsula-light.png', null, [
    { selector: '#detail .panel.gen', label: 'Estado sin cápsula: «Aún sin cápsula» + botón «Mejorar con IA: generar cápsula…»' },
    { selector: '#sess-jump', label: '«Leer los mensajes (gratis)»: baja a las sesiones' },
    { selector: '#detail #sessions h2', label: 'Sección «Sesiones» (siempre gratis, sin IA)' },
    { selector: '#sesslist .sessitem', label: 'Sesión: se pliega y despliega con aria-expanded' },
  ], { scrollTo: '#detail .panel.gen' });
});

await check('ficha: session expanded with messages + scope buttons', async () => {
  await page.goto(base + '#/task/SHOP-106'); await settle(page);
  await page.locator('#sesslist .sessrow').first().click();
  await page.waitForSelector('#sesslist .msg');
  await settle(page);
  await annotated(page, 'ficha-sesiones-light.png', null, [
    { selector: '#sesslist .sessitem', label: 'Sesión desplegada: fecha, repo, rama y nº de mensajes' },
    { selector: '#sesslist .msg', label: 'Mensaje: al pulsarlo se abre la conversación que lo rodea' },
    { selector: '#sesslist .msg .chip.warn', label: 'Marca «nuevo» (posterior a la cápsula)' },
  ], { scrollTo: '#sesslist .msg' });
});

await check('ficha: shared session, mine highlighting and scope selector', async () => {
  await openTask(page, 'SHOP-103');
  await page.locator('#sesslist .sessitem[data-mixed="1"] .sessrow').first().click();
  await page.waitForSelector('#sesslist .msgs.marking .msg');
  await settle(page);
  await annotated(page, 'ficha-compartida-light.png', null, [
    { selector: '#sessscope', label: 'Selector de alcance: Todos los mensajes / Que citan la clave / Nuevos' },
    { selector: '#sesslist .msgs.marking .note', label: 'Aviso: mensajes resaltados que mencionan la tarea' },
    { selector: '#sesslist .msg.mine', label: 'Mensaje resaltado (menciona la clave de la tarea)' },
    { selector: '#sesslist .sessitem .chip', label: 'Marca «Compartida con otras tareas»' },
  ], { scrollTo: '#sesslist .msgs.marking .note' });
});

// ============================ outdated capsule ============================
await check('ficha: outdated capsule banner + see new messages', async () => {
  await openTask(page, 'SHOP-105');
  await annotated(page, 'ficha-desactualizada-light.png', null, [
    { selector: '#detail .stale', label: 'Banner: «Desactualizada: N mensajes nuevos desde <fecha>»' },
    { selector: '#stale-see', label: '«Ver los mensajes nuevos»: filtra a los mensajes nuevos' },
    { selector: '#gen', label: '«Actualizar con IA…»: regenera toda la cápsula (usa tokens)' },
    { selector: '#detail .stale .hint', label: 'Aviso de que actualizar cuesta tokens y pide confirmación' },
  ], { scrollTo: '#detail .stale' });
});

await check('ficha: scope "new" shows only the new messages', async () => {
  await page.goto(base + '#/task/SHOP-105'); await settle(page);
  await page.click('#stale-see');
  await page.waitForFunction(() => document.querySelectorAll('#sesslist .msg.new').length > 0, null, { timeout: 8000 });
  await settle(page);
  await annotated(page, 'ficha-nuevos-mensajes-light.png', null, [
    { selector: '#sessscope button[data-scope="new"]', label: 'Alcance «Nuevos desde la cápsula (3)», activo' },
    { selector: '#sesslist .msg.new', label: 'Solo se listan los mensajes nuevos (chip «nuevo»)' },
  ], { scrollTo: '#sesslist' });
});

// ============================ generate: estimate + progress ============================
await check('ficha: estimate / confirm dialog (nothing is spent)', async () => {
  await openTask(page, 'SHOP-106');
  await page.click('#gen');
  await page.waitForSelector('#ok', { timeout: 8000 });
  await settle(page);
  await annotated(page, 'ficha-estimacion-light.png', null, [
    { selector: '#genbox', label: 'Estimación: tokens, USD, segundos y llamadas sobre las sesiones' },
    { selector: '#ok', label: '«Confirmar y generar»: solo aquí se empieza a gastar' },
    { selector: '#no', label: '«Cancelar»: no se gasta nada' },
  ], { scrollTo: '#genbox' });
  await page.click('#no');
});

await check('ficha: known-turns estimate for a session unit (no selection step)', async () => {
  await openTask(page, 'session:c7d7e7f7');
  await page.click('#gen');
  await page.waitForSelector('#ok', { timeout: 8000 });
  await settle(page);
  await annotated(page, 'ficha-estimacion-conocida-light.png', null, [
    { selector: '#genbox', label: 'Unidad de sesión: los mensajes ya se conocen, se omite la selección (una llamada)' },
    { selector: '#ok', label: 'Confirmar (aquí no se confirma: se documenta y se cancela)' },
    { selector: '#no', label: 'Cancelar: no se gasta nada' },
  ], { scrollTo: '#genbox' });
  await page.click('#no');
  await page.context().close();
});

page = await newPage('light', FAKE_STREAM);
await check('ficha: AI progress panel (scripted stream, zero spend)', async () => {
  await openTask(page, 'SHOP-106');
  await page.click('#gen');
  await page.waitForSelector('#ok');
  await page.click('#ok');
  await page.waitForSelector('.pg-stages li[data-status="running"]', { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll('.pg-log li').length >= 4, null, { timeout: 8000 });
  await settle(page, 900);
  await annotated(page, 'ficha-progreso-light.png', null, [
    { selector: '.pg-head', label: 'Título y tiempo transcurrido' },
    { selector: '.pg-usage', label: 'Uso real de tokens/USD hasta ahora' },
    { selector: '.pg-stages', label: 'Etapas del proceso con su estado (en espera, en curso, hecho…)' },
    { selector: '.pg-log', label: '«Qué está pasando»: actividad en vivo' },
    { selector: '.pg-cancel', label: '«Cancelar»: detiene de verdad el trabajo (no guarda nada)' },
  ], { scrollTo: '.pg-stages' });
  await page.click('.pg-cancel');
  await page.waitForSelector('.pg-end');
});
await page.context().close();

// ============================ session unit overview ============================
page = await newPage('light');
await check('ficha: session-unit capsule (kind chip + regenerate)', async () => {
  await openTask(page, 'session:c7d7e7f7');
  await annotated(page, 'ficha-unidad-sesion-light.png', null, [
    { selector: '#detail .hero .chip', label: 'Chip «Sesión sin clasificar» (una sesión = una unidad)' },
    { selector: '#detail h1', label: 'Título de la unidad de sesión' },
    { selector: '.genslim', label: 'Cápsula lista: «Regenerar con IA…»' },
    { selector: '#resume', label: '«Retomar esta tarea»' },
  ], { scrollTo: '#detail .hero' });
  await page.context().close();
});

// ============================ dark theme ============================
page = await newPage('dark');
await check('ficha: dark theme detail', async () => {
  await openTask(page, 'SHOP-101');
  await annotated(page, 'ficha-detalle-oscuro.png', null, [
    { selector: '#detail .hero', label: 'Misma página en tema oscuro' },
    { selector: '#detail table.tl2', label: 'Línea de tiempo (tema oscuro)' },
  ], { scrollTo: '#detail .hero' });
  await page.context().close();
});

await check('no console errors during the whole run', async () => {
  if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(' | '));
});

await browser.close();
server.kill('SIGTERM');
fs.rmSync(home, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(' -', f.name, '\n   ', f.error.split('\n')[0]);
const imgs = fs.readdirSync(OUT).filter((f) => f.startsWith('ficha-')).sort();
console.log('PNG in', OUT + ':', imgs.join(', '));
process.exit(failed.length ? 1 : 0);
