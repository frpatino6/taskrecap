// Files Claude wrote in a session, and "show it in the file manager". Nothing here trusts the client: a path is only
// revealed when it is one the session's own tool uses recorded, and the OS command is built from an argument array.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isWorkFile, shortPath } from './capsule.js';

export const MAX_SESSION_FILES = 60;

/**
 * Files Claude created (Write) or edited (Edit, MultiEdit, NotebookEdit) in a session, from its rich turns.
 * Created first, then edited (a file both written and edited counts as created); scratch/config files are left out.
 * -> [{path (absolute), short, kind: 'created'|'edited'}]
 */
export function sessionFileList(turns, limit = MAX_SESSION_FILES) {
  const seen = new Map();
  for (const t of turns) {
    const written = new Set(t.written || []);
    for (const f of new Set(t.files || [])) {
      if (!path.isAbsolute(f) || !isWorkFile(f)) continue;
      const kind = written.has(f) ? 'created' : 'edited';
      const cur = seen.get(f);
      if (!cur) seen.set(f, { path: f, short: shortPath(f, t.cwd), kind });
      else if (kind === 'created') cur.kind = 'created';
    }
  }
  const all = [...seen.values()];
  const byKind = (k) => all.filter((x) => x.kind === k).sort((a, b) => (a.short < b.short ? -1 : 1));
  return [...byKind('created'), ...byKind('edited')].slice(0, limit);
}

/** The file itself when it still exists, else its nearest existing parent folder (null when nothing exists). */
export function nearestExisting(file, exists = fs.existsSync) {
  let cur = file;
  for (let i = 0; i < 64; i++) {
    if (exists(cur)) return { target: cur, isFile: cur === file };
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

/** [command, args] that shows `target` in the file manager. Arguments are never joined into a shell string. */
export function revealCommand(platform, target, isFile) {
  if (platform === 'darwin') return isFile ? ['open', ['-R', target]] : ['open', [target]];
  if (platform === 'win32') return isFile ? ['explorer.exe', [`/select,${target}`]] : ['explorer.exe', [target]];
  return ['xdg-open', [isFile ? path.dirname(target) : target]];
}

const defaultSpawn = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 10000, windowsHide: true }, (err) => (err && platformOk(err) ? reject(err) : resolve()));
});
// explorer.exe exits 1 even when it worked; every other failure is real
const platformOk = (err) => !(process.platform === 'win32' && err.code === 1);

/**
 * Show a file (or, when it is gone, its nearest existing folder) in the OS file manager.
 * `spawn(cmd, args)` and `exists(path)` are injectable so tests never open anything. -> {ok, opened} (never throws)
 */
export async function revealFile(file, { platform = process.platform, spawn = defaultSpawn, exists = fs.existsSync } = {}) {
  const near = nearestExisting(file, exists);
  if (!near) return { ok: false, opened: null, error: 'Nothing to open: the folder no longer exists.' };
  const [cmd, args] = revealCommand(platform, near.target, near.isFile);
  try {
    await spawn(cmd, args);
    return { ok: true, opened: near.target };
  } catch (err) {
    return { ok: false, opened: null, error: `Could not open the file manager (${cmd}).` };
  }
}
