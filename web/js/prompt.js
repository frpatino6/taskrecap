"use strict";
// ---------- prompt text: a small safe markdown renderer + file paths that link to the task's files (free, local) ----------
// Everything is escaped first; only http(s)/mailto links and file paths become links (a path the task did not touch opens the files view with 'no other task'). Pure functions, no DOM.
let PROMPT_FILES = []; // short paths of the files of the task being shown (from its capsule); a path outside this list stays plain text

/** Paths in free text: absolute, ~/, ./ ../, relative (src/a.js) or a bare file name (a.js), with an optional :line[:col]. [{start, end, path, text}] */
function findPaths(text) {
  const out = [], re = /(?<![\w@\/.~-])(?:~\/|\.\.?\/|\/)?[\w@+.-]+(?:\/[\w@+.-]+)*\/?(?::\d+(?::\d+)?)?/g;
  let m;
  while ((m = re.exec(text))) {
    const t = m[0].replace(/[.,;:!?]+$/, "");
    const p = t.replace(/:\d+(?::\d+)?$/, "").replace(/\/$/, "");
    if (!(p.includes("/") || /^[\w@+-][\w@+.-]*\.[A-Za-z][A-Za-z0-9]{1,7}$/.test(p)) || /^[\d./~-]*$/.test(p)) continue;
    out.push({ start: m.index, end: m.index + t.length, path: p, text: t });
  }
  return out;
}

/** (path) => the task file it names, or null. Exact match, else a unique match on whole path segments ('src/a.js' vs '/Users/x/app/src/a.js'). */
function fileResolver(files) {
  const list = (files || []).filter(Boolean);
  return (p) => {
    const q = String(p).replace(/^(~\/|\.\/)/, "");
    if (!q || q.endsWith("/")) return null;
    if (list.includes(q)) return q;
    const hits = list.filter((f) => f.endsWith("/" + q) || q.endsWith("/" + f));
    return hits.length === 1 ? hits[0] : null;
  };
}

const safeHref = (u) => (/^(https?:\/\/|mailto:)[^\s<>"']+$/i.test(u) ? u : null);
const extLink = (href, label) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
const fileLink = (file, label, unknown) => `<button class="filelink${unknown ? " unknown" : ""}" type="button" data-file="${esc(file)}" title="${esc(file)}">${label}</button>`;
/** A path that looks like a real file path (a directory part and a file name with an extension) though no task file matched it. */
const BARE_EXT = /\.(?:js|mjs|cjs|jsx|ts|tsx|json|md|css|scss|html|py|java|kt|swift|go|rs|rb|php|sh|ya?ml|toml|sql|xml|txt|csv|env|lock|gradle|properties|vue|svelte|c|h|cpp|cs)$/i;
const looksLikeFile = (p) => (/\/[^/]+\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(p) || (BARE_EXT.test(p) && !/^(?:node|next|vue|react|express|three|d3|chart|nuxt|alpine)\.js$/i.test(p))) && !/^[\d./~-]*$/.test(p);

/** Plain text -> html: escaped, with the paths that name a task file as buttons. */
function plainHtml(text, resolve) {
  let out = "", at = 0;
  for (const f of resolve ? findPaths(text) : []) {
    const file = resolve(f.path), unknown = !file && looksLikeFile(f.path);
    if (!file && !unknown) continue;
    out += esc(text.slice(at, f.start)) + fileLink(file || f.path.replace(/^(~\/|\.\/)/, ""), esc(f.text), unknown);
    at = f.end;
  }
  return out + esc(text.slice(at));
}

/** Inline markdown: `code`, [text](url), **bold**, *italic*, bare http(s) urls. */
function mdInline(text, resolve) {
  const re = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+?)\*\*|\*([^*\s][^*\n]*?)\*|(https?:\/\/[^\s<>]+)/g;
  let out = "", at = 0, m;
  while ((m = re.exec(text))) {
    out += plainHtml(text.slice(at, m.index), resolve);
    at = m.index + m[0].length;
    if (m[1] != null) {
      const whole = resolve && findPaths(m[1]).some((f) => f.start === 0 && f.end === m[1].length);
      const file = whole ? resolve(m[1].replace(/:\d+(?::\d+)?$/, "")) : null;
      const bare = m[1].replace(/:\d+(?::\d+)?$/, "").replace(/^(~\/|\.\/)/, ""), unknown = whole && !file && looksLikeFile(bare);
      out += file || unknown ? fileLink(file || bare, `<code>${esc(m[1])}</code>`, unknown) : `<code>${esc(m[1])}</code>`;
    } else if (m[2] != null) {
      const href = safeHref(m[3]);
      out += href ? extLink(href, mdInline(m[2], null)) : plainHtml(m[0], null);
    } else if (m[4] != null) out += `<strong>${mdInline(m[4], resolve)}</strong>`;
    else if (m[5] != null) out += `<em>${mdInline(m[5], resolve)}</em>`;
    else {
      const url = m[6].replace(/[.,;:!?)\]]+$/, ""), href = safeHref(url);
      out += href ? extLink(href, esc(url)) : esc(url);
      at -= m[6].length - url.length; // trailing punctuation goes back to the text
    }
    re.lastIndex = at;
  }
  return out + plainHtml(text.slice(at), resolve);
}

const tableCells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const isTableSep = (line) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes("|");

/** Markdown (headings, lists, fenced code, blockquotes, tables, rules, inline) -> safe html. Raw html in the text is shown as text. */
function renderMarkdown(text, resolve) {
  const lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n"), out = [], inl = (s) => mdInline(s, resolve);
  const blockStart = (l) => /^\s*(```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|(-{3,}|\*{3,}|_{3,})\s*$)/.test(l);
  const itemRe = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    const fence = l.match(/^\s*(```+|~~~+)/);
    if (fence) {
      const code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i]);
      i++; // the closing fence (a missing one ends the block at the end of the text)
      out.push(`<pre><code>${plainHtml(code.join("\n"), resolve)}</code></pre>`);
      continue;
    }
    const h = l.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { out.push(`<h4 class="mdh">${inl(h[2])}</h4>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
    if (l.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = tableCells(l), rows = [];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(tableCells(lines[i]));
      out.push(`<div class="tablewrap"><table><thead><tr>${head.map((c) => `<th>${inl(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inl(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(l)) {
      const q = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${q.map(inl).join("<br>")}</blockquote>`);
      continue;
    }
    const li = l.match(itemRe);
    if (li) {
      const ordered = /\d/.test(li[1]), items = [];
      for (; i < lines.length; i++) {
        const m = lines[i].match(itemRe);
        if (m && /\d/.test(m[1]) === ordered) items.push(m[2]);
        else if (items.length && /^\s{2,}\S/.test(lines[i]) && !blockStart(lines[i])) items[items.length - 1] += "\n" + lines[i].trim(); // a wrapped item
        else break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((x) => `<li>${x.split("\n").map(inl).join("<br>")}</li>`).join("")}</${tag}>`);
      continue;
    }
    const para = [];
    for (; i < lines.length && lines[i].trim() && (!para.length || !blockStart(lines[i])); i++) para.push(lines[i]);
    out.push(`<p>${para.map(inl).join("<br>")}</p>`);
  }
  return out.join("");
}
