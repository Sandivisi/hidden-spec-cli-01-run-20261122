// mend: apply an AI-written edit to a tree of text files.
//
// Reads one patch in unified diff, SEARCH/REPLACE, V4A or JSON form, finds the
// lines each edit names at the first of three matching tiers, and writes every
// change or none at all. Node 22, standard library only; run as
// `node main.ts [options] [PATCH]` with the working directory as the tree root.
//
// When the trial environment variable is present this file hands the run over
// to runner.ts instead; see the bottom of the file.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown when the patch cannot be read in its format; carries the patch line. */
class ParseFault extends Error {
  readonly lineNo: number;
  constructor(lineNo: number) {
    super(`parse ${lineNo}`);
    this.lineNo = lineNo;
  }
}

/** Thrown by one edit that cannot be applied; carries the failure code and path. */
class EditFault extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlankLine = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function splitPatchText(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function pathIsSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function bytesCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** One file's text viewed as lines plus its line break and final-break flag. */
interface FileDoc {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function readDoc(text: string): FileDoc {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const firstLf = text.indexOf('\n');
  const br = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const pieces = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) pieces.pop();
  return { br, lines: pieces, finalBreak };
}

function writeDoc(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.finalBreak ? doc.br : '');
}

/** The tree as the edits leave it: pending changes over the files on disk. */
class WorkTree {
  private seen = new Map<string, string | null>();
  pending = new Map<string, string | null>();
  moves: { from: string; to: string }[] = [];

  /** The file's bytes before the patch, or null when it did not exist. */
  before(p: string): string | null {
    if (!this.seen.has(p)) {
      let value: string | null = null;
      try {
        if (statSync(p).isFile()) value = readFileSync(p, 'utf8');
      } catch {
        value = null;
      }
      this.seen.set(p, value);
    }
    return this.seen.get(p)!;
  }

  /** The file's bytes as earlier edits left them, or null when it is gone. */
  current(p: string): string | null {
    return this.pending.has(p) ? this.pending.get(p)! : this.before(p);
  }

  set(p: string, value: string | null): void {
    this.pending.set(p, value);
  }

  snapshot(): { pending: Map<string, string | null>; moves: number } {
    return { pending: new Map(this.pending), moves: this.moves.length };
  }

  restore(snap: { pending: Map<string, string | null>; moves: number }): void {
    this.pending = snap.pending;
    this.moves.length = snap.moves;
  }
}

type EditFn = (tree: WorkTree) => void;

/** Leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Positions where O occurs in the file's lines at the first tier that has any. */
function locateOccurrences(
  fileLines: string[],
  oldLines: { text: string }[],
  strict: boolean,
): { tier: number; at: number[] } | null {
  for (const tier of tiersToTry(strict)) {
    const at: number[] = [];
    for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
      let ok = true;
      for (let k = 0; k < oldLines.length; k++) {
        if (normLine(fileLines[i + k]!, tier) !== normLine(oldLines[k]!.text, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of a replacement: its text, and whether it is a context line. */
interface PatchLine {
  text: string;
  ctx: boolean;
}

/** Re-indent one new line at tier 2: replace O's leading whitespace with the file's. */
function reindent(line: string, tier: number, fileWs: string, patchWs: string): string {
  if (tier !== 2) return line;
  if (line.trim() === '') return line;
  if (!line.startsWith(patchWs)) return line;
  return fileWs + line.slice(patchWs.length);
}

/**
 * Build the file's lines after replacing the matched block at `pos` with N.
 * Context lines of N are taken from the file's own matched lines.
 */
function spliceReplacement(
  fileLines: string[],
  pos: number,
  oldLines: PatchLine[],
  newLines: PatchLine[],
  tier: number,
): string[] {
  const oldCtxAt: number[] = [];
  for (let k = 0; k < oldLines.length; k++) {
    if (oldLines[k]!.ctx) oldCtxAt.push(k);
  }
  const fileWs = oldLines.length > 0 ? leadingWs(fileLines[pos]!) : '';
  const patchWs = oldLines.length > 0 ? leadingWs(oldLines[0]!.text) : '';
  let seenCtx = 0;
  const replacement = newLines.map((entry) => {
    if (entry.ctx) {
      const v = fileLines[pos + oldCtxAt[seenCtx]!]!;
      seenCtx += 1;
      return v;
    }
    return reindent(entry.text, tier, fileWs, patchWs);
  });
  return [...fileLines.slice(0, pos), ...replacement, ...fileLines.slice(pos + oldLines.length)];
}

/** Guess the patch format from its lines, or null when none of the signs hold. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlankLine(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const head = lines[first]!.trimStart()[0];
  if (head === '[' || head === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/** Split an O/N pair out of a hunk or chunk body, skipping backslash lines. */
function splitBody(body: { kind: string; text: string }[]): { oldLines: PatchLine[]; newLines: PatchLine[] } {
  const oldLines: PatchLine[] = [];
  const newLines: PatchLine[] = [];
  for (const entry of body) {
    if (entry.kind === 'ctx') {
      oldLines.push({ text: entry.text, ctx: true });
      newLines.push({ text: entry.text, ctx: true });
    } else if (entry.kind === 'old') {
      oldLines.push({ text: entry.text, ctx: false });
    } else if (entry.kind === 'new') {
      newLines.push({ text: entry.text, ctx: false });
    }
  }
  return { oldLines, newLines };
}

/** Whether a backslash line directly follows the body's last context or new line. */
function noEolAfterLast(body: { kind: string; text: string }[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') last = i;
  }
  if (last < 0) return false;
  return body[last + 1]?.kind === 'backslash';
}

/** Apply a section's hunks in order to a file's text; throws EditFault on no-match. */
function applyHunks(text: string, hunks: { start: number; body: { kind: string; text: string }[] }[], strict: boolean, path: string): string {
  const doc = readDoc(text);
  let drift = 0;
  for (const hunk of hunks) {
    const { oldLines, newLines } = splitBody(hunk.body);
    const noEol = noEolAfterLast(hunk.body);
    if (oldLines.length === 0) {
      const insertAt = Math.min(hunk.start + drift, doc.lines.length);
      const atEnd = insertAt === doc.lines.length;
      const added = newLines.map((e) => e.text);
      doc.lines = [...doc.lines.slice(0, insertAt), ...added, ...doc.lines.slice(insertAt)];
      if (atEnd && added.length > 0) doc.finalBreak = !noEol;
      drift += newLines.length - oldLines.length;
      continue;
    }
    const found = locateOccurrences(doc.lines, oldLines, strict);
    if (found === null) throw new EditFault('no-match', path);
    const want = hunk.start - 1 + drift;
    let best = found.at[0]!;
    let bestGap = Math.abs(best - want);
    for (const p of found.at) {
      const gap = Math.abs(p - want);
      if (gap < bestGap) {
        best = p;
        bestGap = gap;
      }
    }
    const runsToEnd = best + oldLines.length === doc.lines.length;
    doc.lines = spliceReplacement(doc.lines, best, oldLines, newLines, found.tier);
    if (runsToEnd) doc.finalBreak = !noEol;
    drift += newLines.length - oldLines.length;
  }
  return writeDoc(doc);
}

// ---- unified diffs ----

interface UnifiedSection {
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null;
  headNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: { start: number; body: { kind: string; text: string }[] }[];
}

function headerPath(line: string): string {
  const rest = line.slice(4);
  const tabAt = rest.indexOf('\t');
  const raw = (tabAt < 0 ? rest : rest.slice(0, tabAt)).trim();
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function parseDiffGit(line: string, lineNo: number): [string, string] {
  const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  if (m === null) throw new ParseFault(lineNo);
  return [m[1]!, m[2]!];
}

/** Read one hunk starting at lines[i]; returns the hunk and the next line index. */
function readHunk(lines: string[], i: number): { hunk: UnifiedSection['hunks'][number]; next: number } {
  const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
  if (head === null) throw new ParseFault(i + 1);
  const start = parseInt(head[1]!, 10);
  const body: { kind: string; text: string }[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '' });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+') {
      body.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', text: l.slice(1) });
      j++;
      continue;
    }
    if (c === '\\') {
      body.push({ kind: 'backslash', text: l });
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0) {
    const tail = body[body.length - 1]!;
    if (tail.kind === 'ctx' && tail.text === '') body.pop();
    else break;
  }
  return { hunk: { start, body }, next: j };
}

function unifiedSectionEdit(section: UnifiedSection, strict: boolean): EditFn {
  return (tree) => {
    const oldPath = section.headOld ?? section.renameFrom ?? section.diffOld;
    const newPath = section.headNew ?? section.renameTo ?? section.diffNew;
    const isCreate = section.createFlag || oldPath === '/dev/null';
    const isDelete = !isCreate && (section.deleteFlag || newPath === '/dev/null');
    if (isCreate) {
      if (!pathIsSafe(newPath!)) throw new EditFault('unsafe', newPath!);
      if (tree.current(newPath!) !== null) throw new EditFault('exists', newPath!);
      const added: string[] = [];
      let endsBare = true;
      for (let h = section.hunks.length - 1; h >= 0; h--) {
        const body = section.hunks[h]!.body;
        if (body.some((e) => e.kind === 'new')) {
          endsBare = !noEolAfterLast(body);
          break;
        }
      }
      for (const hunk of section.hunks) {
        for (const e of hunk.body) if (e.kind === 'new') added.push(e.text);
      }
      tree.set(newPath!, added.length === 0 ? '' : added.join('\n') + (endsBare ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (!pathIsSafe(oldPath!)) throw new EditFault('unsafe', oldPath!);
      if (tree.current(oldPath!) === null) throw new EditFault('missing', oldPath!);
      tree.set(oldPath!, null);
      return;
    }
    if (oldPath !== newPath) {
      if (!pathIsSafe(oldPath!)) throw new EditFault('unsafe', oldPath!);
      if (!pathIsSafe(newPath!)) throw new EditFault('unsafe', newPath!);
      const before = tree.current(oldPath!);
      if (before === null) throw new EditFault('missing', oldPath!);
      if (tree.current(newPath!) !== null) throw new EditFault('exists', newPath!);
      const after = applyHunks(before, section.hunks, strict, oldPath!);
      tree.set(oldPath!, null);
      tree.set(newPath!, after);
      tree.moves.push({ from: oldPath!, to: newPath! });
      return;
    }
    if (!pathIsSafe(oldPath!)) throw new EditFault('unsafe', oldPath!);
    const before = tree.current(oldPath!);
    if (before === null) throw new EditFault('missing', oldPath!);
    tree.set(oldPath!, applyHunks(before, section.hunks, strict, oldPath!));
  };
}

function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const sections: UnifiedSection[] = [];
  let current: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;
  const freshSection = (): UnifiedSection => ({
    diffOld: null,
    diffNew: null,
    headOld: null,
    headNew: null,
    renameFrom: null,
    renameTo: null,
    createFlag: false,
    deleteFlag: false,
    hunks: [],
  });
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const [x, y] = parseDiffGit(line, i + 1);
      current = freshSection();
      current.diffOld = x;
      current.diffNew = y;
      sections.push(current);
      inHeader = true;
      i++;
      continue;
    }
    if (current !== null && inHeader) {
      if (line.startsWith('--- ')) {
        const next = lines[i + 1];
        if (next === undefined || !next.startsWith('+++ ')) throw new ParseFault(i + 2);
        current.headOld = headerPath(line);
        current.headNew = headerPath(next);
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) {
        const { hunk, next } = readHunk(lines, i);
        current.hunks.push(hunk);
        i = next;
        inHeader = false;
        continue;
      }
      if (line.startsWith('rename from ')) {
        current.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        current.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        current.createFlag = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        current.deleteFlag = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (current !== null && !inHeader) {
      if (line.startsWith('@@')) {
        const { hunk, next } = readHunk(lines, i);
        current.hunks.push(hunk);
        i = next;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        current = freshSection();
        sections.push(current);
        inHeader = true;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      current = freshSection();
      sections.push(current);
      inHeader = true;
      continue;
    }
    if (line.startsWith('@@')) throw new ParseFault(i + 1);
    i++;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

// ---- SEARCH/REPLACE blocks ----

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): EditFn {
  return (tree) => {
    if (!pathIsSafe(path)) throw new EditFault('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.current(path) !== null) throw new EditFault('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.current(path);
    if (before === null) throw new EditFault('missing', path);
    const doc = readDoc(before);
    const oldWrapped = oldLines.map((t) => ({ text: t, ctx: false }));
    const newWrapped = newLines.map((t) => ({ text: t, ctx: false }));
    const found = locateOccurrences(doc.lines, oldWrapped, strict);
    if (found === null) throw new EditFault('no-match', path);
    if (found.at.length > 1) throw new EditFault('ambiguous', path);
    doc.lines = spliceReplacement(doc.lines, found.at[0]!, oldWrapped, newWrapped, found.tier);
    tree.set(path, writeDoc(doc));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j > prevEnd; j--) {
      const candidate = lines[j]!;
      if (isBlankLine(candidate)) continue;
      if (candidate.trim().startsWith('```')) continue;
      path = candidate.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFault(searchAt + 1);
      path = prevPath;
    }
    let splitAt = -1;
    for (let j = searchAt + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        splitAt = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (splitAt < 0) throw new ParseFault(searchAt + 1);
    let endAt = -1;
    for (let j = splitAt + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        endAt = j;
        break;
      }
    }
    if (endAt < 0) throw new ParseFault(searchAt + 1);
    edits.push(
      searchReplaceEdit(path, lines.slice(searchAt + 1, splitAt), lines.slice(splitAt + 1, endAt), strict),
    );
    prevEnd = endAt;
    prevPath = path;
    i = endAt + 1;
  }
  return edits;
}

// ---- V4A patches ----

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: { kind: string; text: string }[];
}

function v4aSectionStart(line: string): boolean {
  return (
    line.startsWith('*** Add File: ') ||
    line.startsWith('*** Delete File: ') ||
    line.startsWith('*** Update File: ')
  );
}

function v4aUpdateEdit(
  path: string,
  moveTo: string | null,
  chunks: V4aChunk[],
  strict: boolean,
): EditFn {
  return (tree) => {
    if (!pathIsSafe(path)) throw new EditFault('unsafe', path);
    const before = tree.current(path);
    if (before === null) throw new EditFault('missing', path);
    if (moveTo !== null) {
      if (!pathIsSafe(moveTo)) throw new EditFault('unsafe', moveTo);
      if (tree.current(moveTo) !== null) throw new EditFault('exists', moveTo);
    }
    const doc = readDoc(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        let foundAt = -1;
        for (const tier of tiersToTry(strict)) {
          for (let k = cursor; k < doc.lines.length; k++) {
            if (normLine(doc.lines[k]!, tier) === normLine(chunk.anchor, tier)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new EditFault('no-match', path);
        cursor = foundAt + 1;
      }
      const { oldLines, newLines } = splitBody(chunk.body);
      if (oldLines.length === 0) {
        const insertAt = chunk.eof ? doc.lines.length : cursor;
        const added = newLines.map((e) => e.text);
        doc.lines = [...doc.lines.slice(0, insertAt), ...added, ...doc.lines.slice(insertAt)];
        cursor = insertAt + newLines.length;
        continue;
      }
      let picked: number | null = null;
      let pickedTier = 0;
      for (const tier of tiersToTry(strict)) {
        for (let k = cursor; k + oldLines.length <= doc.lines.length; k++) {
          if (chunk.eof && k + oldLines.length !== doc.lines.length) continue;
          let ok = true;
          for (let m = 0; m < oldLines.length; m++) {
            if (normLine(doc.lines[k + m]!, tier) !== normLine(oldLines[m]!.text, tier)) {
              ok = false;
              break;
            }
          }
          if (ok) {
            picked = k;
            pickedTier = tier;
            break;
          }
        }
        if (picked !== null) break;
      }
      if (picked === null) throw new EditFault('no-match', path);
      doc.lines = spliceReplacement(doc.lines, picked, oldLines, newLines, pickedTier);
      cursor = picked + newLines.length;
    }
    const after = writeDoc(doc);
    if (moveTo !== null) {
      tree.set(path, null);
      tree.set(moveTo, after);
      tree.moves.push({ from: path, to: moveTo });
    } else {
      tree.set(path, after);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !isBlankLine(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlankLine(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);
  const edits: EditFn[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const made: { text: string; plus: boolean }[] = [];
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (v4aSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('+')) {
          made.push({ text: l.slice(1), plus: true });
          j++;
          continue;
        }
        if (l === '') {
          made.push({ text: '', plus: false });
          j++;
          continue;
        }
        throw new ParseFault(j + 1);
      }
      while (made.length > 0 && !made[made.length - 1]!.plus) made.pop();
      const fileLines = made.map((e) => e.text);
      edits.push(((p, fl) => (tree: WorkTree) => {
        if (!pathIsSafe(p)) throw new EditFault('unsafe', p);
        if (tree.current(p) !== null) throw new EditFault('exists', p);
        tree.set(p, fl.length === 0 ? '' : fl.join('\n') + '\n');
      })(path, fileLines));
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      edits.push(((p) => (tree: WorkTree) => {
        if (!pathIsSafe(p)) throw new EditFault('unsafe', p);
        if (tree.current(p) === null) throw new EditFault('missing', p);
        tree.set(p, null);
      })(path));
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateAt = i;
      let moveTo: string | null = null;
      let j = i + 1;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      const closeChunk = (atBoundary: boolean): void => {
        if (cur === null) return;
        if (atBoundary) {
          while (cur.body.length > 0) {
            const tail = cur.body[cur.body.length - 1]!;
            if (tail.kind === 'ctx' && tail.text.trim() === '') cur.body.pop();
            else break;
          }
        }
        chunks.push(cur);
        cur = null;
      };
      while (j < last) {
        const l = lines[j]!;
        if (v4aSectionStart(l) || l.trim() === '*** End Patch') {
          closeChunk(true);
          break;
        }
        if (l.startsWith('@@')) {
          closeChunk(false);
          cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
          j++;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new ParseFault(j + 1);
          cur.eof = true;
          closeChunk(false);
          j++;
          continue;
        }
        if (l.startsWith('*** Move to: ')) throw new ParseFault(j + 1);
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new ParseFault(j + 1);
            cur = { anchor: null, eof: false, body: [] };
          }
          cur.body.push({
            kind: l === '' ? 'ctx' : l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new',
            text: l === '' ? '' : l.slice(1),
          });
          j++;
          continue;
        }
        throw new ParseFault(j + 1);
      }
      closeChunk(true);
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(updateAt + 1);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new ParseFault(i + 1);
  }
  return edits;
}

// ---- JSON edits ----

function jsonEditObject(value: unknown): EditFn | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const path = obj.path;
  if (typeof path !== 'string') return null;
  if (obj.command === 'create' && typeof obj.file_text === 'string') {
    const text = obj.file_text;
    return (tree) => {
      if (!pathIsSafe(path)) throw new EditFault('unsafe', path);
      if (tree.current(path) !== null) throw new EditFault('exists', path);
      tree.set(path, text);
    };
  }
  if (
    obj.command === 'str_replace' &&
    typeof obj.old_str === 'string' &&
    obj.old_str !== '' &&
    (obj.new_str === undefined || typeof obj.new_str === 'string')
  ) {
    const oldStr = obj.old_str;
    const newStr = (obj.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!pathIsSafe(path)) throw new EditFault('unsafe', path);
      const before = tree.current(path);
      if (before === null) throw new EditFault('missing', path);
      const firstLf = before.indexOf('\n');
      const crlf = firstLf > 0 && before[firstLf - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFault('no-match', path);
      if (count > 1) throw new EditFault('ambiguous', path);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.set(path, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    obj.command === 'insert' &&
    typeof obj.insert_line === 'number' &&
    Number.isInteger(obj.insert_line) &&
    typeof obj.new_str === 'string'
  ) {
    const atLine = obj.insert_line;
    const added = splitPatchText(obj.new_str);
    return (tree) => {
      if (!pathIsSafe(path)) throw new EditFault('unsafe', path);
      const before = tree.current(path);
      if (before === null) throw new EditFault('missing', path);
      const doc = readDoc(before);
      if (atLine < 0 || atLine > doc.lines.length) throw new EditFault('no-match', path);
      doc.lines.splice(atLine, 0, ...added);
      tree.set(path, writeDoc(doc));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlankLine(l));
  if (first < 0) throw new ParseFault(1);
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(parsed)) throw new ParseFault(first + 1);
    for (const item of parsed) {
      const edit = jsonEditObject(item);
      if (edit === null) throw new ParseFault(first + 1);
      edits.push(edit);
    }
    return edits;
  }
  lines.forEach((line, idx) => {
    if (isBlankLine(line)) return;
    let edit: EditFn | null = null;
    try {
      edit = jsonEditObject(JSON.parse(line));
    } catch {
      edit = null;
    }
    if (edit === null) throw new ParseFault(idx + 1);
    edits.push(edit);
  });
  return edits;
}

/** Parse the command line; returns null on a usage error. */
function parseArgs(args: string[]): {
  format: string | null;
  check: boolean;
  strict: boolean;
  patch: string | null;
} | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const positional: string[] = [];
  let optionsEnded = false;
  for (const arg of args) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=')) {
        const value = arg.slice('--format='.length);
        if (format !== null || !FORMAT_NAMES.includes(value)) return null;
        format = value;
      } else if (arg === '--check') {
        if (check) return null;
        check = true;
      } else if (arg === '--strict') {
        if (strict) return null;
        strict = true;
      } else {
        return null;
      }
      continue;
    }
    positional.push(arg);
  }
  if (positional.length > 1) return null;
  return { format, check, strict, patch: positional.length === 0 ? null : positional[0]! };
}

interface RunResult {
  code: number;
  out: string[];
}

/** The rows printed on success: one per changed path, byte-ordered, R rows by new path. */
function successRows(tree: WorkTree): { key: string; line: string }[] {
  const rows: { key: string; line: string }[] = [];
  for (const p of tree.pending.keys()) {
    const was = tree.before(p);
    const now = tree.pending.get(p)!;
    if (was === now) continue;
    const kind = was === null ? 'A' : now === null ? 'D' : 'M';
    rows.push({ key: p, line: `${kind} ${p}` });
  }
  for (const mv of tree.moves) {
    const oldWas = tree.before(mv.from);
    const oldNow = tree.pending.get(mv.from);
    const newWas = tree.before(mv.to);
    const newNow = tree.pending.get(mv.to);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      for (let k = rows.length - 1; k >= 0; k--) {
        if (rows[k]!.key === mv.from || rows[k]!.key === mv.to) rows.splice(k, 1);
      }
      rows.push({ key: mv.to, line: `R ${mv.from} -> ${mv.to}` });
    }
  }
  rows.sort((a, b) => bytesCompare(a.key, b.key) || bytesCompare(a.line, b.line));
  return rows;
}

function runCli(args: string[]): RunResult {
  const parsed = parseArgs(args);
  if (parsed === null) return { code: 2, out: ['error: usage'] };
  const { format, check, strict } = parsed;
  const patchArg = parsed.patch;
  let text = '';
  try {
    text = readFileSync(patchArg === null || patchArg === '-' ? 0 : patchArg, 'utf8');
  } catch {
    if (patchArg !== null && patchArg !== '-') return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatchText(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else if (kind === 'v4a') edits = parseV4a(lines, strict);
    else edits = parseJson(text, lines);
    if (edits.length === 0) throw new ParseFault(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.lineNo}`] };
    throw e;
  }
  const tree = new WorkTree();
  const failures: EditFault[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.restore(snap);
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      out: [
        ...failures.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${failures.length} of ${edits.length} edits`,
      ],
    };
  }
  const rows = successRows(tree);
  if (!check) {
    for (const p of tree.pending.keys()) {
      const was = tree.before(p);
      const now = tree.pending.get(p)!;
      if (was === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const countLine = `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`;
  return { code: 0, out: [...rows.map((r) => r.line), countLine] };
}

const trialEndpoint = process.env.MAKEFUN_ENV_URL;
if (trialEndpoint !== undefined && trialEndpoint !== '') {
  // A trial run: let the kit's runner read the checks from the environment and
  // drive this file over each one, without the variable set.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEndpoint);
} else {
  const outcome = runCli(process.argv.slice(2));
  writeSync(1, outcome.out.map((line) => `${line}\n`).join(''));
  process.exitCode = outcome.code;
}
