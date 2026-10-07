// The browser page is split into web/index.html + web/app.css + web/js/*.js; tests that inspect the shipped source read it from here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');

export const indexHtml = read('index.html');
export const css = read('app.css');
export const jsFiles = fs.readdirSync(path.join(WEB, 'js')).filter((f) => f.endsWith('.js')).sort();
export const js = jsFiles.map((f) => read(`js/${f}`)).join('\n');
/** markup + styles + scripts as one string, for regex checks that do not care where a rule lives */
export const all = [indexHtml, css, js].join('\n');
