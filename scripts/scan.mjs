#!/usr/bin/env node
// Leak gate. Fails (exit 1) if anything that would be published looks like a secret.
//
//   node scripts/scan.mjs
//
// Scans: generated docs and APIs (site/docs, site/apis), generated static files such as
// copied OpenAPI specs (site/.docgen/static), the build output (site/build), every file
// git would commit, and the CI workflows (for secrets.* use and unsafe triggers).
// Text is detected by content, not only by extension, and scanned whatever its size (large
// files in overlapping chunks). A file that cannot be read fails the scan. Binary files
// (images, fonts) are counted and reported, never claimed as checked.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './lib/config.mjs';
import { findSecrets, mask } from './lib/secrets.mjs';

const TEXT_EXT = /\.(md|mdx|txt|html?|json|js|mjs|cjs|jsx|ts|tsx|css|xml|ya?ml|toml|svg|sh)$/i;
const FORBIDDEN_FILES = /(^|\/)(\.env(\..*)?|id_rsa|id_ed25519|.*\.pem|.*\.p12|.*\.pfx|.*\.key|credentials\.json|\.npmrc|\.netrc)$/i;
const CHUNK = 8 * 1024 * 1024; // scan large files in 8 MB windows …
const OVERLAP = 64 * 1024; // … overlapping by 64 KB so no secret is split between windows
const findings = [];
let binary = 0;
let scanned = 0;

// Yields [text, offset] windows covering the whole file.
function* windows(file, size) {
  if (size <= CHUNK) {
    yield [fs.readFileSync(file, 'utf8'), 0];
    return;
  }
  const fd = fs.openSync(file, 'r');
  try {
    for (let pos = 0; pos < size; pos += CHUNK - OVERLAP) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
      fs.readSync(fd, buf, 0, buf.length, pos);
      yield [buf.toString('utf8'), pos];
      if (pos + buf.length >= size) break;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function isText(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return !buf.subarray(0, n).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.docusaurus') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function scanFile(file) {
  const rel = path.relative(ROOT, file);
  if (FORBIDDEN_FILES.test(rel.split(path.sep).join('/')) && !rel.endsWith('.env.example')) {
    findings.push(`${rel}: file type must never be published`);
    return;
  }
  try {
    const { size } = fs.statSync(file);
    if (!TEXT_EXT.test(file) && !isText(file)) {
      binary++;
      return;
    }
    const seen = new Set();
    for (const [text, offset] of windows(file, size)) {
      for (const h of findSecrets(text)) {
        const at = offset + Buffer.byteLength(text.slice(0, h.index));
        if (seen.has(at)) continue; // found again in the overlap
        seen.add(at);
        const where = size <= CHUNK ? `:${text.slice(0, h.index).split('\n').length}` : ` (byte ${at})`;
        findings.push(`${rel}${where}: ${h.kind} ${mask(h.match)}`);
      }
    }
    scanned++;
  } catch (e) {
    findings.push(`${rel}: could not be scanned (${e.code || e.message}); refusing to publish unscanned content`);
  }
}

function gitFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean).map((f) => path.join(ROOT, f));
  } catch {
    return []; // not a git repo yet
  }
}

function scanWorkflows() {
  const dir = path.join(ROOT, '.github', 'workflows');
  for (const f of walk(dir)) {
    const rel = path.relative(ROOT, f);
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)/g)) {
      if (m[1] !== 'GITHUB_TOKEN') findings.push(`${rel}: uses secrets.${m[1]} — docgen needs no secrets; remove it or justify it explicitly`);
    }
    if (/^\s*pull_request_target\s*:/m.test(text)) findings.push(`${rel}: pull_request_target runs untrusted PR code with write access — use pull_request`);
    if (/\bprintenv\b|\benv\s*\|\s*|echo\s+\$\{?\{?\s*secrets/.test(text)) findings.push(`${rel}: prints environment/secrets to the log`);
  }
}

const files = new Set([
  ...['docs', 'apis', path.join('.docgen', 'static'), 'build'].flatMap((d) => walk(path.join(ROOT, 'site', d))),
  ...gitFiles(),
]);
for (const f of files) if (fs.existsSync(f)) scanFile(f);
scanWorkflows();

if (findings.length) {
  console.error(`docgen scan: ${findings.length} problem(s) — nothing should be published until fixed:\n`);
  for (const f of findings) console.error(`  ✖ ${f}`);
  console.error('\nIf a secret came from an upstream README, it is already public there: rotate it and fix the README.');
  process.exit(1);
}
console.log(
  `docgen scan: ${scanned} text file(s) scanned, no secrets or unsafe workflow settings found.` +
    (binary ? ` ${binary} binary file(s) (images, fonts) contain no text to scan.` : ''),
);
