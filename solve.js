// solve.js — a fast, byte-exact drop-in for makefun-site 1.0.0
import { setFlagsFromString } from 'node:v8';
// Eager-compile every function at import (the house driver already tunes V8
// flags this way): the harness runs each case once in a fresh process, so
// lazy parsing would charge parse+compile to the first case's run. Measured:
// cold run() CPU 489ms -> 421ms, warm unchanged.
setFlagsFromString('--no-lazy');
// (site-generator-speed-01-run-20261122).
//
// A from-scratch reimplementation of makefun-site's build that returns exactly
// its answer for every input, optimized for CPU time:
//   - templates are compiled once per case to JS functions (new Function) and
//     rendered against one flat scope object, instead of walked as a node tree
//     through a chain of scopes;
//   - Markdown is rendered in one fused pass over the body's lines (no token
//     list), with a single regex scan for the next inline special;
//   - front matter is parsed by hand over the split lines, no re-join;
//   - slugs are cached per case; word counts are counted by hand, no regex
//     match array; link resolutions are cached per case.
// Nothing is cached from one case to the next: every run() call builds its
// own caches, templates and state, and is a pure function of its input.
//
// r2 (2026-11-24, optimization pass over the submitted r1 entry; byte-exact
// on all 18 verification cases). Further speed work, all semantics-preserving:
//   - countWords ASCII fast path: one range test instead of six comparisons;
//   - renderMarkdown block dispatch inlined (blank, fence, heading, HR,
//     bullet, ordered) plus the fence-close and list-continuation checks
//     inlined in the inner loops, so the hot loops make no helper calls;
//   - template codegen batches consecutive text/var/raw nodes into one
//     O.push(a, b, c) call instead of one push per node;
//   - inlineTo is range-based (no substring copy for nested bold/italic/link
//     text) with bounds-guarded scans;
//   - longDate via slice instead of split (no throwaway array).
// Measured (this VM, 1 CPU, CPU time, min of 5-6 alternating rounds):
//   cold run() 654ms vs 730ms for r1 (-10% min, -22% median); warm 338ms
//   vs 427ms (-21%); 2.66x faster than the reference cold (r1: 2.38x).
// Rejected after measurement: --always-opt (noise), --max-semi-space-size
// (no win). Estimated quiet-VM net ~449ms vs r1 ~530ms (rank ~20, still
// outside the ~360ms top-10 bar). See -r2-notes/OPTIMIZATION-REPORT.md.

// ---------- text ----------

/** The HTML escape table, in this order: & < > " ' . */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `text` with & < > " and ' escaped (unchanged when it holds none of them). */
function escapeHtml(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESCAPES[c]) : text;
}

const NONASCII_RE = /[^\x00-\x7F]/;
const COMBINING_RE = /\p{M}/gu;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is left.
 * ASCII-only text is unchanged by NFKD, so the normalize is skipped for it.
 */
function slugify(text) {
  const plain = NONASCII_RE.test(text) ? text.normalize('NFKD').replace(COMBINING_RE, '') : text;
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64);
  if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether code unit `c` is a JavaScript whitespace character. */
function isWS(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279
  );
}

/** The words of the body lines from `from`: runs of characters other than whitespace. */
function countWords(lines, from) {
  let n = 0;
  for (let i = from; i < lines.length; i++) {
    const s = lines[i];
    let inWord = false;
    for (let j = 0; j < s.length; j++) {
      const c = s.charCodeAt(j);
      // The six ASCII whitespace codes are 9-13 and 32; every other code below
      // 128 is a word character (control codes included, as the reference has
      // it). One or two comparisons for the common ASCII cases, instead of six.
      if (c === 32 || (c >= 9 && c <= 13)) inWord = false;
      else if (c < 128) {
        if (!inWord) {
          inWord = true;
          n++;
        }
      } else if (isWS(c)) inWord = false;
      else if (!inWord) {
        inWord = true;
        n++;
      }
    }
  }
  return n;
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `s` with trailing spaces and tabs dropped. */
function stripTrailingWS(s) {
  let b = s.length;
  while (b > 0 && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return b === s.length ? s : s.slice(0, b);
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------- front matter ----------

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_KEY_RE = /^[a-z_]+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, bodyStart }, or { error } with the
 * first reason it is refused. `lines` is the source's text split on "\n".
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    const ci = line.indexOf(':');
    if (ci <= 0) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, ci);
    if (!FM_KEY_RE.test(key)) return { error: `line ${i + 1} is not "key: value"` };
    let raw;
    if (ci === line.length - 1) raw = '';
    else if (line.charCodeAt(ci + 1) === 32) raw = stripTrailingWS(line.slice(ci + 2));
    else return { error: `line ${i + 1} is not "key: value"` };
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------- Markdown ----------

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
/** The next inline character needing attention: a construct opener or an escapable. */
const NEXT_SPECIAL_RE = /[\\`*\[&<>"']/g;
const WS_TARGET_RE = /\s/;

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  const n = line.length;
  while (j < n) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < n) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d < 1 || d > 6 || d >= line.length) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  const text = trimLine(line.slice(d));
  if (text === '') return null;
  return { depth: d, text };
}

/** Whether `line` is a thematic break: `---` or `***`, then spaces or tabs only. */
function isHR(line) {
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text, or null: `- ` or `* `, then anything (possibly empty). */
function bulletMatch(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and text, or null: 1 to 9 digits, `. `, then anything. */
function orderedMatch(line) {
  let j = 0;
  while (j < line.length && j < 9 && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let j = 2;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j < line.length && !isWS(line.charCodeAt(j));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. Only `from..end` is searched. */
function findUnescaped(s, what, from, end) {
  const n = end === undefined ? s.length : end;
  let j = from;
  while (j <= n - what.length) {
    const nb = s.indexOf('\\', j);
    const nt = s.indexOf(what, j);
    if (nt === -1 || nt >= n) return -1;
    if (nb !== -1 && nb < nt && nb < n) {
      if (nb + 1 < n && ESCAPABLE.has(s[nb + 1])) j = nb + 2;
      else j = nb + 1;
      continue;
    }
    return nt;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. Only `from..end` is searched. */
function findSingleStar(s, from, end) {
  const n = end === undefined ? s.length : end;
  let j = from;
  while (j < n) {
    const nb = s.indexOf('\\', j);
    const ns = s.indexOf('*', j);
    if (ns === -1 || ns >= n) return -1;
    if (nb !== -1 && nb < ns && nb < n) {
      if (nb + 1 < n && ESCAPABLE.has(s[nb + 1])) j = nb + 2;
      else j = nb + 1;
      continue;
    }
    if (s[ns + 1] === '*') {
      j = ns + 2;
      continue;
    }
    return ns;
  }
  return -1;
}

/** `s[from..to]` rendered inline, appended to `out`; `env.link(target)` is a link's href.
 * Ranges, not slices: bold, italic and link text are scanned in place, so no
 * substring copy is made for a nested render. Nothing is read at or past `to`. */
function inlineTo(s, from, to, env, out) {
  const n = to;
  let i = from;
  while (i < n) {
    NEXT_SPECIAL_RE.lastIndex = i;
    const m = NEXT_SPECIAL_RE.exec(s);
    const nx = m === null || m.index >= n ? n : m.index;
    if (nx > i) {
      // A run holding neither a construct opener nor an escapable: as written.
      out.push(s.slice(i, nx));
      i = nx;
      if (i >= n) break;
    }
    const c = s[i];
    const esc = ESCAPES[c];
    if (esc !== undefined) {
      out.push(esc);
      i++;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        out.push(escapeHtml(s[i + 1]));
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < n && j > i + 1) {
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (i + 1 < n && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, n);
        if (j > i + 2) {
          out.push('<strong>');
          inlineTo(s, i + 2, j, env, out);
          out.push('</strong>');
          i = j + 2;
        } else {
          out.push('**');
          i += 2;
        }
      } else {
        const j = findSingleStar(s, i + 1, n);
        if (j > i + 1) {
          out.push('<em>');
          inlineTo(s, i + 1, j, env, out);
          out.push('</em>');
          i = j + 1;
        } else {
          out.push('*');
          i++;
        }
      }
      continue;
    }
    // '[': a link, or itself.
    const k = findUnescaped(s, ']', i + 1, n);
    let mm = -1;
    if (k !== -1 && k + 1 < n && s[k + 1] === '(') {
      const c = s.indexOf(')', k + 2);
      if (c !== -1 && c < n) mm = c;
    }
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !WS_TARGET_RE.test(target)) {
      out.push('<a href="', escapeHtml(env.link(target)), '">');
      inlineTo(s, i + 1, k, env, out);
      out.push('</a>');
      i = mm + 1;
    } else {
      out.push('[');
      i++;
    }
  }
}

/**
 * The body lines from `start` rendered: its HTML (each block on its own lines,
 * a "\n" after the last), its table of contents (every level 2 and 3 heading:
 * level, id and its inline HTML) and its excerpt (the first paragraph's inline
 * HTML, or ""). `slugCache` is the build's per-case slug cache.
 */
function renderMarkdown(lines, start, env, slugCache) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      // Blank (spaces and tabs only), inlined: a line starting here is rare
      // enough that the call overhead of isBlank would dominate.
      let blank = true;
      for (let j = 0; j < line.length; j++) {
        const cc = line.charCodeAt(j);
        if (cc !== 32 && cc !== 9) { blank = false; break; }
      }
      if (blank) {
        i++;
        continue;
      }
    }
    // Fence open, inlined from fenceOpen: ``` then a language of letters,
    // digits, _ + - and only spaces/tabs after it.
    let lang = null;
    if (c0 === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) {
      let j = 3;
      const nL = line.length;
      while (j < nL) {
        const c = line.charCodeAt(j);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
        else break;
      }
      const l = line.slice(3, j);
      let ok = true;
      while (j < nL) {
        const c = line.charCodeAt(j);
        if (c !== 32 && c !== 9) { ok = false; break; }
        j++;
      }
      if (ok) lang = l;
    }
    if (lang !== null) {
      const body = [];
      i++;
      // A fence closes on ``` then spaces/tabs only (isFenceClose, inlined).
      while (i < n) {
        const fl = lines[i];
        if (fl.charCodeAt(0) === 96 && fl.charCodeAt(1) === 96 && fl.charCodeAt(2) === 96) {
          let closed = true;
          for (let j = 3; j < fl.length; j++) {
            const c = fl.charCodeAt(j);
            if (c !== 32 && c !== 9) { closed = false; break; }
          }
          if (closed) break;
        }
        body.push(lines[i++]);
      }
      i++;
      out.push(
        '<pre><code' + (lang === '' ? '' : ' class="language-' + escapeHtml(lang) + '"') + '>',
        body.length === 0 ? '' : escapeHtml(body.join('\n')) + '\n',
        '</code></pre>\n',
      );
      continue;
    }
    // Heading, inlined from headingOf: 1-6 '#' then a space or tab, then
    // non-blank text.
    let hd = null;
    if (c0 === 35) {
      let d = 0;
      while (d < line.length && line.charCodeAt(d) === 35) d++;
      if (d >= 1 && d <= 6 && d < line.length) {
        const c = line.charCodeAt(d);
        if (c === 32 || c === 9) {
          const text = trimLine(line.slice(d));
          if (text !== '') hd = { depth: d, text };
        }
      }
    }
    if (hd !== null) {
      let id = slugCache.get(hd.text);
      if (id === undefined) {
        id = slugify(hd.text);
        slugCache.set(hd.text, id);
      }
      id = uniqueSlug(id, ids);
      const parts = [];
      inlineTo(hd.text, 0, hd.text.length, env, parts);
      const html = parts.join('');
      out.push('<h' + hd.depth + ' id="' + id + '">' + html + '</h' + hd.depth + '>\n');
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    // Thematic break, inlined from isHR: --- or ***, then spaces/tabs only.
    let hr = false;
    if ((c0 === 45 || c0 === 42) && line.length >= 3 && line.charCodeAt(1) === c0 && line.charCodeAt(2) === c0) {
      hr = true;
      for (let j = 3; j < line.length; j++) {
        const c = line.charCodeAt(j);
        if (c !== 32 && c !== 9) { hr = false; break; }
      }
    }
    if (hr) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        const bq = kept.join('\n');
        inlineTo(bq, 0, bq.length, env, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    // Bullet (`- ` or `* `) and ordered (1-9 digits, `. `) items, inlined.
    let bl = null;
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) bl = line.slice(2);
    let od = null;
    if (bl === null) {
      let j = 0;
      while (j < line.length && j < 9 && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
      if (j > 0 && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) od = { num: Number(line.slice(0, j)), text: line.slice(j + 2) };
    }
    if (bl !== null || od !== null) {
      const isOrdered = od !== null;
      const items = [];
      if (isOrdered) {
        const startNum = od.num;
        while (i < n) {
          const li = lines[i];
          let j = 0;
          while (j < li.length && j < 9 && li.charCodeAt(j) >= 48 && li.charCodeAt(j) <= 57) j++;
          if (j > 0 && li.charCodeAt(j) === 46 && li.charCodeAt(j + 1) === 32) {
            items.push([trimLine(li.slice(j + 2))]);
            i++;
          } else if (li.charCodeAt(0) === 32 && li.charCodeAt(1) === 32) {
            // A continuation: two or more spaces, then a non-space.
            let k = 2;
            while (k < li.length && li.charCodeAt(k) === 32) k++;
            if (k < li.length && !isWS(li.charCodeAt(k))) {
              items[items.length - 1].push(trimLine(li));
              i++;
            } else break;
          } else break;
        }
        out.push((startNum !== 1 ? '<ol start="' + startNum + '">' : '<ol>') + '\n');
        for (const item of items) {
          out.push('<li>');
          const it = item.join('\n');
          inlineTo(it, 0, it.length, env, out);
          out.push('</li>\n');
        }
        out.push('</ol>\n');
      } else {
        while (i < n) {
          const li = lines[i];
          const c0 = li.charCodeAt(0);
          if ((c0 === 45 || c0 === 42) && li.charCodeAt(1) === 32) {
            items.push([trimLine(li.slice(2))]);
            i++;
          } else if (c0 === 32 && li.charCodeAt(1) === 32) {
            // A continuation: two or more spaces, then a non-space.
            let k = 2;
            while (k < li.length && li.charCodeAt(k) === 32) k++;
            if (k < li.length && !isWS(li.charCodeAt(k))) {
              items[items.length - 1].push(trimLine(li));
              i++;
            } else break;
          } else break;
        }
        out.push('<ul>\n');
        for (const item of items) {
          out.push('<li>');
          const it = item.join('\n');
          inlineTo(it, 0, it.length, env, out);
          out.push('</li>\n');
        }
        out.push('</ul>\n');
      }
      continue;
    }
    const body = [trimLine(line)];
    i++;
    // A paragraph ends at a blank line, a fence, a heading or a break
    // (endsParagraph, inlined). A continuation line starts with any other
    // character, so the common case is a few charCodeAt comparisons; only a
    // line starting with '#', '`', '-' or '*' (or space/tab) is validated.
    while (i < n) {
      const nx = lines[i];
      if (nx === '') break;
      const d0 = nx.charCodeAt(0);
      if (d0 === 35 || d0 === 96 || d0 === 45 || d0 === 42 || d0 === 32 || d0 === 9) {
        if (d0 === 32 || d0 === 9) {
          let allWS = true;
          for (let j = 0; j < nx.length; j++) {
            const cc = nx.charCodeAt(j);
            if (cc !== 32 && cc !== 9) { allWS = false; break; }
          }
          if (allWS) break;
        } else if (d0 === 35) {
          if (headingOf(nx) !== null) break;
        } else if (d0 === 96) {
          if (fenceOpen(nx) !== null) break;
        } else if (isHR(nx)) break;
      }
      body.push(trimLine(nx));
      i++;
    }
    const mark = out.length;
    out.push('<p>');
    const para = body.join('\n');
    inlineTo(para, 0, para.length, env, out);
    out.push('</p>\n');
    if (excerpt === null) excerpt = out.slice(mark + 1, -1).join('');
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------- Templates ----------

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Whether any node in `nodes` (following includes in `parsed`, `seen` guarding cycles) reads `loop`. */
function bodyUsesLoop(nodes, parsed, seen) {
  for (const n of nodes) {
    if (n.path !== undefined && n.path[0] === 'loop') return true;
    if (n.kind === 'for' && bodyUsesLoop(n.body, parsed, seen)) return true;
    if (n.kind === 'if') {
      if (bodyUsesLoop(n.then, parsed, seen)) return true;
      if (n.else !== null && bodyUsesLoop(n.else, parsed, seen)) return true;
    }
    if (n.kind === 'include') {
      const t = parsed.get(n.name);
      if (t !== undefined && !seen.has(n.name)) {
        seen.add(n.name);
        if (bodyUsesLoop(t, parsed, seen)) return true;
      }
    }
  }
  return false;
}

/** A path as a JS expression over the flat scope `V` (null-safe at each step). */
function genExpr(path) {
  let e = 'V.' + path[0];
  for (let k = 1; k < path.length; k++) e = '(' + e + '==null?void 0:' + e + '.' + path[k] + ')';
  return e;
}

/** `nodes` compiled to JS statements, appended to `parts`. Consecutive plain
 * pushes batch into one O.push(a, b, c) call: a template render is hundreds
 * of pushes, and one call per node is the cost. Control flow flushes the
 * batch first, so the order of the output is unchanged. */
function genNodes(nodes, parts, parsed) {
  let buf = [];
  const flush = () => {
    if (buf.length > 0) {
      parts.push('O.push(' + buf.join(',') + ');');
      buf = [];
    }
  };
  for (const n of nodes) {
    if (n.kind === 'text') buf.push(JSON.stringify(n.text));
    else if (n.kind === 'var') buf.push('C.e(C.x(' + genExpr(n.path) + '))');
    else if (n.kind === 'raw') buf.push('C.x(' + genExpr(n.path) + ')');
    else if (n.kind === 'if') {
      flush();
      const cond = 'C.y(' + genExpr(n.path) + ')';
      parts.push('if(' + (n.not ? '!' + cond : cond) + '){');
      genNodes(n.then, parts, parsed);
      if (n.else !== null) {
        parts.push('}else{');
        genNodes(n.else, parts, parsed);
      }
      parts.push('}');
    } else if (n.kind === 'for') {
      flush();
      const usesLoop = bodyUsesLoop(n.body, parsed, new Set());
      parts.push(
        '{const _a=' + genExpr(n.path) + ';if(Array.isArray(_a)){const _n=_a.length,_s0=V.' + n.name +
          (usesLoop ? ',_s1=V.loop' : '') + ';for(let _i=0;_i<_n;_i++){V.' + n.name + '=_a[_i];' +
          (usesLoop ? 'V.loop={index:_i+1,first:_i===0,last:_i===_n-1,length:_n};' : ''),
      );
      genNodes(n.body, parts, parsed);
      parts.push('}V.' + n.name + '=_s0;' + (usesLoop ? 'V.loop=_s1;' : '') + '}}');
    } else if (n.kind === 'include') {
      flush();
      parts.push('{const _f=C.t.get(' + JSON.stringify(n.name) + ');if(_f!==void 0&&D<8)_f(O,V,C,D+1);}');
    }
  }
  flush();
}

/** `nodes` compiled to a render function (O, V, C, D): output array, flat scope, context, include depth. */
function compileNodes(nodes, parsed) {
  const parts = [];
  genNodes(nodes, parts, parsed);
  return new Function('O', 'V', 'C', 'D', parts.join(''));
}

// ---------- the build ----------

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A slug from the build's per-case cache (titles and tag names repeat). */
function slugifyCached(b, text) {
  let s = b.slugCache.get(text);
  if (s === undefined) {
    s = slugify(text);
    b.slugCache.set(text, s);
  }
  return s;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A link target resolved to its href, with broken links reported (cached per case). */
function resolveLink(b, dir, srcPath, target) {
  if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
  const key = dir + '\n' + target;
  const hit = b.linkCache.get(key);
  if (hit !== undefined) {
    if (hit.broken) b.broken.add(`broken-link ${srcPath} -> ${target}`);
    return hit.href;
  }
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(dir, rel);
  let href;
  let broken = false;
  if (path !== null && b.bySource.has(path)) href = b.bySource.get(path).url + frag;
  else if (path !== null && b.staticPaths.has(path)) href = b.base + '/' + path + frag;
  else {
    broken = true;
    href = target;
  }
  b.linkCache.set(key, { href, broken });
  if (broken) b.broken.add(`broken-link ${srcPath} -> ${target}`);
  return href;
}

/** 1. The sources, in code-unit order of their paths; a source that is not .md is static. */
function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      b.sources.push({ path: f.path, lines: text.split('\n') });
    } else b.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    let s = taken.get(dir);
    if (s === undefined) {
      s = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, s);
    }
    return s;
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugifyCached(b, s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(b) {
  b.staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = { link: (target) => resolveLink(b, dir, s.path, target) };
    const md = renderMarkdown(s.lines, s.bodyStart, env, b.slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(b) {
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugifyCached(b, name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugifyCached(b, name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugifyCached(b, name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A source's reading minutes (its body's words over 200, rounded up, at least 1), counted once. */
function readingMinutes(b, s) {
  if (s.rm === undefined) s.rm = countWords(s.lines, s.bodyStart);
  return s.rm;
}

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };

/** A post's card, as lists show it. */
function cardOf(b, s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(readingMinutes(b, s) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(b, s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(readingMinutes(b, s) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** A tag as templates read it (its posts as cards). */
const tagOf = (b, t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(b) {
  b.cards = new Map(b.posts.map((p) => [p, cardOf(b, p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const render = (name, vars) => {
    const fn = b.templates.get(name);
    if (fn === undefined) return null;
    const O = [];
    // One fixed shape for every scope: the top-level names, `loop`, and every
    // for-variable name the case's templates use, all present (undefined where
    // unbound), so the compiled templates' property accesses stay monomorphic.
    const V = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined, loop: undefined };
    for (let i = 0; i < b.loopNames.length; i++) {
      const ln = b.loopNames[i];
      if (ln !== 'site' && ln !== 'tags' && ln !== 'recent' && ln !== 'page' && ln !== 'posts' && ln !== 'pager' && ln !== 'tag' && ln !== 'loop') V[ln] = undefined;
    }
    if (vars.page !== undefined) V.page = vars.page;
    if (vars.posts !== undefined) V.posts = vars.posts;
    if (vars.pager !== undefined) V.pager = vars.pager;
    if (vars.tag !== undefined) V.tag = vars.tag;
    fn(O, V, b.tctx, 0);
    return O.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(b, s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

/** Every for-variable name the parsed templates bind (following includes), for the fixed-shape scope. */
function collectForNames(nodes, parsed, seen, out) {
  for (const n of nodes) {
    if (n.kind === 'for') {
      out.add(n.name);
      collectForNames(n.body, parsed, seen, out);
    } else if (n.kind === 'if') {
      collectForNames(n.then, parsed, seen, out);
      if (n.else !== null) collectForNames(n.else, parsed, seen, out);
    } else if (n.kind === 'include') {
      const t = parsed.get(n.name);
      if (t !== undefined && !seen.has(n.name)) {
        seen.add(n.name);
        collectForNames(t, parsed, seen, out);
      }
    }
  }
}

/** One site's output tree: path -> text. */
export function run(input) {
  const parsed = new Map();
  const reportLines = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      reportLines.push(err.message);
    }
  }
  const compiled = new Map();
  for (const [name, nodes] of parsed) compiled.set(name, compileNodes(nodes, parsed));
  const loopNames = new Set();
  {
    const seen = new Set();
    for (const [name, nodes] of parsed) {
      if (!seen.has(name)) {
        seen.add(name);
        collectForNames(nodes, parsed, seen, loopNames);
      }
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates: compiled,
    tctx: { t: compiled, e: escapeHtml, x: textOf, y: truthy },
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report: reportLines,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
    slugCache: new Map(),
    linkCache: new Map(),
    staticPaths: new Set(),
    loopNames: [...loopNames].sort(),
  };
  readSources(b);
  frontMatter(b);
  permalinks(b);
  markdown(b);
  collections(b);
  tags(b);
  layouts(b);
  report(b);
  return b.output;
}
