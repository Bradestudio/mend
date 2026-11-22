// main.ts is mend, the CLI SPEC.md specifies: it applies an edit an AI model wrote, in four formats
// (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls), to a tree of text files.
// Every file is changed or nothing is. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function diskExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/** A file as lines: its line break, and whether it ends with one. */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function serializeFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

interface Move {
  old: string;
  new: string;
}
type Edit = (tree: Tree) => Move | null;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

/** One line of O or N; `ctx` lines are written as the file's own matched line. */
interface OLine {
  text: string;
  ctx: boolean;
}

const leadingWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0];
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Positions i where O occurs in `lines` at `tier`, from `from` on; `eofOnly` keeps only occurrences ending at the last line. */
function occurrences(lines: string[], o: string[], tier: number, from = 0, eofOnly = false): number[] {
  const out: number[] = [];
  const k = o.length;
  for (let i = from; i + k <= lines.length; i += 1) {
    if (eofOnly && i + k !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < k; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (tier 0 only with --strict), or null. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0, eofOnly = false): number | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t += 1) {
    if (occurrences(lines, o, t, from, eofOnly).length > 0) return t;
  }
  return null;
}

/** The lines N becomes at position `pos`: context lines are the file's own, tier 2 re-indents the rest. */
function buildN(fileLines: string[], pos: number, o: OLine[], n: OLine[], tier: number): string[] {
  const oCtxIdx: number[] = [];
  o.forEach((e, i) => {
    if (e.ctx) oCtxIdx.push(i);
  });
  const f = tier === 2 && o.length > 0 ? leadingWs(fileLines[pos] ?? '') : '';
  const p = tier === 2 && o.length > 0 ? leadingWs(o[0]!.text) : '';
  const out: string[] = [];
  let nCtx = 0;
  for (const e of n) {
    if (e.ctx) {
      out.push(fileLines[pos + oCtxIdx[nCtx]!]!);
      nCtx += 1;
    } else if (tier === 2) {
      const t = e.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(e.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits.
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null || diskExists(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
      return null;
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      return null;
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
      return null;
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}
interface Hunk {
  A: number;
  body: BodyLine[];
  O: OLine[];
  N: OLine[];
  noEol: boolean;
}
interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld?: string | null;
  pairNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path after `--- `/`+++ `: up to the first tab, surrounding spaces removed, `/dev/null` means no file, a leading `a/` or `b/` removed. */
function stripDiffPath(s: string): string | null {
  let p = s.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
  if (!m) throw new Exit2(`error: parse ${i + 1}`);
  const A = Number(m[1]);
  const body: BodyLine[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const b = lines[j]!;
    if (b.startsWith('diff --git ')) break;
    if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
      body.push({ kind: b === '' ? ' ' : (b[0] as BodyLine['kind']), text: b === '' ? '' : b.slice(1) });
      j += 1;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
  const O: OLine[] = [];
  const N: OLine[] = [];
  for (const bl of body) {
    if (bl.kind === ' ') {
      O.push({ text: bl.text, ctx: true });
      N.push({ text: bl.text, ctx: true });
    } else if (bl.kind === '-') O.push({ text: bl.text, ctx: false });
    else if (bl.kind === '+') N.push({ text: bl.text, ctx: false });
  }
  let noEol = false;
  for (let k = body.length - 1; k >= 0; k -= 1) {
    if (body[k]!.kind === ' ' || body[k]!.kind === '+') {
      noEol = k + 1 < body.length && body[k + 1]!.kind === '\\';
      break;
    }
  }
  return { hunk: { A, body, O, N, noEol }, next: j };
}

/** Parse one section's header and hunks, starting at `start` (after its `diff --git` line, or at its `--- ` line for a bare section). Returns the index after the section. */
function parseUSection(lines: string[], start: number, sec: USection): number {
  let i = start;
  let inHeader = true;
  let pairSeen = false;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) {
      const { hunk, next } = parseHunk(lines, i);
      sec.hunks.push(hunk);
      i = next;
      inHeader = false;
      continue;
    }
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (inHeader && !pairSeen) {
        sec.pairOld = stripDiffPath(l.slice(4));
        sec.pairNew = stripDiffPath(lines[i + 1]!.slice(4));
        pairSeen = true;
        i += 2;
        continue;
      }
      break;
    }
    if (inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        sec.renameFrom = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.renameTo = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.isCreate = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.isDelete = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, failPath: string): void {
  let d = 0;
  for (const h of hunks) {
    const otexts = h.O.map((o) => o.text);
    if (h.O.length === 0) {
      const pos = Math.max(0, Math.min(h.A + d, model.lines.length));
      const atEnd = pos === model.lines.length;
      model.lines.splice(pos, 0, ...h.N.map((n) => n.text));
      if (atEnd) model.final = !h.noEol;
      d += h.N.length;
      continue;
    }
    const tier = findTier(model.lines, otexts, strict);
    if (tier === null) throw new Fail('no-match', failPath);
    const occs = occurrences(model.lines, otexts, tier);
    const target = h.A - 1 + d;
    let best = occs[0]!;
    let bestDist = Math.abs(best - target);
    for (const o of occs) {
      const dist = Math.abs(o - target);
      if (dist < bestDist) {
        best = o;
        bestDist = dist;
      }
    }
    const touchesEnd = best + h.O.length === model.lines.length;
    const rep = buildN(model.lines, best, h.O, h.N, tier);
    model.lines.splice(best, h.O.length, ...rep);
    if (touchesEnd) model.final = !h.noEol;
    d += h.N.length - h.O.length;
  }
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld;
  const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
  const isCreate = oldPath === null || sec.isCreate;
  const isDelete = !isCreate && (newPath === null || sec.isDelete);
  return (tree) => {
    if (isCreate) {
      const p = newPath;
      if (p === null) throw new Fail('unsafe', '/dev/null');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null || diskExists(p)) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      let noEol = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
        const body = sec.hunks[hi]!.body;
        for (let k = body.length - 1; k >= 0; k -= 1) {
          if (body[k]!.kind === '+') {
            noEol = k + 1 < body.length && body[k + 1]!.kind === '\\';
            break outer;
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return null;
    }
    if (isDelete) {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return null;
    }
    const op = oldPath!;
    const np = newPath!;
    if (!safe(op)) throw new Fail('unsafe', op);
    const isMove = op !== np;
    if (isMove && !safe(np)) throw new Fail('unsafe', np);
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    if (isMove && (tree.get(np) !== null || diskExists(np))) throw new Fail('exists', np);
    const model = parseFile(cur);
    applyHunks(model, sec.hunks, strict, op);
    const out = serializeFile(model);
    if (isMove) {
      tree.now.set(np, out);
      tree.now.set(op, null);
      return { old: op, new: np };
    }
    tree.now.set(op, out);
    return null;
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const sec: USection = { gitOld: m[1], gitNew: m[2], isCreate: false, isDelete: false, hunks: [] };
      i = parseUSection(lines, i + 1, sec);
      sections.push(sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: USection = { gitOld: null, gitNew: null, isCreate: false, isDelete: false, hunks: [] };
      i = parseUSection(lines, i, sec);
      sections.push(sec);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function srBlockEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null || diskExists(path)) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return null;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const model = parseFile(cur);
    const tier = findTier(model.lines, oldLines, strict);
    if (tier === null) throw new Fail('no-match', path);
    const occs = occurrences(model.lines, oldLines, tier);
    if (occs.length > 1) throw new Fail('ambiguous', path);
    const pos = occs[0]!;
    const rep = buildN(
      model.lines,
      pos,
      oldLines.map((t) => ({ text: t, ctx: false })),
      newLines.map((t) => ({ text: t, ctx: false })),
      tier,
    );
    model.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, serializeFile(model));
    return null;
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i;
      let path: string | null = null;
      for (let j = i - 1; j > prevEnd; j -= 1) {
        const t = lines[j]!.trim();
        if (t === '') continue;
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${i + 1}`);
      let eq = -1;
      for (let k = i + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '=======') {
          eq = k;
          break;
        }
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
      let end = -1;
      for (let k = eq + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          end = k;
          break;
        }
      }
      if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
      edits.push(srBlockEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, end), strict));
      prevPath = path;
      prevEnd = end;
      i = end + 1;
    } else {
      i += 1;
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
  O: OLine[];
  N: OLine[];
}

function chunkLines(c: VChunk): void {
  c.O = [];
  c.N = [];
  for (const bl of c.body) {
    if (bl.kind === ' ') {
      c.O.push({ text: bl.text, ctx: true });
      c.N.push({ text: bl.text, ctx: true });
    } else if (bl.kind === '-') c.O.push({ text: bl.text, ctx: false });
    else if (bl.kind === '+') c.N.push({ text: bl.text, ctx: false });
  }
}

/** Apply one chunk; returns the cursor just after the lines written. */
function applyVChunk(model: FileModel, c: VChunk, cursor: number, strict: boolean, failPath: string): number {
  let cur = cursor;
  if (c.anchor !== null) {
    const a = c.anchor;
    let found = -1;
    const max = strict ? 0 : 2;
    for (let t = 0; t <= max && found < 0; t += 1) {
      for (let i = cur; i < model.lines.length; i += 1) {
        if (lineEq(model.lines[i]!, a, t)) {
          found = i;
          break;
        }
      }
    }
    if (found < 0) throw new Fail('no-match', failPath);
    cur = found + 1;
  }
  const otexts = c.O.map((o) => o.text);
  if (c.O.length === 0) {
    const pos = c.eof ? model.lines.length : cur;
    model.lines.splice(pos, 0, ...c.N.map((n) => n.text));
    return pos + c.N.length;
  }
  const tier = findTier(model.lines, otexts, strict, cur, c.eof);
  if (tier === null) throw new Fail('no-match', failPath);
  const occs = occurrences(model.lines, otexts, tier, cur, c.eof);
  const pos = occs[0]!;
  const rep = buildN(model.lines, pos, c.O, c.N, tier);
  model.lines.splice(pos, c.O.length, ...rep);
  return pos + rep.length;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File:')) {
      const path = l.slice('*** Add File:'.length).trim();
      const content: string[] = [];
      i += 1;
      while (i < last) {
        const b = lines[i]!;
        if (isSectionStart(b)) break;
        if (b.startsWith('*** ')) throw new Exit2(`error: parse ${i + 1}`);
        if (b.startsWith('+')) {
          content.push(b.slice(1));
          i += 1;
          continue;
        }
        if (b === '') {
          content.push('');
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null || diskExists(path)) throw new Fail('exists', path);
        tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
        return null;
      });
      continue;
    }
    if (l.startsWith('*** Delete File:')) {
      const path = l.slice('*** Delete File:'.length).trim();
      i += 1;
      while (i < last) {
        const b = lines[i]!;
        if (blank(b)) {
          i += 1;
          continue;
        }
        if (isSectionStart(b)) break;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
        return null;
      });
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      const path = l.slice('*** Update File:'.length).trim();
      const updateLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let seenChunk = false;
      // Blank lines at the end of a section are not part of it (section 8); blank lines before the
      // next chunk are body lines of the chunk they follow, so only trim at the section's end.
      const pushCur = (atSectionEnd: boolean): void => {
        if (cur !== null) {
          if (atSectionEnd) {
            while (cur.body.length > 0 && cur.body[cur.body.length - 1]!.kind === ' ' && cur.body[cur.body.length - 1]!.text === '') cur.body.pop();
          }
          chunkLines(cur);
          chunks.push(cur);
          cur = null;
          seenChunk = true;
        }
      };
      while (i < last) {
        const b = lines[i]!;
        if (isSectionStart(b)) break;
        if (b.startsWith('*** End of File')) {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          chunkLines(cur);
          chunks.push(cur);
          cur = null;
          seenChunk = true;
          i += 1;
          continue;
        }
        if (b.startsWith('*** ')) throw new Exit2(`error: parse ${i + 1}`);
        if (b.startsWith('@@')) {
          pushCur(false);
          cur = { anchor: b.slice(2).trim() === '' ? null : b.slice(2).trim(), body: [], eof: false, O: [], N: [] };
          i += 1;
          continue;
        }
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b === '') {
          if (cur === null) {
            if (seenChunk) {
              if (b === '') {
                i += 1;
                continue;
              }
              throw new Exit2(`error: parse ${i + 1}`);
            }
            cur = { anchor: null, body: [], eof: false, O: [], N: [] };
          }
          cur.body.push({ kind: b === '' ? ' ' : (b[0] as BodyLine['kind']), text: b === '' ? '' : b.slice(1) });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      pushCur(true);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const curText = tree.get(path);
        if (curText === null) throw new Fail('missing', path);
        if (moveTo !== null && (tree.get(moveTo) !== null || diskExists(moveTo))) throw new Fail('exists', moveTo);
        const model = parseFile(curText);
        let cursor = 0;
        for (const c of chunks) cursor = applyVChunk(model, c, cursor, strict, path);
        const out = serializeFile(model);
        if (moveTo !== null) {
          tree.now.set(moveTo, out);
          tree.now.set(path, null);
          return { old: path, new: moveTo };
        }
        tree.now.set(path, out);
        return null;
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 1, 2 and 10: invocation, output, order and atomicity.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Move[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const mv = edit(tree);
      if (mv !== null) moves.push(mv);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const byPath = new Map<string, Row>();
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const row: Row = { key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` };
    rows.push(row);
    byPath.set(p, row);
  }
  for (const mv of moves) {
    const dRow = byPath.get(mv.old);
    const aRow = byPath.get(mv.new);
    if (dRow !== undefined && dRow.line.startsWith('D ') && aRow !== undefined && aRow.line.startsWith('A ')) {
      rows.splice(rows.indexOf(dRow), 1);
      rows.splice(rows.indexOf(aRow), 1);
      byPath.delete(mv.old);
      byPath.delete(mv.new);
      rows.push({ key: mv.new, line: `R ${mv.old} -> ${mv.new}` });
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
