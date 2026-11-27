#!/usr/bin/env node
// Link check over the production build (site/build). Run after `npm run build`.
//
//   node scripts/check.mjs              internal links, assets, anchors, expected pages
//   node scripts/check.mjs --external   also request every external link (slower)
//
// Blocking (exit 1): a link or asset inside the site that leads to no file (would 404),
//                    a generated page missing from the build, or no 404 page.
// Warnings only:     #anchors that match no heading (usually a typo in an upstream README),
//                    external links that fail (often rate limits or bot protection).

import fs from 'node:fs';
import path from 'node:path';
import { SITE_DIR, MANIFEST_PATH } from './lib/config.mjs';

const BUILD = path.join(SITE_DIR, 'build');
const INFO = path.join(path.dirname(MANIFEST_PATH), 'build-info.json');
const external = process.argv.includes('--external');

if (!fs.existsSync(BUILD) || !fs.existsSync(INFO)) {
  console.error('No build found. Run `npm run build` first.');
  process.exit(1);
}
const { url: siteUrl, baseUrl } = JSON.parse(fs.readFileSync(INFO, 'utf8'));
const origin = new URL(siteUrl).origin;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

// Route path (without baseUrl) -> built file, the way GitHub Pages resolves it.
// Never throws on malformed escapes ("100%"): falls back to the literal text.
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function resolveFile(routePath) {
  let p = safeDecode(routePath).replace(/^\/+/, '');
  const candidates = p === '' ? ['index.html'] : [p, `${p}.html`, path.join(p, 'index.html')];
  for (const c of candidates) {
    const abs = path.join(BUILD, c);
    if (abs.startsWith(BUILD) && fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

const idCache = new Map();
function ids(file) {
  if (!idCache.has(file)) {
    const html = fs.readFileSync(file, 'utf8');
    idCache.set(file, new Set([...html.matchAll(/\s(?:id|name)="([^"]+)"/g)].map((m) => m[1])));
  }
  return idCache.get(file);
}

const pages = walk(BUILD);
const broken = [];
const anchors = [];
const externals = new Map(); // url -> first page seen on
let checked = 0;

for (const file of pages) {
  const html = fs.readFileSync(file, 'utf8');
  const rel = path.relative(BUILD, file).split(path.sep).join('/');
  const pageUrl = new URL(baseUrl + rel.replace(/(index)?\.html$/, ''), origin);
  for (const m of html.matchAll(/\s(href|src)="([^"]+)"/g)) {
    const raw = m[2].replace(/&amp;/g, '&');
    if (/^(mailto:|tel:|javascript:|data:|#$)/i.test(raw)) continue;
    let u;
    try {
      u = new URL(raw, pageUrl);
    } catch {
      continue;
    }
    if (u.origin !== origin) {
      if (/^https?:$/.test(u.protocol) && !externals.has(u.href.split('#')[0])) externals.set(u.href.split('#')[0], rel);
      continue;
    }
    if (!u.pathname.startsWith(baseUrl.replace(/\/$/, '')) ) {
      broken.push(`${rel}: ${raw} (outside the site's base path ${baseUrl})`);
      continue;
    }
    checked++;
    const target = resolveFile(u.pathname.slice(baseUrl.length - 1));
    if (!target) {
      broken.push(`${rel}: ${raw}`);
      continue;
    }
    const hash = safeDecode(u.hash.slice(1));
    if (hash && target.endsWith('.html') && !ids(target).has(hash)) anchors.push(`${rel}: ${raw}`);
  }
}

// Every page the manifest promises must exist.
const missing = [];
if (fs.existsSync(MANIFEST_PATH)) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  for (const r of manifest.repos || []) {
    for (const v of r.versions) for (const p of v.pages) if (!resolveFile(p.route)) missing.push(p.route);
    for (const a of r.apis || []) {
      if (!resolveFile(a.route)) missing.push(a.route);
      if (a.explorerRoute && !resolveFile(a.explorerRoute)) missing.push(a.explorerRoute);
    }
  }
}
const has404 = fs.existsSync(path.join(BUILD, '404.html'));

// Optional external check.
const extBad = [];
if (external && externals.size) {
  const list = [...externals.keys()];
  let i = 0;
  const one = async (url) => {
    const ctrl = AbortSignal.timeout(10000);
    try {
      let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl, headers: { 'User-Agent': 'docgen-link-check' } });
      if (res.status === 405 || res.status === 403) res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'docgen-link-check' } });
      if (res.status >= 400 && ![401, 403, 429].includes(res.status)) extBad.push(`${res.status} ${url}  (on ${externals.get(url)})`);
    } catch (e) {
      extBad.push(`ERR ${url}  (on ${externals.get(url)}: ${e.name === 'TimeoutError' ? 'timeout' : e.message})`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < list.length) await one(list[i++]);
  }));
}

// Report.
const uniq = (xs) => [...new Set(xs)];
console.log(`docgen check: ${pages.length} pages, ${checked} internal links/assets${external ? `, ${externals.size} external links` : ` (external links not checked; use --external)`}`);
if (!has404) console.log('  ✖ no 404.html in the build');
for (const b of uniq(broken).slice(0, 50)) console.log(`  ✖ broken: ${b}`);
for (const m of uniq(missing)) console.log(`  ✖ missing page: /${m}`);
for (const a of uniq(anchors).slice(0, 30)) console.log(`  ! anchor not found: ${a}`);
for (const e of extBad.slice(0, 50)) console.log(`  ! external: ${e}`);
const blocking = uniq(broken).length + uniq(missing).length + (has404 ? 0 : 1);
console.log(
  blocking
    ? `\n${blocking} blocking problem(s): visitors would hit 404s. Fix before pushing.`
    : `\nNo broken internal links or missing pages.${anchors.length || extBad.length ? ` ${uniq(anchors).length} anchor and ${extBad.length} external warning(s) to review.` : ''}`,
);
process.exit(blocking ? 1 : 0);
