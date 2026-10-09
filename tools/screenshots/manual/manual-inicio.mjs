// Manual screenshots (PART 1, HOME page) — annotated, Spanish UI, synthetic demo data.
// Self-contained: starts its own isolated demo server on port 8811, drives the UI with Playwright,
// injects numbered red overlays and saves PNGs to docs/manual/img/.
//   cd tools/screenshots && node manual/manual-inicio.mjs
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
const record = (name, ok, note = '') => { results.push({ name, ok, note }); console.log(ok ? 'PASS' : 'FAIL', name, note ? '- ' + note : ''); };

// --- isolated demo server: its own cache dir, port 8811, demo sessions only ---
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-manual-'));
const server = spawn(process.execPath, [path.join(ROOT, 'bin', 'taskrecap.js'), '--demo', '--no-open', '--port', '8811'], {
  cwd: ROOT, env: { ...process.env, TASKRECAP_HOME: home, TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'],
});
const base = await new Promise((resolve, reject) => {
  let out = '';
  const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 20000);
  server.stdout.on('data', (d) => { out += d; const m = out.match(/http:\/\/127\.0\.0\.1:\d+\//); if (m) { clearTimeout(t); resolve(m[0]); } });
  server.on('exit', (c) => reject(new Error('server exited ' + c + ': ' + out)));
});
console.log('demo server at', base, '(cache:', home + ')');

const browser = await chromium.launch();
const errors = [];

const settle = (page, ms = 500) => page.waitForTimeout(ms);

async function setView(page, v) {
  await page.evaluate((v) => { try { localStorage.setItem('tr-view', v); } catch (e) { /* ignore */ } }, v);
  await page.goto(base);
  await page.waitForSelector('#viewbar:not([hidden])', { timeout: 15000 });
  await settle(page);
}

async function annotate(page, items) {
  await page.evaluate((items) => {
    document.querySelectorAll('.ann-box,.ann-badge,.ann-panel,.ann-style').forEach((e) => e.remove());
    const style = document.createElement('style');
    style.className = 'ann-style';
    style.textContent = '.ann-badge{position:fixed;width:20px;height:20px;border-radius:50%;background:#e11f26;color:#fff;font:bold 12px/20px -apple-system,Segoe UI,Roboto,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.45);z-index:2147483001}.ann-panel{position:fixed;left:12px;bottom:12px;max-width:440px;background:#fff;border:3px solid #e11f26;border-radius:8px;padding:10px 12px;z-index:2147483002;font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;box-shadow:0 2px 14px rgba(0,0,0,.28)}.ann-line{margin:2px 0}.ann-num{display:inline-block;min-width:18px;height:18px;border-radius:9px;background:#e11f26;color:#fff;font:bold 11px/18px sans-serif;text-align:center;margin-right:5px;padding:0 5px}.ann-line em{color:#e11f26;font-style:normal}';
    document.head.appendChild(style);
    const lines = [];
    items.forEach((it, i) => {
      const n = i + 1;
      let placed = false;
      let el = null;
      try { el = document.querySelector(it.selector); } catch (e) { el = null; }
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) {
          const box = document.createElement('div');
          box.className = 'ann-box';
          Object.assign(box.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: Math.max(r.width, 6) + 'px', height: Math.max(r.height, 6) + 'px', border: '3px solid #e11f26', borderRadius: '6px', boxSizing: 'border-box', zIndex: '2147483000', pointerEvents: 'none' });
          document.body.appendChild(box);
          const badge = document.createElement('div');
          badge.className = 'ann-badge';
          badge.textContent = String(n);
          badge.style.left = Math.max(2, r.left - 9) + 'px';
          badge.style.top = Math.max(2, r.top - 9) + 'px';
          document.body.appendChild(badge);
          placed = true;
        }
      }
      lines.push('<div class="ann-line"><span class="ann-num">' + n + '</span>' + it.label + (placed ? '' : ' <em>(no visible)</em>') + '</div>');
    });
    const panel = document.createElement('div');
    panel.className = 'ann-panel';
    panel.innerHTML = lines.join('');
    document.body.appendChild(panel);
  }, items);
}

const clearOverlays = (page) => page.evaluate(() => document.querySelectorAll('.ann-box,.ann-badge,.ann-panel,.ann-style').forEach((e) => e.remove()));

async function shot(page, slug, items) {
  if (items && items.length) await annotate(page, items);
  const file = path.join(OUT, `inicio-${slug}.png`);
  await page.screenshot({ path: file });
  if (items && items.length) await clearOverlays(page);
  return file;
}

async function capture(page, slug, items, fn) {
  try {
    if (fn) await fn();
    const file = await shot(page, slug, items);
    const st = fs.statSync(file);
    if (st.size < 20000) throw new Error('PNG too small: ' + st.size + ' bytes');
    record(`inicio-${slug}.png`, true, Math.round(st.size / 1024) + ' KB');
  } catch (e) {
    record(`inicio-${slug}.png`, false, e.message.split('\n')[0]);
  }
}

const firstVisible = async (page, sel) => {
  const loc = page.locator(sel).first();
  if (await loc.count()) { await loc.scrollIntoViewIfNeeded().catch(() => {}); return true; }
  return false;
};

try {
  // ---------- group A: cards view ----------
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'es-ES', timezoneId: 'UTC', colorScheme: 'light', ignoreHTTPSErrors: true });
  await page.addInitScript(() => { try { localStorage.setItem('tr-lang', 'es'); localStorage.setItem('tr-view', 'cards'); } catch (e) { /* ignore */ } });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(base);
  await page.waitForSelector('#grid .card', { timeout: 15000 });
  await settle(page);

  await capture(page, 'overview', [
    { selector: '#home-title', label: 'Título de la página' },
    { selector: '#home-lead', label: 'Frase de introducción' },
    { selector: '#q', label: 'Cuadro de búsqueda (gratis, dentro de las cápsulas)' },
    { selector: '#mode-free', label: 'Chip de modo gratis' },
    { selector: '#ai-search', label: 'Botón «Mejorar con IA: buscar por significado»' },
    { selector: '#viewbar', label: 'Barra de vistas (Tarjetas / Línea de tiempo)' },
  ], async () => { await page.evaluate(() => window.scrollTo(0, 0)); await firstVisible(page, '#home-title'); });

  await capture(page, 'busqueda-en-capsulas', [
    { selector: '#q', label: 'Término buscado («rounding»)' },
    { selector: '#grid .card mark', label: 'Palabra coincidente resaltada dentro de la cápsula' },
    { selector: '#grid .card .hitwhy', label: 'Etiqueta «Encontrado en …» que dice dónde coincidió' },
    { selector: '#search-scope', label: 'Nota de alcance: dentro de cuántas cápsulas buscó' },
  ], async () => {
    await page.fill('#q', 'rounding');
    await page.waitForFunction(() => document.querySelectorAll('#grid .card mark').length > 0, null, { timeout: 10000 });
    await settle(page);
    await page.evaluate(() => window.scrollTo(0, 0));
  });

  await capture(page, 'vista-tarjetas', [
    { selector: '#view-timeline', label: 'Pestaña «Línea de tiempo»' },
    { selector: '#view-cards', label: 'Pestaña «Tarjetas» (activa)' },
    { selector: '#grid', label: 'Rejilla de tarjetas: una por tarea' },
    { selector: '#grid .card', label: 'Tarjeta de tarea (clic para abrir el detalle)' },
  ], async () => { await page.fill('#q', ''); await page.waitForFunction(() => document.querySelectorAll('#grid .card').length >= 3, null, { timeout: 8000 }); await settle(page); await page.evaluate(() => window.scrollTo(0, 0)); });

  await capture(page, 'tarjeta-chips', [
    { selector: '#grid .card[data-key="SHOP-101"] .k', label: 'Nombre/rótulo de la tarea' },
    { selector: '#grid .card[data-key="SHOP-101"] .chip.done', label: 'Chip «Cápsula lista»' },
    { selector: '#grid .card[data-key="SHOP-106"] .chip.warn', label: 'Chip «Aún sin cápsula»' },
    { selector: '#grid .card[data-key="SHOP-105"] .chip.warn', label: 'Chip «Desactualizada · N nuevos»' },
    { selector: '#grid .card .meta', label: 'Fila de chips: repos, sesiones, fechas, estado' },
  ], async () => {
    await page.fill('#q', ''); await settle(page);
    const card = page.locator('#grid .card[data-key="SHOP-101"]');
    if (await card.count()) await card.scrollIntoViewIfNeeded().catch(() => {});
  });

  await capture(page, 'menu-acciones', [
    { selector: '#grid .cardmenu', label: 'Botón «⋯» que abre el menú de acciones' },
    { selector: '#unitmenu', label: 'Menú de acciones de la unidad (Renombrar, Unir, Ocultar, Deshacer…)' },
  ], async () => {
    await page.fill('#q', ''); await settle(page);
    await page.locator('#grid .cardmenu').first().click();
    await page.waitForSelector('#unitmenu:not([hidden])', { timeout: 8000 });
    await settle(page, 300);
  });
  await page.keyboard.press('Escape');

  await capture(page, 'sin-resultados', [
    { selector: '#none', label: 'Mensaje «Ninguna tarea coincide con tu búsqueda»' },
    { selector: '#none-hint', label: 'Nota que explica que la búsqueda gratis es literal' },
    { selector: '#none-ai', label: 'Botón «Probar la búsqueda por significado con IA…»' },
  ], async () => {
    await page.fill('#q', 'zzzzqxyw');
    await page.waitForSelector('#nonewrap:not([hidden])', { timeout: 8000 });
    await settle(page);
    await page.evaluate(() => window.scrollTo(0, 0));
  });

  await capture(page, 'buscar-archivo', [
    { selector: '#filesearch', label: 'Desplegable «Buscar por archivo»' },
    { selector: '#fq', label: 'Campo para escribir parte de una ruta' },
    { selector: '#filelist', label: 'Archivos tocados y las tareas que los tocaron' },
  ], async () => {
    await page.fill('#q', ''); await settle(page);
    await page.locator('#filesearch-title').click();
    await page.waitForSelector('#filelist .filerows, #filelist .note', { timeout: 8000 });
    await settle(page);
    await firstVisible(page, '#filesearch');
  });

  await capture(page, 'organizar-ia', [
    { selector: '#organize', label: 'Panel «Organiza con IA tus sesiones sin clasificar»' },
    { selector: '#org-run', label: 'Botón «Organizar con IA…» (muestra estimación y pide confirmar)' },
  ], async () => {
    await page.fill('#q', ''); await settle(page);
    if (await page.locator('#organize:not([hidden])').count()) {
      await firstVisible(page, '#organize');
      await settle(page, 300);
    } else {
      throw new Error('#organize is hidden in this demo');
    }
  });

  await capture(page, 'busqueda-ia-estimacion', [
    { selector: '#q', label: 'Término a buscar por significado' },
    { selector: '#aibox', label: 'Panel de IA: estimación de tokens y coste antes de gastar' },
    { selector: '#ai-ok', label: 'Botón «Confirmar y generar» (solo aquí se gasta)' },
    { selector: '#ai-no', label: 'Botón «Cancelar»' },
  ], async () => {
    await page.fill('#q', ''); await settle(page);
    await page.fill('#q', 'reintentar el pago');
    const btn = page.locator('#ai-search');
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    if (await btn.isDisabled()) throw new Error('AI search disabled (Claude Code unavailable in demo)');
    await btn.click();
    await page.waitForSelector('#ai-ok, #ai-retry, #aibox .err', { timeout: 15000 });
    await settle(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    if (await page.locator('#ai-retry').count()) throw new Error('estimate failed');
  });

  await page.close();

  // ---------- group B: timeline view ----------
  const tl = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'es-ES', timezoneId: 'UTC', colorScheme: 'light' });
  await tl.addInitScript(() => { try { localStorage.setItem('tr-lang', 'es'); localStorage.setItem('tr-view', 'timeline'); } catch (e) { /* ignore */ } });
  tl.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  tl.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await tl.goto(base);
  await tl.waitForSelector('#timeline .vz-lane, #timeline .vz-empty', { timeout: 15000 });
  await settle(tl, 800);

  await capture(tl, 'linea-tiempo', [
    { selector: '#coverage', label: 'Indicador/ botón «Cobertura de cápsulas» (filtra las que no tienen)' },
    { selector: '#view-timeline', label: 'Pestaña «Línea de tiempo» (activa)' },
    { selector: '#timeline', label: 'Línea de tiempo: una fila por tarea, un punto por día' },
  ], async () => { await tl.evaluate(() => window.scrollTo(0, 0)); await settle(tl, 300); });

  await capture(tl, 'timeline-filtros', [
    { selector: '#vz-repo', label: 'Filtro «Repo»' },
    { selector: '#vz-period', label: 'Filtro «Periodo» (Todo el tiempo, 7/30/90 días, rango personalizado)' },
    { selector: '#vz-reset', label: 'Botón «Restablecer»' },
    { selector: '#vz-msg', label: 'Aviso de los filtros (p. ej. fechas intercambiadas)' },
    { selector: '#timeline .vz-legend', label: 'Leyenda de colores por repositorio' },
  ], async () => {
    await firstVisible(tl, '#viewbar');
    await settle(tl, 300);
  });

  if (await tl.locator('#vz-more').count()) {
    await capture(tl, 'mostrar-mas', [
      { selector: '#vz-more', label: 'Botón «Mostrar N más» para cargar más tareas' },
      { selector: '#timeline .vz-foot', label: 'Pie con «Mostrando X de Y tareas» y grupos plegados' },
    ], async () => { await firstVisible(tl, '#vz-more'); await settle(tl, 300); });
  }

  await capture(tl, 'timeline-tooltip', [
    { selector: '#timeline .vz-mark', label: 'Punto del día (tamaño = número de prompts)' },
    { selector: '#vz-tip', label: 'Globo con tarea, repo, día, prompts y estado de cápsula' },
    { selector: '#timeline .vz-label', label: 'Etiqueta de la fila (accesible con teclado)' },
  ], async () => {
    await firstVisible(tl, '#timeline .vz-mark');
    const bb = await tl.locator('#timeline .vz-mark').first().boundingBox();
    if (!bb) throw new Error('no mark visible');
    await tl.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await tl.waitForSelector('#vz-tip:not([hidden])', { timeout: 6000 });
    await settle(tl, 250);
  });

  await capture(tl, 'timeline-grupo-vacio', [
    { selector: '#emptygroup', label: 'Grupo plegado «Sesiones sin contenido (N)»' },
  ], async () => {
    if (!(await tl.locator('#emptygroup:not([hidden])').count())) throw new Error('#emptygroup is hidden in this demo');
    await firstVisible(tl, '#emptygroup');
    const det = tl.locator('#emptydet');
    if (await det.count()) { await det.evaluate((d) => { if (!d.open) d.open = true; }); await settle(tl, 300); }
  });

  await tl.close();

  // ---------- group C: hidden box (mutates the throwaway demo) ----------
  const hp = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'es-ES', timezoneId: 'UTC', colorScheme: 'light' });
  await hp.addInitScript(() => { try { localStorage.setItem('tr-lang', 'es'); localStorage.setItem('tr-view', 'cards'); } catch (e) { /* ignore */ } });
  hp.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  hp.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await hp.goto(base);
  await hp.waitForSelector('#grid .card', { timeout: 15000 });
  await settle(hp);

  await capture(hp, 'ocultos', [
    { selector: '#hiddenbox', label: 'Caja «Ocultos (N)» con los elementos que puedes mostrar de nuevo' },
    { selector: '#hiddenbox [data-unhide-unit], #hiddenbox [data-unhide-session]', label: 'Botón «Mostrar de nuevo»' },
  ], async () => {
    await hp.locator('#grid .cardmenu').first().click();
    await hp.waitForSelector('#unitmenu:not([hidden])', { timeout: 8000 });
    const hide = hp.locator('#unitmenu button', { hasText: 'Ocultar' }).first();
    if (!(await hide.count())) throw new Error('no Ocultar item in menu');
    await hide.click();
    await hp.waitForSelector('#unitdlg:not([hidden]) #ud-ok', { timeout: 8000 });
    await hp.click('#ud-ok');
    await hp.waitForSelector('#hiddenbox:not([hidden])', { timeout: 10000 });
    await settle(hp, 400);
    const det = hp.locator('#hiddenbox details');
    if (await det.count()) { await det.evaluate((d) => { if (!d.open) d.open = true; }); await settle(hp, 300); }
    await firstVisible(hp, '#hiddenbox');
  });

  await hp.close();
} catch (e) {
  console.error('FATAL', e);
} finally {
  await browser.close().catch(() => {});
  server.kill('SIGTERM');
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

const pngs = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((f) => f.endsWith('.png')) : [];
console.log('\n--- summary ---');
console.log('images on disk (' + pngs.length + '):', pngs.join(', '));
const failed = results.filter((r) => !r.ok);
console.log('passed:', results.filter((r) => r.ok).length, 'failed:', failed.length);
if (errors.length) console.log('browser console errors:', errors.slice(0, 5).join(' | '));
process.exit(failed.length ? 1 : 0);
