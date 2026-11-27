// README -> Diátaxis pages. Pure functions, standard library only.
//
// Pipeline (see buildPages):
//   normalize -> strip front matter & HTML comments -> redact secrets
//   -> rewrite relative links/images to absolute GitHub URLs (pinned to the ref)
//   -> cut at stop headings -> pull title, tags line and badges
//   -> split into Overview / Tutorials / How-to / Reference / Explanation
//   -> re-point #anchor links whose heading moved to another page.

import path from 'node:path';
import { redactSecrets } from './secrets.mjs';

// ---------------------------------------------------------------- fences

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

// Split text into [{fenced:boolean, text}] keeping every character.
export function segments(text) {
  const lines = text.split('\n');
  const out = [];
  let buf = [];
  let fence = null;
  const flush = (fenced) => {
    if (buf.length) out.push({ fenced, text: buf.join('\n') });
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(FENCE_OPEN);
    if (!fence && m) {
      flush(false);
      fence = m[1];
      buf.push(line);
    } else if (fence && m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) {
      buf.push(line);
      flush(true);
      fence = null;
    } else {
      buf.push(line);
    }
  }
  flush(Boolean(fence));
  return out;
}

const join = (segs) => segs.map((s) => s.text).join('\n');
export const mapProse = (text, fn) => join(segments(text).map((s) => (s.fenced ? s : { ...s, text: fn(s.text) })));

// Lines with a flag telling whether they sit inside a fenced block.
function linesWithFence(text) {
  const out = [];
  for (const seg of segments(text)) for (const line of seg.text.split('\n')) out.push({ line, fenced: seg.fenced });
  return out;
}

// ---------------------------------------------------------------- cleanup

export function normalize(text) {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

export function stripFrontmatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

export function stripHtmlComments(text) {
  return mapProse(text, (t) => t.replace(/<!--[\s\S]*?-->/g, ''));
}

// ---------------------------------------------------------------- links

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico)(?:[?#].*)?$/i;
const isExternal = (u) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u);

function splitTarget(inner) {
  let s = inner.trim();
  if (s.startsWith('<')) {
    const end = s.indexOf('>');
    if (end > 0) return { url: s.slice(1, end), rest: s.slice(end + 1) };
  }
  const m = s.match(/^(\S+)(\s+.*)?$/s);
  return m ? { url: m[1], rest: m[2] || '' } : { url: s, rest: '' };
}

// decodeURI that never throws: a stray "%" (e.g. "docs/100%.md") is kept literally.
export function safeDecodeURI(s) {
  try {
    return decodeURI(s);
  } catch {
    // Decode each run of well-formed escapes on its own; leave stray "%" signs as they are.
    return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decodeURI(run);
      } catch {
        return run;
      }
    });
  }
}

function resolveRepoPath(rel, dir) {
  const [p, frag = ''] = rel.split(/(?=[?#])/);
  const clean = safeDecodeURI(p);
  const joined = clean.startsWith('/') ? clean.slice(1) : path.posix.join(dir || '.', clean);
  const norm = path.posix.normalize(joined).replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');
  return encodeURI(norm) + frag;
}

// bases: { raw: 'https://raw.githubusercontent.com/o/r/<ref>', blob: 'https://github.com/o/r/blob/<ref>', dir }
export function rewriteRelativeLinks(text, bases) {
  const abs = (url, preferRaw) => {
    if (!url || isExternal(url)) return url;
    const p = resolveRepoPath(url, bases.dir);
    return `${preferRaw || IMAGE_EXT.test(url) ? bases.raw : bases.blob}/${p}`;
  };
  const md = (prefix, preferRaw) => (m, label, inner) => {
    const { url, rest } = splitTarget(inner);
    return `${prefix}[${label}](${abs(url, preferRaw)}${rest})`;
  };
  return mapProse(text, (t) =>
    t
      .replace(/!\[([^\]]*)\]\(([^)\n]+)\)/g, md('!', true))
      .replace(/\[(!\[[^\]]*\]\([^)\n]*\))\]\(([^)\n]+)\)/g, md('', false))
      .replace(/(?<![!\]])\[([^\]\n]*)\]\(([^)\n]+)\)/g, md('', false))
      .replace(/^( {0,3}\[[^\]]+\]:\s*)(\S+)/gm, (m, pre, url) => pre + abs(url.replace(/^<|>$/g, ''), false))
      .replace(/(<img\b[^>]*?\bsrc\s*=\s*["'])([^"']+)(["'])/gi, (m, a, url, b) => a + abs(url, true) + b)
      .replace(/(<source\b[^>]*?\bsrcset\s*=\s*["'])([^"'\s]+)/gi, (m, a, url) => a + abs(url, true))
      .replace(/(<a\b[^>]*?\bhref\s*=\s*["'])([^"']+)(["'])/gi, (m, a, url, b) => a + abs(url, false) + b),
  );
}

// ---------------------------------------------------------------- headings & slugs

const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const EXPLICIT_ID = /\s*\{#([^}\s]+)\}\s*$/;

export function headingText(raw) {
  return raw
    .replace(EXPLICIT_ID, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__|\*|~~)/g, '')
    .replace(/\\(.)/g, '$1')
    .trim();
}

// github-slugger (used by GitHub and Docusaurus): lowercase, keep letters/marks/numbers,
// space, '-' and '_'; spaces become '-'; duplicates get -1, -2 ...
export class Slugger {
  constructor() {
    this.seen = new Map();
  }
  slug(text) {
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N} _-]/gu, '').replace(/ /g, '-');
    let result = base;
    while (this.seen.has(result)) {
      const n = this.seen.get(base) + 1;
      this.seen.set(base, n);
      result = `${base}-${n}`;
    }
    this.seen.set(result, 0);
    return result;
  }
}

function headingIds(text, slugger) {
  const ids = [];
  for (const { line, fenced } of linesWithFence(text)) {
    if (fenced) continue;
    const m = line.match(ATX);
    if (!m) continue;
    const explicit = m[2].match(EXPLICIT_ID);
    if (explicit) {
      ids.push(explicit[1]);
      if (!slugger.seen.has(explicit[1])) slugger.seen.set(explicit[1], 0);
    } else ids.push(slugger.slug(headingText(m[2])));
  }
  return ids;
}

// ---------------------------------------------------------------- title, tags, badges

export function extractTitle(text) {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const m = (lines[i] || '').match(/^ {0,3}#[ \t]+(.*?)[ \t#]*$/);
  if (m) {
    const title = headingText(m[1]);
    if (title) return { title, body: lines.slice(i + 1).join('\n') };
    return { title: '', body: [...lines.slice(0, i), m[1], ...lines.slice(i + 1)].join('\n') };
  }
  // Setext heading: "Title\n====="
  if (lines[i] && /^=+\s*$/.test(lines[i + 1] || '')) {
    return { title: headingText(lines[i]), body: lines.slice(i + 2).join('\n') };
  }
  return { title: '', body: text };
}

// "**Tags:** a, b" (or "Tags: a, b") anywhere outside code -> tags, line removed.
export function extractTagsLine(text) {
  let tags = [];
  const body = mapProse(text, (t) =>
    t.replace(/^[ \t]*(?:\*\*|__)?Tags:?(?:\*\*|__)?:?[ \t]*(.+)$/gim, (m, list) => {
      tags = tags.concat(
        list
          .replace(/[`*_]/g, '')
          .split(/[,;]/)
          .map((s) => s.trim())
          .filter((s) => s && s.length <= 40 && !/[{}]/.test(s)),
      );
      return '';
    }),
  );
  return { tags, body };
}

const BADGE_HOST = /(shields\.io|badgen\.net|badge\.fury\.io|travis-ci\.|circleci\.com|codecov\.io|coveralls\.io|readthedocs\.org\/projects\/[^/]+\/badge|\/badge\.svg|\/badges?\/|actions\/workflows\/|zenodo\.org\/badge|pepy\.tech\/badge|img\.shields)/i;
const MD_BADGE = /\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\)|!\[[^\]]*\]\([^)]+\)/g;
const HTML_BADGE = /<a\b[^>]*>\s*<img\b[^>]*>\s*<\/a>|<img\b[^>]*>/gi;

function badgeTokens(line) {
  const tokens = [...line.matchAll(MD_BADGE), ...line.matchAll(HTML_BADGE)].map((m) => m[0]);
  if (!tokens.length || !tokens.every((t) => BADGE_HOST.test(t))) return null;
  let rest = line;
  for (const t of tokens) rest = rest.replace(t, '');
  rest = rest.replace(/<\/?(p|div|span|br)\b[^>]*>/gi, '').replace(/&nbsp;|\|/g, '').trim();
  return rest ? null : tokens;
}

// Remove badge-only lines above the first section heading; return the badges.
export function extractTopBadges(text) {
  const lines = text.split('\n');
  const badges = [];
  const keep = [];
  let inTop = true;
  for (const { line, fenced } of linesWithFence(text)) {
    if (!fenced && ATX.test(line)) inTop = false;
    const tokens = inTop && !fenced ? badgeTokens(line) : null;
    if (tokens) badges.push(...tokens);
    else keep.push(line);
  }
  // Drop wrapper tags left empty by badge removal.
  const body = keep.join('\n').replace(/<(p|div)\b[^>]*>\s*<\/\1>/gi, '');
  return { badges: [...new Set(badges)], body: lines.length ? body : text };
}

const shield = (label, message, color, logo) =>
  `https://img.shields.io/badge/${encodeURIComponent(label.replace(/-/g, '--'))}-${encodeURIComponent(message.replace(/-/g, '--').replace(/_/g, '__'))}-${color}${logo ? `?logo=${logo}` : ''}`;

export function standardBadges({ repo, versionLabel }) {
  const out = [`[![GitHub](${shield('GitHub', repo.full_name, '181717', 'github')})](${repo.html_url})`];
  const spdx = repo.license && repo.license.spdx_id;
  if (spdx && spdx !== 'NOASSERTION') out.push(`[![License: ${spdx}](${shield('License', spdx, 'blue')})](https://spdx.org/licenses/${spdx}.html)`);
  if (versionLabel) out.push(`![Version](${shield('version', versionLabel, 'green')})`);
  if (repo.language) out.push(`![Language](${shield('language', repo.language, 'informational')})`);
  return out;
}

// Insert a centred badge block after the first paragraph of prose.
export function insertBadges(body, badges) {
  if (!badges.length) return body;
  const block = `<div align="center">\n\n${badges.join(' ')}\n\n</div>`;
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const startsWithProse = lines[i] && !/^ {0,3}(#|```|~~~|<|\||[-*+] |\d+\. |>)/.test(lines[i]);
  if (!startsWithProse) return `${block}\n\n${body.trim()}`;
  while (i < lines.length && lines[i].trim()) i++;
  return [...lines.slice(0, i), '', block, '', ...lines.slice(i)].join('\n').trim();
}

export function firstParagraph(body) {
  for (const seg of segments(body)) {
    if (seg.fenced) continue;
    for (const para of seg.text.split(/\n\s*\n/)) {
      const p = para.trim();
      if (!p || /^(#|<|\||[-*+] |\d+\. |>|!\[|\[!\[)/.test(p)) continue;
      const plain = p
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/[`*_~]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (plain.length >= 20) return plain;
    }
  }
  return '';
}

export function clip(text, limit = 160) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= limit) return t;
  const cut = t.slice(0, limit - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 80 ? cut.lastIndexOf(' ') : cut.length).replace(/[,;:.\s]+$/, '')}…`;
}

export function truncateAtHeadings(text, stops) {
  if (!stops || !stops.length) return text;
  const wanted = new Set(stops.map((s) => s.trim().toLowerCase()));
  const out = [];
  for (const { line, fenced } of linesWithFence(text)) {
    const m = !fenced && line.match(ATX);
    if (m && wanted.has(headingText(m[2]).toLowerCase())) break;
    out.push(line);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- Diátaxis split

export const BUCKETS = {
  overview: { file: 'overview.md', label: 'Overview', position: 1 },
  tutorials: { file: 'tutorials.md', label: 'Tutorials', position: 2 },
  'how-to': { file: 'how-to.md', label: 'How-to guides', position: 3 },
  reference: { file: 'reference.md', label: 'Reference', position: 4 },
  explanation: { file: 'explanation.md', label: 'Explanation', position: 5 },
};

// Exact section names from the Diátaxis README template (strict mode).
const STRICT = [
  ['tutorials', /^tutorials?$/i],
  ['how-to', /^how[\s-]*to(?:[\s-]*guides?)?$/i],
  ['reference', /^(?:api[\s-]*)?reference$/i],
  ['explanation', /^explanations?$/i],
];

// Keyword heuristics for ordinary READMEs (auto mode). Order matters: first match wins.
const AUTO = [
  ['reference', /\b(api|reference|cli|commands?|options|flags|parameters|arguments|endpoints?|environment variables|env vars|schema|configuration reference|methods)\b/i],
  ['explanation', /\b(architecture|design|concepts?|how (it|this) works|background|motivation|why|internals|theory|explanation|principles|overview of)\b/i],
  ['tutorials', /\b(getting started|get started|quick ?start|tutorials?|installation|install(ing)?|set ?up|first steps|walkthrough|prerequisites|requirements)\b/i],
  ['how-to', /\b(usage|how[\s-]to|guides?|configur(e|ation|ing)|deploy(ing|ment)?|troubleshoot(ing)?|faq|examples?|recipes?|running|run|develop(ment|ing)?|build(ing)?|testing|upgrad(e|ing)|migrat(e|ion))\b/i],
];
// Sections that belong on the Overview page by convention (not "unclassified").
const OVERVIEW_RULE = /\b(licen[cs]e|contribut(e|ing|ors?)|acknowledg(e)?ments?|credits?|authors?|maintainers?|citation|cite|citing|support|contact|sponsors?|funding|references?|related|see also|code of conduct|security|changelog|news|status|badges|team|community|issue|feedback|about|features|highlights|overview|introduction|summary|what is)\b/i;

export const CATEGORIES = ['overview', 'tutorials', 'how-to', 'reference', 'explanation', 'omit'];

const strictBucket = (title) => (STRICT.find(([, re]) => re.test(title)) || [])[0];
const autoBucket = (title) => (AUTO.find(([, re]) => re.test(title)) || [])[0];
const contentLines = (t) => t.split('\n').filter((l) => l.trim() && !ATX.test(l) && !/^\s*-{3,}\s*$/.test(l)).length;
export const normHeading = (h) => String(h || '').replace(/\s+/g, ' ').trim().toLowerCase();

// Split into ordered sections at heading level `level` (null = only strict headings).
function sections(body, isBoundary) {
  const out = [{ heading: null, level: 0, lines: [] }];
  for (const { line, fenced } of linesWithFence(body)) {
    const m = !fenced && line.match(ATX);
    if (m && isBoundary(m[1].length, headingText(m[2]))) out.push({ heading: headingText(m[2]), level: m[1].length, raw: line, lines: [] });
    else out[out.length - 1].lines.push(line);
  }
  return out;
}

// Is this README really written to the Diátaxis template, or does it just happen to have
// a "Reference" heading? Evidence required:
//   1. after the first Diátaxis heading, every heading at that level (or above) is also a
//      Diátaxis heading, so no "## License" after "## Reference";
//   2. at least two different Diátaxis sections, or they are top-level "#" headings (the
//      ICICLE / DocGen template puts them at H1, and may include just one).
export function looksLikeTemplate(body) {
  const heads = linesWithFence(body)
    .filter((l) => !l.fenced)
    .map((l) => l.line.match(ATX))
    .filter(Boolean)
    .map((m) => ({ level: m[1].length, bucket: strictBucket(headingText(m[2])) }));
  const strict = heads.filter((h) => h.bucket && h.level <= 2);
  if (!strict.length) return false;
  const level = Math.min(...strict.map((h) => h.level));
  const first = heads.findIndex((h) => h.bucket && h.level === level);
  if (heads.slice(first).some((h) => h.level <= level && !h.bucket)) return false;
  return level === 1 || new Set(strict.filter((h) => h.level === level).map((h) => h.bucket)).size >= 2;
}

const trimRules = (t) => t.replace(/^(\s*-{3,}\s*\n)+/, '').replace(/(\n\s*-{3,}\s*)+$/, '').trim();

/**
 * Split a README body into Diátaxis buckets, in README order.
 *
 * Precedence for each section:
 *   1. template  — the README uses the Diátaxis template headings (whole README, strict)
 *   2. mapping   — docgen.mapping.json says where this heading goes (written by the
 *                  docgen-map skill / a person; committed, so CI reproduces it)
 *   3. rule      — heading keyword rules (AUTO, OVERVIEW_RULE)
 *   4. default   — nothing matched: stays on Overview and is reported as unclassified
 *
 * @param {string} body
 * @param {'auto'|'strict'|'off'} mode
 * @param {Record<string,string>} [mapping]  normalized heading -> category
 * @returns {{bucket:string, text:string, heading:string|null, source:string, lines:number}[]}
 */
export function classify(body, mode, mapping = {}) {
  const lines = (t) => contentLines(t);
  if (mode === 'off') return [{ bucket: 'overview', text: body.trim(), heading: null, source: 'off', lines: lines(body) }];

  // 1. Template: the README follows the Diátaxis template (# Tutorials / # How-To Guides ...).
  const strictSecs = sections(body, (lvl, t) => lvl <= 2 && Boolean(strictBucket(t)));
  if (mode === 'strict' || (strictSecs.length > 1 && looksLikeTemplate(body))) {
    return strictSecs.map((s, i) => {
      const text = trimRules(s.lines.join('\n'));
      return { bucket: i === 0 ? 'overview' : strictBucket(s.heading), text, heading: s.heading, source: i === 0 ? 'intro' : 'template', lines: lines(text) };
    });
  }

  const levels = linesWithFence(body)
    .filter((l) => !l.fenced)
    .map((l) => (l.line.match(ATX) || [])[1])
    .filter(Boolean)
    .map((h) => h.length);
  if (!levels.length) return [{ bucket: 'overview', text: body.trim(), heading: null, source: 'no-headings', lines: lines(body) }];
  const top = Math.min(...levels);

  const secs = sections(body, (lvl) => lvl === top).map((s, i) => {
    const text = [s.raw, ...s.lines].filter((x) => x !== undefined).join('\n').trim();
    const base = { heading: s.heading, text, lines: lines(text) };
    if (i === 0) return { ...base, bucket: 'overview', source: 'intro' };
    // Own properties only: a heading named "Constructor" must not find Object.prototype members.
    const key = normHeading(s.heading);
    const mapped = Object.hasOwn(mapping, key) && CATEGORIES.includes(mapping[key]) ? mapping[key] : null;
    if (mapped) return { ...base, bucket: mapped, source: 'mapping' };
    // A Diátaxis heading ("Tutorials", "How-To Guides", …) in a README that isn't fully
    // template-structured still means exactly what it says; never fold it away.
    const named = strictBucket(s.heading);
    if (named) return { ...base, bucket: named, source: 'heading' };
    const rule = autoBucket(s.heading);
    if (rule) return { ...base, bucket: rule, source: 'rule' };
    if (OVERVIEW_RULE.test(s.heading)) return { ...base, bucket: 'overview', source: 'rule' };
    return { ...base, bucket: 'overview', source: 'default' };
  });

  // A rule-made page with almost nothing on it is worse than a longer overview.
  // Explicit mappings are always respected.
  const size = Object.create(null);
  for (const s of secs) size[s.bucket] = (size[s.bucket] || 0) + s.lines;
  for (const s of secs) {
    if (s.source === 'rule' && s.bucket !== 'overview' && size[s.bucket] < 4) {
      s.foldedFrom = s.bucket;
      s.bucket = 'overview';
    }
  }
  return secs.filter((s) => s.bucket !== 'omit');
}

/**
 * Why did a README produce only an Overview page (no Tutorials, How-to, Reference or
 * Explanation)? Returns a short, plain reason, or null when it has a Diátaxis page.
 * @param {{heading: string|null, category: string, source: string, foldedFrom?: string}[]} sections
 */
export function overviewOnlyReason(sections) {
  if (!sections.length || sections.some((s) => s.category !== 'overview')) return null;
  const names = (list) => list.map((s) => `"${s.heading}"`).join(', ');
  if (sections.some((s) => s.source === 'off')) return 'Diátaxis splitting is turned off for this repo (content.diataxis: "off")';
  if (sections.some((s) => s.source === 'no-headings')) return 'the README has no headings, so there are no sections to sort';
  const rest = sections.filter((s) => s.source !== 'intro');
  if (!rest.length) return 'the README is only an introduction, with no further sections';
  const reasons = [];
  const open = rest.filter((s) => s.source === 'default');
  const folded = rest.filter((s) => s.foldedFrom);
  const about = rest.filter((s) => s.source !== 'default' && !s.foldedFrom);
  if (open.length) reasons.push(`${open.length} section(s) not classified yet (${names(open)}); run the docgen-map skill`);
  if (folded.length) reasons.push(`${names(folded)} matched a Diátaxis category but were too short for a page of their own`);
  if (about.length) reasons.push(`${names(about)} are about the project itself (license, contributing, contact…), which belongs on Overview`);
  return reasons.join('; ');
}

// ---------------------------------------------------------------- anchors across pages

const MD_ANCHOR = /(\]\(\s*)#([^)\s]+)((?:\s+"[^"]*")?\s*\))/g;
const HTML_ANCHOR = /(href\s*=\s*["'])#([^"']+)(["'])/gi;
const DEF_ANCHOR = /^( {0,3}\[[^\]]+\]:\s*)#(\S+)(.*)$/;

export function repointAnchors(parts) {
  const global = new Slugger();
  const perPage = Object.create(null);
  const where = new Map();
  const pageIds = Object.create(null);
  for (const p of parts) {
    const ps = (perPage[p.bucket] ||= new Slugger());
    const g = headingIds(p.text, global);
    const local = headingIds(p.text, ps);
    (pageIds[p.bucket] ||= new Set());
    local.forEach((id) => pageIds[p.bucket].add(id));
    g.forEach((id, i) => {
      if (!where.has(id)) where.set(id, { bucket: p.bucket, id: local[i] });
    });
  }
  const lower = new Map([...where].map(([k, v]) => [k.toLowerCase(), v]));
  const unresolved = new Set();
  let moved = 0;

  const target = (bucket, anchor, html) => {
    const hit = where.get(anchor) || lower.get(anchor.toLowerCase());
    if (!hit) {
      if (!pageIds[bucket]?.has(anchor)) unresolved.add(anchor);
      return null;
    }
    if (hit.bucket === bucket) {
      if (hit.id === anchor) return null;
      moved++;
      return `#${hit.id}`;
    }
    moved++;
    const file = BUCKETS[hit.bucket].file;
    return html ? `./${file.replace(/\.md$/, '')}#${hit.id}` : `./${file}#${hit.id}`;
  };

  const out = parts.map((p) => ({
    ...p,
    text: linesWithFence(p.text)
      .map(({ line, fenced }) => {
        if (fenced) return line;
        let l = line
          .replace(MD_ANCHOR, (m, a, id, b) => {
            const t = target(p.bucket, id, false);
            return t ? a + t + b : m;
          })
          .replace(HTML_ANCHOR, (m, a, id, b) => {
            const t = target(p.bucket, id, true);
            return t ? a + t + b : m;
          });
        const d = l.match(DEF_ANCHOR);
        if (d) {
          const t = target(p.bucket, d[2], false);
          if (t) l = d[1] + t + d[3];
        }
        return l;
      })
      .join('\n'),
  }));
  return { parts: out, moved, unresolved: [...unresolved] };
}

// Markdown files are parsed as CommonMark (markdown.format: 'detect'), so JSX/MDX
// syntax is not a concern — but a few HTML constructs still break the build.
export function makeBuildSafe(text) {
  return mapProse(text, (t) =>
    t
      // Self-close void elements (<br>, <img ...>) for the HTML-to-React step.
      .replace(/<(br|hr)\s*>/gi, '<$1 />')
      .replace(/<(img|source|input)\b([^>]*?)\s*(?<!\/)>/gi, '<$1$2 />')
      // Drop active content outright.
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ''),
  );
}

// ---------------------------------------------------------------- entry point

const demoteH1 = (t) => mapProse(t, (s) => s.replace(/^( {0,3})#(?=[ \t])/gm, '$1##'));

/**
 * @param {object} o
 * @param {string} o.readme      README markdown
 * @param {string} o.readmePath  path of the README inside the repo (for relative links)
 * @param {object} o.repo        GitHub repo object
 * @param {string} o.ref         git ref the README was read at
 * @param {string} [o.versionLabel]
 * @param {object} o.content     cfg.content
 * @param {Record<string,string>} [o.mapping]  normalized heading -> category (docgen.mapping.json)
 */
export function buildPages({ readme, readmePath, repo, ref, versionLabel, content, mapping = {} }) {
  const warnings = [];
  let text = stripHtmlComments(stripFrontmatter(normalize(readme)));

  if (content.redactSecrets) {
    const r = redactSecrets(text);
    text = r.text;
    if (r.kinds.length) warnings.push(`redacted ${r.kinds.length} secret-looking value(s): ${[...new Set(r.kinds)].join(', ')}`);
  }

  const encRef = ref.split('/').map(encodeURIComponent).join('/');
  text = rewriteRelativeLinks(text, {
    raw: `https://raw.githubusercontent.com/${repo.full_name}/${encRef}`,
    blob: `https://github.com/${repo.full_name}/blob/${encRef}`,
    dir: path.posix.dirname(readmePath || 'README.md'),
  });
  text = truncateAtHeadings(text, content.stopAtHeadings);

  const { title: readmeTitle, body: afterTitle } = extractTitle(text);
  const { tags: readmeTags, body: afterTags } = content.tagsFromReadme ? extractTagsLine(afterTitle) : { tags: [], body: afterTitle };
  const { badges, body } = extractTopBadges(afterTags);

  const classified = classify(body, content.diataxis, mapping);
  // What happened to each section — feeds `npm run sections` and the docgen-map skill.
  const sectionReport = classified.map((p) => ({
    heading: p.heading,
    category: p.bucket,
    source: p.source,
    lines: p.lines,
    preview: p.text.replace(/\s+/g, ' ').slice(0, 280),
    ...(p.foldedFrom ? { foldedFrom: p.foldedFrom } : {}),
  }));
  const structured = classified.some((p) => p.source === 'template');
  const { parts, moved, unresolved } = repointAnchors(classified);
  if (moved) warnings.push(`re-pointed ${moved} in-README anchor link(s) to the page their heading landed on`);
  if (unresolved.length) warnings.push(`anchor link(s) match no heading in the README (left as-is): ${unresolved.map((a) => `#${a}`).join(', ')}`);

  const byBucket = Object.create(null);
  for (const p of parts) if (p.text) (byBucket[p.bucket] ||= []).push(p.text);

  const overviewBody = (byBucket.overview || []).join('\n\n');
  const description = clip(repo.description || firstParagraph(overviewBody) || `Documentation for ${repo.name}.`);
  const allBadges = [...new Set([...standardBadges({ repo, versionLabel }), ...badges])];

  const pages = Object.entries(BUCKETS)
    .filter(([key]) => key === 'overview' || byBucket[key])
    .map(([key, meta]) => {
      let pageBody = demoteH1((byBucket[key] || []).join('\n\n'));
      if (key === 'overview') pageBody = insertBadges(pageBody, allBadges);
      return { bucket: key, file: meta.file, label: meta.label, position: meta.position, body: makeBuildSafe(pageBody).trim() + '\n' };
    });

  return {
    title: readmeTitle || repo.name,
    description,
    readmeTags,
    pages,
    warnings,
    sections: sectionReport,
    structured,
  };
}
