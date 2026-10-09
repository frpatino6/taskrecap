// Maintainer tool (not published): annotated screenshots for the shared/global UI of the taskrecap manual
// (top bar, unit action menu, unit dialogs, Organize with AI, evidence panel, toast).
// Demo data only, temporary home folder, no model call (the shipped Organize proposals are used as-is, no spend).
// Run: cd tools/screenshots && node manual/manual-comun.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const OUT = path.join(ROOT, 'docs', 'manual', 'img');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-manual-comun-'));
fs.mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath, [path.join(ROOT, 'bin', 'taskrecap.js'), '--demo', '--no-open', '--port', '8813'], {
  cwd: ROOT,
  env: { ...process.env, TASKRECAP_HOME: tmp, TZ: 'UTC' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const base = await new Promise((resolve, reject) => {
  let out = '';
  const t = setTimeout(() => reject(new Error('server did not start: ' + out)), 20000);
  server.stdout.on('data', (d) => { out += d; const m = out.match(/http:\/\/127\.0\.0\.1:\d+\//); if (m) { clearTimeout(t); resolve(m[0]); } });
  server.on('exit', (c) => reject(new Error('server exited ' + c + ': ' + out)));
});

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'es-ES', colorScheme: 'light' });
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('tr-lang', 'es');
    localStorage.setItem('tr-view', 'cards');
    localStorage.setItem('wc-theme', 'light');
  } catch (e) { /* storage blocked: the page still works */ }
});
const page = await ctx.newPage();
page.setDefaultTimeout(15000);

// ---------- annotation: outline each target with a numbered badge + one caption panel ----------
const CAP_POS = {
  bl: { left: '12px', bottom: '12px' },
  tl: { left: '12px', top: '12px' },
  tr: { right: '12px', top: '12px' },
  br: { right: '12px', bottom: '12px' },
};
async function annotate(items, pos = 'bl') {
  const missing = await page.evaluate(({ items, pos, capPos }) => {
    const notFound = [];
    const ATTR = 'data-manual-annot';
    document.querySelectorAll('[' + ATTR + ']').forEach((e) => e.remove());
    const Z = 2147483000;
    const cap = document.createElement('div');
    cap.setAttribute(ATTR, '1');
    Object.assign(cap.style, {
      position: 'fixed', zIndex: Z, background: 'rgba(18,20,28,.93)', color: '#fff',
      font: '13px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif', padding: '10px 14px 12px',
      borderRadius: '10px', border: '2px solid #e11f26', maxWidth: '380px',
      boxShadow: '0 8px 28px rgba(0,0,0,.4)', pointerEvents: 'none', ...capPos[pos],
    });
    const h = document.createElement('div');
    h.textContent = 'Elementos marcados';
    Object.assign(h.style, { fontWeight: '700', marginBottom: '6px' });
    cap.appendChild(h);
    items.forEach((it, i) => {
      const n = i + 1;
      const line = document.createElement('div');
      line.textContent = n + '. ' + it.label;
      line.style.margin = '2px 0';
      cap.appendChild(line);
      const el = document.querySelector(it.selector);
      if (!el) { notFound.push(it.selector); return; }
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) { notFound.push(it.selector + ' (sin tamaño)'); return; }
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) { notFound.push(it.selector + ' (fuera de pantalla)'); return; }
      const box = document.createElement('div');
      box.setAttribute(ATTR, '1');
      Object.assign(box.style, {
        position: 'fixed', left: (r.left - 3) + 'px', top: (r.top - 3) + 'px',
        width: (r.width + 6) + 'px', height: (r.height + 6) + 'px',
        border: '3px solid #e11f26', borderRadius: '7px', zIndex: Z, pointerEvents: 'none', boxSizing: 'border-box',
      });
      const badge = document.createElement('div');
      badge.setAttribute(ATTR, '1');
      Object.assign(badge.style, {
        position: 'fixed', left: Math.max(2, r.left - 10) + 'px', top: Math.max(2, r.top - 11) + 'px',
        width: '22px', height: '22px', background: '#e11f26', color: '#fff', borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        font: '700 13px ui-sans-serif,system-ui', zIndex: Z + 1, pointerEvents: 'none', boxShadow: '0 0 0 2px #fff',
      });
      badge.textContent = String(n);
      document.body.appendChild(box);
      document.body.appendChild(badge);
    });
    document.body.appendChild(cap);
    return notFound;
  }, { items, pos, capPos: CAP_POS });
  for (const sel of missing) console.warn('    ! no marcado:', sel);
}
async function clearAnnotations() {
  await page.evaluate(() => document.querySelectorAll('[data-manual-annot]').forEach((e) => e.remove()));
}
async function shot(name, items, { pos = 'bl' } = {}) {
  if (items && items.length) await annotate(items, pos);
  await page.screenshot({ path: path.join(OUT, name) });
  await clearAnnotations();
  console.log('  ✓', name);
}
const pause = (ms = 250) => page.waitForTimeout(ms);

// ---------- boot ----------
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#banner');
await page.waitForSelector('#coverage:not([hidden])');
await page.waitForSelector('.card, .organizepanel');
await pause(400);

// 1. skip link (only visible when focused with Tab)
await page.evaluate(() => window.scrollTo(0, 0));
await page.keyboard.press('Tab');
await pause(150);
await shot('comun-skip.png', [{ selector: '#skip', label: 'Enlace «Saltar al contenido principal» (visible solo al enfocar)' }], { pos: 'tr' });
await page.evaluate(() => document.activeElement && document.activeElement.blur());

// 2. top bar overview: every header control marked
await page.evaluate(() => window.scrollTo(0, 0));
await shot('comun-topbar.png', [
  { selector: '#banner', label: 'Aviso de modo (demo o solo local)' },
  { selector: '.logo', label: 'Logotipo (decorativo)' },
  { selector: '#title', label: 'Nombre del producto' },
  { selector: '#tagline', label: 'Lema' },
  { selector: '#coverage', label: 'Anillo de cobertura de cápsulas' },
  { selector: '#usage', label: 'Contador de uso de IA' },
  { selector: '#lang', label: 'Selector de idioma' },
  { selector: '#theme', label: 'Botón de tema claro/oscuro' },
]);

// 3. demo banner alone
await shot('comun-banner.png', [{ selector: '#banner', label: 'Aviso de modo demo' }], { pos: 'bl' });

// 4. coverage ring
await shot('comun-cobertura.png', [
  { selector: '#coverage', label: 'Anillo de cobertura' },
  { selector: '#coverage-text', label: 'Texto de cobertura' },
]);

// 5. usage counter
await shot('comun-uso.png', [{ selector: '#usage', label: 'Uso de IA: esta sesión y en total' }]);

// 6. language selector (native dropdown; focused, options listed)
await page.locator('#lang').focus();
await pause(120);
await shot('comun-idioma.png', [{ selector: '#lang', label: 'Idioma: English / Español (desplegable nativo)' }], { pos: 'bl' });

// 7. theme button, light
await page.locator('#theme').blur();
await shot('comun-tema.png', [{ selector: '#theme', label: 'Botón «Tema» (alterna claro/oscuro)' }], { pos: 'bl' });

// ---------- three-dot unit menu ----------
async function openMenuCard(key) {
  await page.evaluate(() => { location.hash = ''; window.scrollTo(0, 0); });
  await page.waitForSelector('.card');
  const card = page.locator(`.cardmenu[data-menu="${key}"]`).first();
  await card.scrollIntoViewIfNeeded();
  await card.click();
  await page.waitForSelector('#unitmenu button');
  await pause(150);
}
async function menuItems() {
  const n = await page.locator('#unitmenu button').count();
  const items = [{ selector: '#unitmenu', label: 'Menú de acciones de la unidad' }];
  for (let i = 0; i < n; i++) {
    const label = (await page.locator(`#unitmenu button[data-i="${i}"]`).innerText()).trim();
    items.push({ selector: `#unitmenu button[data-i="${i}"]`, label: 'Elemento: «' + label + '»' });
  }
  return items;
}

// 8. session card menu (rename, merge, move, name with AI, hide, undo)
await openMenuCard('session:d4e5f6a7');
await shot('comun-menu-sesion.png', await menuItems());
await page.keyboard.press('Escape');
await pause(120);

// 9. user-group card menu (adds split)
await openMenuCard('user:3f2b6c1e-8d4a-4b7e-9a51-0c6d2e7f1a90');
await shot('comun-menu-grupo.png', await menuItems());
await page.keyboard.press('Escape');
await pause(120);

// ---------- unit dialogs ----------
async function openDialogVia(match, waitFor) {
  await page.waitForSelector('.card');
  const card = page.locator(`.cardmenu[data-menu="session:d4e5f6a7"]`).first();
  await card.scrollIntoViewIfNeeded();
  await card.click();
  await page.waitForSelector('#unitmenu button');
  await page.locator('#unitmenu button', { hasText: match }).first().click();
  await page.waitForSelector(`#unitdlg:not([hidden]) ${waitFor}`);
  await pause(200);
}
const dlgBase = { selector: '#unitdlg .udpanel', label: 'Diálogo de unidad' };
const backdrop = { selector: '#ud-backdrop', label: 'Fondo oscurecido (clic para cerrar)' };
const cancel = { selector: '#ud-cancel', label: 'Botón «Cancelar»' };

// 10. rename
await openDialogVia('Renombrar', '#ud-name');
await shot('comun-dialogo-renombrar.png', [
  backdrop, dlgBase,
  { selector: '#ud-title', label: 'Título del diálogo' },
  { selector: '#ud-name', label: 'Campo «Nombre»' },
  { selector: '#ud-ok', label: 'Botón «Guardar nombre»' },
  cancel,
], { pos: 'tr' });
await page.keyboard.press('Escape');
await pause(120);

// 11. merge
await openDialogVia('Unir con', '#ud-target');
await shot('comun-dialogo-unir.png', [
  backdrop, dlgBase,
  { selector: '#ud-title', label: 'Título del diálogo' },
  { selector: '#ud-target', label: 'Selector «Unir con»' },
  { selector: '#ud-name', label: 'Campo «Nombre del grupo (opcional)»' },
  { selector: '#ud-ok', label: 'Botón «Unir»' },
  cancel,
], { pos: 'tr' });
await page.keyboard.press('Escape');
await pause(120);

// 12. move (name field shown for a new group)
await openDialogVia('Mover sesión', '#ud-target');
await page.locator('#ud-target').selectOption('new');
await pause(120);
await shot('comun-dialogo-mover.png', [
  backdrop, dlgBase,
  { selector: '#ud-title', label: 'Título del diálogo' },
  { selector: '#ud-target', label: 'Selector «Moverla a»' },
  { selector: '#ud-name', label: 'Campo «Nombre del grupo nuevo (opcional)»' },
  { selector: '#ud-ok', label: 'Botón «Mover»' },
  cancel,
], { pos: 'tr' });
await page.keyboard.press('Escape');
await pause(120);

// 13. hide
await openDialogVia('Ocultar', '#ud-ok');
await shot('comun-dialogo-ocultar.png', [
  backdrop, dlgBase,
  { selector: '#ud-title', label: 'Título de confirmación' },
  { selector: '#ud-ok', label: 'Botón «Ocultar» (acción destructiva)' },
  cancel,
], { pos: 'tr' });
await page.keyboard.press('Escape');
await pause(120);

// ---------- Organize with AI ----------
// 14. home panel with the shipped sample proposals (review surface; nothing is applied here)
await page.evaluate(() => { location.hash = ''; });
await page.waitForSelector('#organize .organizepanel');
const det = page.locator('#org-details');
if (await det.count()) {
  const isOpen = await det.evaluate((d) => d.open);
  if (!isOpen) await page.locator('#org-details > summary').click();
}
await page.waitForSelector('.orgprop');
await page.evaluate(() => { const el = document.getElementById('organize'); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70); });
await pause(250);
const orgItems = [
  { selector: '#organize', label: 'Sección «Organiza con IA tus sesiones sin clasificar»' },
  { selector: '#org-run', label: 'Botón «Organizar con IA…» (abre la estimación)' },
  { selector: '.orgprop[data-type="group"]', label: 'Propuesta de tipo «Mismo trabajo» (agrupar)' },
  { selector: '.orgprop[data-type="split"]', label: 'Propuesta de tipo «Dividir sesión»' },
  { selector: '.orgprop[data-type="title"]', label: 'Propuesta de tipo «Nombre»' },
  { selector: '.orgprop .orgaccept', label: 'Botón «Aceptar»' },
  { selector: '.orgprop .orgreject', label: 'Botón «Rechazar»' },
];
if (await page.locator('.orgall').count()) orgItems.push({ selector: '.orgall', label: 'Botón «Aceptar todas las de confianza alta»' });
if (await page.locator('.orgedit-btn').count()) orgItems.push({ selector: '.orgedit-btn', label: 'Botón «Editar título»' });
await shot('comun-organize-propuestas.png', orgItems, { pos: 'tr' });

// 15. the Organize dialog before spending (cached proposals => no call is made)
await page.locator('#org-run').click();
await page.waitForSelector('#orgdlg:not([hidden])');
await page.waitForSelector('#org-ok, #org-show, #org-again');
await pause(250);
const orgDlgItems = [
  { selector: '#org-backdrop', label: 'Fondo oscurecido (clic para cerrar)' },
  { selector: '#orgdlg .orgpanel', label: 'Diálogo «Organizar sesiones sin clasificar»' },
  { selector: '#org-dlg-title', label: 'Título del diálogo' },
  { selector: '#org-dlg-body', label: 'Estimación / estado en caché (sin gasto)' },
];
if (await page.locator('#org-show').count()) orgDlgItems.push({ selector: '#org-show', label: 'Botón «Ver propuestas»' });
if (await page.locator('#org-again').count()) orgDlgItems.push({ selector: '#org-again', label: 'Botón «Analizar de nuevo (~$X)»' });
if (await page.locator('#org-ok').count()) orgDlgItems.push({ selector: '#org-ok', label: 'Botón «Confirmar y organizar»' });
if (await page.locator('#org-no').count()) orgDlgItems.push({ selector: '#org-no', label: 'Botón «Cerrar» / «Cancelar»' });
await shot('comun-organize-dialogo.png', orgDlgItems, { pos: 'tr' });
await page.keyboard.press('Escape');
await pause(150);

// ---------- evidence panel ----------
// 16-17. navigate to a capsule with citations, open the first one
await page.evaluate(() => { location.hash = '#/task/' + encodeURIComponent('session:c7d7e7f7'); });
await page.waitForSelector('#detail button.cite');
await page.locator('#detail button.cite').first().click();
await page.waitForSelector('#evidence:not([hidden]) .evturn.cited');
await pause(400);
const evItems = [
  { selector: '#ev-panel .evhead', label: 'Cabecera y botón «Cerrar»' },
  { selector: '.evturn.cited', label: 'Turno citado (resaltado)' },
];
if (await page.locator('.evturn.dim').count()) evItems.push({ selector: '.evturn.dim', label: 'Turnos de contexto (atenuados)' });
if (await page.locator('.evwarn').count()) evItems.push({ selector: '.evwarn', label: 'Aviso: cita no verificada' });
await shot('comun-evidencia.png', evItems, { pos: 'tl' });
// scroll the drawer to the top to show metadata + resume command
await page.evaluate(() => { const p = document.getElementById('ev-panel'); if (p) p.scrollTop = 0; });
await pause(200);
const evTop = [
  { selector: '#ev-title', label: 'Título «Evidencia: sesión …, mensaje n.º …»' },
  { selector: '.evmeta', label: 'Metadatos de la sesión' },
];
if (await page.locator('#ev-resume').count()) evTop.push({ selector: '#ev-resume', label: 'Comando «claude --resume …»' });
if (await page.locator('#ev-copy').count()) evTop.push({ selector: '#ev-copy', label: 'Botón «Copiar comando para retomar»' });
await shot('comun-evidencia-cabecera.png', evTop, { pos: 'bl' });
await page.keyboard.press('Escape');
await pause(200);

// ---------- toast ----------
// 18. a confirmation toast (rename) with its Undo link
await page.evaluate(() => { location.hash = ''; });
await page.waitForSelector('.card');
const tcard = page.locator('.cardmenu[data-menu="session:d4e5f6a7"]').first();
await tcard.scrollIntoViewIfNeeded();
await tcard.click();
await page.waitForSelector('#unitmenu button');
await page.locator('#unitmenu button', { hasText: 'Renombrar' }).first().click();
await page.waitForSelector('#ud-name');
await page.locator('#ud-name').fill('Tarea de ejemplo renombrada');
await page.locator('#ud-ok').click();
await page.waitForSelector('#toast:not([hidden])');
await pause(200);
const toastItems = [{ selector: '#toast', label: 'Aviso de estado (mensaje + «Deshacer»)' }];
if (await page.locator('#toast-undo').count()) toastItems.push({ selector: '#toast-undo', label: 'Enlace «Deshacer»' });
await shot('comun-toast.png', toastItems, { pos: 'tl' });

// ---------- dark theme ----------
// 19. whole page in dark theme
await page.evaluate(() => window.scrollTo(0, 0));
await page.locator('#theme').click();
await pause(300);
await shot('comun-oscuro.png', null);

// ---------- done ----------
await browser.close();
server.kill('SIGTERM');
fs.rmSync(tmp, { recursive: true, force: true });

const files = fs.readdirSync(OUT).filter((f) => /^comun-.*\.png$/.test(f)).sort();
console.log('\n' + files.length + ' PNG en ' + OUT);
for (const f of files) console.log('  ' + f + '  ' + fs.statSync(path.join(OUT, f)).size + ' B');
