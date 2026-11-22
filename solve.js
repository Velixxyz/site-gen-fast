// Fast drop-in for makefun-site 1.0.0 — written from scratch in this session.
// Same answers byte-for-byte, faster: batched inline rendering, char-based
// Markdown lexing, cached slugs, manual front-matter parsing, array-joined
// template rendering. No dependencies. No caching across cases: every cache
// below is created fresh inside run().

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HAS_SPECIAL = /[&<>"']/;
const HAS_MD_SPECIAL = /[\\`*[]/;
const RESERVED = ['posts', 'tags', 'page'];

function byCodeUnits(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function escapeHtml(text) {
  const L = text.length;
  for (let i = 0; i < L; i++) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      // First special at i: build the escaped string from here on.
      const parts = [text.slice(0, i), ESCAPES[text[i]]];
      let run = i + 1;
      for (let j = i + 1; j < L; j++) {
        const d = text.charCodeAt(j);
        if (d === 38 || d === 60 || d === 62 || d === 34 || d === 39) {
          if (j > run) parts.push(text.slice(run, j));
          parts.push(ESCAPES[text[j]]);
          run = j + 1;
        }
      }
      if (L > run) parts.push(text.slice(run));
      return parts.join('');
    }
  }
  return text;
}

// Slugify with a per-run cache. ASCII text (the common case) never calls
// normalize(): NFKD is the identity on ASCII and ASCII has no combining marks.
function makeSlugify() {
  const cache = new Map();
  return function slugify(text) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    let out;
    let ascii = true;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) >= 128) { ascii = false; break; }
    if (ascii) {
      let s = '';
      let gap = false;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        let keep = 0;
        if (c >= 65 && c <= 90) keep = c + 32;
        else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
        if (keep === 0) { gap = s.length > 0; continue; }
        if (gap) s += '-';
        gap = false;
        s += String.fromCharCode(keep);
      }
      out = s;
    } else {
      const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
      let s = '';
      let gap = false;
      for (const ch of plain) {
        let keep = null;
        if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
        else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
        if (keep === null) { gap = s.length > 0; continue; }
        if (gap) s += '-';
        gap = false;
        s += keep;
      }
      out = s;
    }
    out = out.slice(0, 64);
    let end = out.length;
    while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
    out = end === out.length ? out : out.slice(0, end);
    if (out === '') out = 'untitled';
    cache.set(text, out);
    return out;
  };
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

function longDate(date) {
  // date is a validated YYYY-MM-DD string.
  return Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
}

function isSpaceCh(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f' || c === ' ' || c === ' ';
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function trimEndST(s) {
  let e = s.length;
  while (e > 0 && (s.charCodeAt(e - 1) === 32 || s.charCodeAt(e - 1) === 9)) e--;
  return e === s.length ? s : s.slice(0, e);
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
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
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
        if (ok) {
          y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
          mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
          d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
        }
      }
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1)
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prevDash = true; // slug must not start with '-'; pattern [a-z0-9]+(-[a-z0-9]+)*
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) { if (prevDash) ok = false; prevDash = true; }
        else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else ok = false;
      }
      if (prevDash) ok = false; // must not end with '-'
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

function parseFrontMatter(text) {
  if (text.length < 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) return { error: 'no front matter' };
  if (text.length === 3) return { error: 'the front matter is not closed' };
  // close line is a line exactly '---': search for '\n---\n' or trailing '\n---'.
  let closeIdx = text.indexOf('\n---\n', 3);
  let bodyStart;
  if (closeIdx !== -1) bodyStart = closeIdx + 5;
  else if (text.endsWith('\n---')) { closeIdx = text.length - 4; bodyStart = text.length; }
  else return { error: 'the front matter is not closed' };
  const fmText = text.slice(4, closeIdx);
  const lines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // blank (spaces/tabs only) or comment
    if (line === '') continue;
    let blank = true;
    for (let j = 0; j < line.length; j++) { const c = line.charCodeAt(j); if (c !== 32 && c !== 9) { blank = false; break; } }
    if (blank) continue;
    if (line.charCodeAt(0) === 35) continue; // '#'
    const ci = line.indexOf(':');
    if (ci < 0) return { error: 'line ' + (i + 2) + ' is not "key: value"' };
    const key = line.slice(0, ci);
    let keyOk = key.length > 0;
    for (let j = 0; keyOk && j < key.length; j++) { const c = key.charCodeAt(j); keyOk = (c >= 97 && c <= 122) || c === 95; }
    if (!keyOk) return { error: 'line ' + (i + 2) + ' is not "key: value"' };
    let raw;
    if (ci + 1 === line.length) raw = '';
    else if (line.charCodeAt(ci + 1) === 32) raw = line.slice(ci + 2);
    else return { error: 'line ' + (i + 2) + ' is not "key: value"' };
    raw = trimEndST(raw);
    if (!FM_KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- Markdown

// char codes a backslash escapes: \ ` * _ [ ] ( ) # + - . ! >
const ESCAPABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[c] = 1;

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === 1) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === 1) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

// Inline rendering, returning a string. Plain runs are appended as whole
// slices (escaped only when they hold an HTML special); recursion for
// strong/em/link text builds its own string, which is small.
function inlineStr(s, env) {
  if (!HAS_MD_SPECIAL.test(s)) return escapeHtml(s);
  let out = '';
  let i = 0;
  const n = s.length;
  let runStart = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < n && ESCAPABLE[s.charCodeAt(i + 1)] === 1) { // backslash escape
      if (i > runStart) { const seg = s.slice(runStart, i); out += escapeHtml(seg); }
      const nx = s.charCodeAt(i + 1);
      out += nx === 62 ? '&gt;' : s[i + 1];
      i += 2; runStart = i;
      continue;
    }
    if (c === 96) { // backtick code span
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > runStart) { const seg = s.slice(runStart, i); out += escapeHtml(seg); }
        out += '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>';
        i = j + 1; runStart = i;
      } else i++;
      continue;
    }
    if (c === 42) { // '*' strong or emphasis
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > runStart) { const seg = s.slice(runStart, i); out += escapeHtml(seg); }
          out += '<strong>' + inlineStr(s.slice(i + 2, j), env) + '</strong>';
          i = j + 2; runStart = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > runStart) { const seg = s.slice(runStart, i); out += escapeHtml(seg); }
        out += '<em>' + inlineStr(s.slice(i + 1, j), env) + '</em>';
        i = j + 1; runStart = i;
      } else i++;
      continue;
    }
    if (c === 91) { // '[' link
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        if (i > runStart) { const seg = s.slice(runStart, i); out += escapeHtml(seg); }
        out += '<a href="' + escapeHtml(env.link(target)) + '">' + inlineStr(s.slice(i + 1, k), env) + '</a>';
        i = m + 1; runStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) { // HTML special
      if (i > runStart) { const seg = s.slice(runStart, i); out += escapeHtml(seg); }
      out += ESCAPES[s[i]];
      i++; runStart = i;
      continue;
    }
    i++;
  }
  if (n > runStart) { const seg = s.slice(runStart, n); out += escapeHtml(seg); }
  return out;
}

function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}

// Classify one line: returns [kind, ...]. kind: 'blank','fence','heading',
// 'hr','quote','bullet','ordered','other'. Heading: [kind, depth, text].
function classify(line) {
  const L = line.length;
  if (L === 0) return 0; // blank
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) {
    if (isBlank(line)) return 0;
    return 7; // other (indented lines are never special at column 0... except? a line starting with spaces can't be fence/heading/hr/quote/list)
  }
  if (c0 === 96 && line.startsWith('```')) { // fence open or close candidate
    // FENCE_OPEN: ``` + lang [A-Za-z0-9_+-]* + spaces/tabs only
    let i = 3;
    while (i < L) {
      const c = line.charCodeAt(i);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
      else break;
    }
    let ok = true;
    for (let j = i; j < L; j++) { const c = line.charCodeAt(j); if (c !== 32 && c !== 9) { ok = false; break; } }
    if (ok) return 1; // fence (lang = line.slice(3, i))
    return 7;
  }
  if (c0 === 35) { // '#'
    let hashes = 0;
    while (hashes < L && line.charCodeAt(hashes) === 35) hashes++;
    if (hashes >= 1 && hashes <= 6 && hashes < L && (line.charCodeAt(hashes) === 32 || line.charCodeAt(hashes) === 9)) {
      // text = rest, trailing spaces/tabs dropped; empty -> not a heading
      let e = L;
      while (e > hashes && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
      if (e > hashes + 1 || (e === hashes + 1 && line.charCodeAt(hashes) !== 32 && line.charCodeAt(hashes) !== 9)) {
        // text after the separating space(s): skip spaces/tabs after hashes
        let s = hashes;
        while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
        if (s < e) return [2, hashes, line.slice(s, e)];
      }
    }
    return 7;
  }
  if (c0 === 45 || c0 === 42) { // '-' or '*'
    if (L >= 3) {
      const rest = line.slice(3);
      let ok = true;
      for (let j = 0; j < rest.length; j++) { const c = rest.charCodeAt(j); if (c !== 32 && c !== 9) { ok = false; break; } }
      if (ok && ((c0 === 45 && line[1] === '-' && line[2] === '-') || (c0 === 42 && line[1] === '*' && line[2] === '*'))) return 3; // hr
    }
    if (L >= 2 && line.charCodeAt(1) === 32) return 5; // bullet, text = line.slice(2)
    return 7;
  }
  if (c0 === 62) return 4; // quote '>'
  if (c0 >= 48 && c0 <= 57) { // ordered? digits '.' ' '
    let i = 0;
    while (i < L && i < 9 && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
    if (i >= 1 && i < L && line.charCodeAt(i) === 46 && i + 1 < L && line.charCodeAt(i + 1) === 32) return 6;
    return 7;
  }
  return 7;
}

function endsParagraph(line) {
  const k = classify(line);
  return k === 0 || k === 1 || k === 3 || (Array.isArray(k) && k[0] === 2);
}

function renderMarkdown(src, env, slugify) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  const N = lines.length;
  while (i < N) {
    const line = lines[i];
    const k = classify(line);
    if (k === 0) { i++; continue; }
    if (k === 1) { // fence
      let li = 3;
      while (li < line.length) {
        const c = line.charCodeAt(li);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) li++;
        else break;
      }
      const lang = line.slice(3, li);
      i++;
      const body = [];
      while (i < N) {
        const l2 = lines[i];
        // FENCE_CLOSE: ``` + spaces/tabs only
        if (l2.startsWith('```')) {
          let ok = true;
          for (let j = 3; j < l2.length; j++) { const c = l2.charCodeAt(j); if (c !== 32 && c !== 9) { ok = false; break; } }
          if (ok) break;
        }
        body.push(l2);
        i++;
      }
      i++;
      const cls = lang === '' ? '' : ' class="language-' + escapeHtml(lang) + '"';
      let inner = '';
      for (let b = 0; b < body.length; b++) inner += escapeHtml(body[b]) + '\n';
      blocks.push('<pre><code' + cls + '>' + inner + '</code></pre>');
      continue;
    }
    if (Array.isArray(k) && k[0] === 2) {
      const depth = k[1], text = k[2];
      const id = uniqueSlug(slugify(text), ids);
      const html = inlineStr(text, env);
      blocks.push('<h' + depth + ' id="' + id + '">' + html + '</h' + depth + '>');
      if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
      i++;
      continue;
    }
    if (k === 3) { blocks.push('<hr>'); i++; continue; }
    if (k === 4) { // blockquote
      const body = [];
      while (i < N && lines[i].charCodeAt(0) === 62) {
        let l2 = lines[i++];
        l2 = l2.length >= 2 && l2.charCodeAt(1) === 32 ? l2.slice(2) : l2.slice(1);
        const t = trimLine(l2);
        if (t !== '') body.push(t);
      }
      blocks.push(body.length === 0 ? '<blockquote>\n</blockquote>' : '<blockquote>\n<p>' + inlineStr(body.join('\n'), env) + '</p>\n</blockquote>');
      continue;
    }
    if (k === 5 || k === 6) { // list
      const isOrdered = k === 6;
      const items = [];
      let start = 1;
      let first = true;
      while (i < N) {
        const l2 = lines[i];
        const kk = classify(l2);
        if (kk === (isOrdered ? 6 : 5)) {
          if (isOrdered && first) {
            let d = 0;
            while (d < l2.length && l2.charCodeAt(d) >= 48 && l2.charCodeAt(d) <= 57) d++;
            start = Number(l2.slice(0, d));
          }
          first = false;
          // item text: after marker
          let txt;
          if (isOrdered) {
            let d = 0;
            while (d < l2.length && l2.charCodeAt(d) >= 48 && l2.charCodeAt(d) <= 57) d++;
            txt = trimLine(l2.slice(d + 2));
          } else txt = trimLine(l2.slice(2));
          items.push([txt]);
          i++;
        } else if (l2.length >= 2 && l2.charCodeAt(0) === 32 && l2.charCodeAt(1) === 32) {
          // CONTINUED: 2+ spaces then a non-space char
          let j = 0;
          while (j < l2.length && l2.charCodeAt(j) === 32) j++;
          if (j >= 2 && j < l2.length && !/\s/.test(l2[j])) {
            items[items.length - 1].push(trimLine(l2));
            i++;
          } else break;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? '<ol start="' + start + '">' : '<' + tag + '>';
      let inner = '';
      for (let it = 0; it < items.length; it++) inner += '<li>' + inlineStr(items[it].join('\n'), env) + '</li>\n';
      blocks.push(open + '\n' + inner + '</' + tag + '>');
      continue;
    }
    // paragraph
    const body = [trimLine(line)];
    i++;
    while (i < N && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const html = inlineStr(text, env);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

function isBlankSlice(src, a, b) {
  for (let i = a; i < b; i++) { const c = src.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlankSlice(src, lineStart, open) && isBlankSlice(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Depth of the enclosing for that binds `name`, counting from the innermost
// for outward (0 = innermost for binds it); -1 when no enclosing for in this
// template binds it (then it may come from a caller's loop or the root vars).
function bindDepth(stack, name) {
  let d = 0;
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].kind !== 'for') continue;
    if (stack[i].name === name) return d;
    d++;
  }
  return -1;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path, bd: bindDepth(stack, tok.path[0]) });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [], bd: bindDepth(stack, pathOf(name, m[2])[0]) };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null, bd: bindDepth(stack, pathOf(name, m[2])[0]) };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

// First segment bound by an enclosing for `bd` fors out: walk that far up.
function lookupBound(scope, path, bd) {
  let s = scope;
  for (let q = 0; q < bd; q++) s = s.parent;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function resolve(scope, path, bd) {
  return bd >= 0 ? lookupBound(scope, path, bd) : lookup(scope, path);
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) { if (i) out += ', '; out += textOf(v[i]); }
    return out;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text': out.push(n.text); break;
      case 'var': {
        const v = resolve(scope, n.path, n.bd);
        out.push(typeof v === 'string' ? escapeHtml(v) : escapeHtml(textOf(v)));
        break;
      }
      case 'raw': {
        const v = resolve(scope, n.path, n.bd);
        out.push(typeof v === 'string' ? v : textOf(v));
        break;
      }
      case 'if': {
        const v = truthy(resolve(scope, n.path, n.bd));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = resolve(scope, n.path, n.bd);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < 8) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}


// ---------------------------------------------------------------- build

// JS \s set, as a lookup table (code unit -> is whitespace).
const WS = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279]) WS[c] = 1;
for (let c = 8192; c <= 8202; c++) WS[c] = 1;

function wordsOf(text) {
  let n = 0, i = 0;
  const L = text.length;
  while (i < L) {
    while (i < L && WS[text.charCodeAt(i)] === 1) i++;
    if (i >= L) break;
    n++;
    while (i < L && WS[text.charCodeAt(i)] === 0) i++;
  }
  return n;
}

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

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export function run(input) {
  const slugify = makeSlugify();
  const templates = new Map();
  const report = [];
  const tNames = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < tNames.length; i++) {
    const name = tNames[i];
    try { templates.set(name, parseTemplate(name, input.templates[name])); }
    catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  let base = input.site.base_url;
  while (base.endsWith('/')) base = base.slice(0, -1);

  // 1. sources, sorted by path in code-unit order
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. front matter
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push('refused ' + s.path + ': ' + fm.error); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) { report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own'); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push('refused ' + s.path + ': a post needs a date'); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses'); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push('draft ' + s.path); continue; }
    kept.push(s);
  }
  sources = kept;

  // 3. permalinks
  const taken = new Map();
  const bySource = new Map();
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 4. markdown
  const staticPaths = new Set();
  for (let i = 0; i < statics.length; i++) staticPaths.add(statics[i].path);
  const broken = new Set();
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const dir = dirOf(s.path);
    const linkCache = new Map();
    const env = {
      link: (target) => {
        const hit = linkCache.get(target);
        if (hit !== undefined) return hit;
        let out;
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) out = target;
        else {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && bySource.has(path)) out = bySource.get(path).url + frag;
          else if (path !== null && staticPaths.has(path)) out = base + '/' + path + frag;
          else { broken.add('broken-link ' + s.path + ' -> ' + target); out = target; }
        }
        linkCache.set(target, out);
        return out;
      },
    };
    const md = renderMarkdown(s.body, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. collections
  const posts = [];
  for (let i = 0; i < sources.length; i++) if (sources[i].post) posts.push(sources[i]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const names = s.data.tags ?? [];
    const out = [];
    for (let i = 0; i < names.length; i++) {
      const sl = slugify(names[i]);
      if (!seen.has(sl)) { seen.add(sl); out.push(names[i]); }
    }
    return out;
  };
  for (let pi = 0; pi < posts.length; pi++) {
    const p = posts[pi];
    p.tagRefs = [];
    const names = ownTags(p);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (s.post) continue;
    const names = ownTags(s);
    s.tagRefs = new Array(names.length);
    for (let j = 0; j < names.length; j++) {
      const t = bySlug.get(slugify(names[j]));
      s.tagRefs[j] = t ?? { name: names[j], slug: slugify(names[j]), url: '', posts: [] };
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

  const cardOf = (s) => {
    if (s._card !== undefined) return s._card;
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s._card = card;
    return card;
  };

  // 7. layouts
  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(posts[i]));
  const site = { title: input.site.title, base_url: base };
  const allTags = new Array(tags.length);
  for (let i = 0; i < tags.length; i++) allTags[i] = { name: tags[i].name, slug: tags[i].slug, url: tags[i].url, count: tags[i].posts.length };
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const output = {};
  const rootVars = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const render = (name, vars) => {
    rootVars.page = vars.page;
    rootVars.posts = vars.posts;
    rootVars.pager = vars.pager;
    rootVars.tag = vars.tag;
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: rootVars, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const card = cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[s.outDir + '/index.html'] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const slice = posts.slice((k - 1) * per, k * per);
    const pcards = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) pcards[i] = cards.get(slice[i]);
    const html = render('index', {
      posts: pcards,
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (let ti = 0; ti < tags.length; ti++) {
    const t = tags[ti];
    const tcards = new Array(t.posts.length);
    for (let i = 0; i < t.posts.length; i++) tcards[i] = cards.get(t.posts[i]);
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: tcards } });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // 8. report
  const lines = [...report, ...broken].sort(byCodeUnits);
  let npages = 0;
  for (let i = 0; i < sources.length; i++) if (!sources[i].post) npages++;
  lines.push('built ' + npages + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
