#!/usr/bin/env node
// How was each README split into Diátaxis pages — and which sections still need a decision?
// Reads site/.docgen/sections.json (written by `npm run ingest`).
//
//   node scripts/sections.mjs                     repos with unclassified sections (default)
//   node scripts/sections.mjs --all               every section of every repo
//   node scripts/sections.mjs --repo owner/name   one repo, every section
//   node scripts/sections.mjs --json              machine-readable (for agents)
//
//   node scripts/sections.mjs set owner/name "Heading=how-to" ["Other heading=omit" ...]
//       records decisions in docgen.mapping.json (validated, merged, README commit noted).
//       Categories: overview, tutorials, how-to, reference, explanation, omit
//       Use owner "*" to apply to every repo. Re-run `npm run ingest` afterwards.

import fs from 'node:fs';
import path from 'node:path';
import { MANIFEST_PATH, MAPPING_PATH, MAPPING_CATEGORIES, parseRepoRef } from './lib/config.mjs';
import { overviewOnlyReason } from './lib/markdown.mjs';

const SECTIONS_PATH = path.join(path.dirname(MANIFEST_PATH), 'sections.json');
const args = process.argv.slice(2);

function readReport() {
  if (!fs.existsSync(SECTIONS_PATH)) {
    console.error('No section report yet. Run `npm run ingest` first.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(SECTIONS_PATH, 'utf8'));
}

if (args[0] === 'set') {
  const [, repo, ...pairs] = args;
  if (!repo || (repo !== '*' && !parseRepoRef(repo)) || !pairs.length) {
    console.error('usage: node scripts/sections.mjs set <owner/name|*> "Heading=category" [...]');
    process.exit(2);
  }
  const map = fs.existsSync(MAPPING_PATH) ? JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf8')) : {};
  map.$comment ||= 'Where README sections go when a README does not follow the Diátaxis template. Written by the docgen-map skill or by hand; committed so CI applies the same decisions. Categories: overview, tutorials, how-to, reference, explanation, omit.';
  map.repos ||= {};
  const key = Object.keys(map.repos).find((k) => k.toLowerCase() === repo.toLowerCase()) || repo;
  const entry = (map.repos[key] ||= { sections: {} });
  entry.sections ||= {};
  for (const p of pairs) {
    const i = p.lastIndexOf('=');
    const heading = p.slice(0, i).trim();
    const cat = p.slice(i + 1).trim();
    if (i < 1 || !heading || heading === '__proto__' || !MAPPING_CATEGORIES.includes(cat)) {
      console.error(`invalid "${p}" — expected "Heading=${MAPPING_CATEGORIES.join('|')}"`);
      process.exit(2);
    }
    entry.sections[heading] = cat;
  }
  if (repo !== '*' && fs.existsSync(SECTIONS_PATH)) {
    const r = (readReport().repos || []).find((x) => x.repo.toLowerCase() === repo.toLowerCase());
    if (r?.readmeCommit) entry.readmeCommit = r.readmeCommit;
  }
  entry.updatedAt = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(MAPPING_PATH, JSON.stringify(map, null, 2) + '\n');
  console.log(`docgen.mapping.json: ${key} — ${pairs.length} section(s) recorded. Run \`npm run ingest\` to apply.`);
  process.exit(0);
}

const report = readReport();
const flag = (n) => args.includes(n);
const only = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : null;
// Older reports lack the field; derive it so the listing is always complete.
for (const r of report.repos || []) if (r.overviewOnly === undefined) r.overviewOnly = overviewOnlyReason(r.sections || []);
let repos = report.repos || [];
if (only) repos = repos.filter((r) => r.repo.toLowerCase() === only.toLowerCase());
if (!flag('--all') && !only) repos = repos.filter((r) => r.unclassified > 0 || r.overviewOnly);

if (flag('--json')) {
  console.log(JSON.stringify({ generatedAt: report.generatedAt, repos }, null, 2));
  process.exit(0);
}

const all = report.repos || [];
console.log(
  `${all.length} repo(s): ${all.filter((r) => r.structured).length} use the Diátaxis template, ` +
    `${all.filter((r) => !r.structured && !r.unclassified).length} fully classified by rules/mapping, ` +
    `${all.filter((r) => r.unclassified).length} with unclassified sections, ` +
    `${all.filter((r) => r.overviewOnly).length} with only an Overview page.\n`,
);
const plain = all.filter((r) => r.overviewOnly);
if (plain.length) {
  console.log('Only an Overview page (no Tutorials, How-to, Reference or Explanation):');
  for (const r of plain) console.log(`  - ${r.repo}: ${r.overviewOnly}`);
  console.log('');
}
if (!repos.length) {
  console.log('Nothing needs a decision. Use --all to see every section.');
  process.exit(0);
}
const SRC = { template: 'template', heading: 'Diátaxis heading', mapping: 'mapping', rule: 'rule', default: 'UNCLASSIFIED', intro: 'intro', off: 'off', 'no-headings': 'no headings' };
for (const r of repos) {
  console.log(`${r.repo} @ ${r.version}${r.structured ? '  (Diátaxis template)' : ''}${r.overviewOnly ? '  (Overview only)' : ''}`);
  for (const s of r.sections) {
    if (!flag('--all') && !only && !r.overviewOnly && s.source !== 'default') continue;
    const head = s.heading ? `"${s.heading}"` : '(intro)';
    console.log(`  ${head.padEnd(42)} → ${s.category.padEnd(11)} [${SRC[s.source] || s.source}${s.foldedFrom ? `, folded from ${s.foldedFrom}: too short` : ''}, ${s.lines} lines]`);
    if (s.source === 'default' || only) console.log(`      ${s.preview.slice(0, 160)}${s.preview.length > 160 ? '…' : ''}`);
  }
  console.log('');
}
console.log('Record a decision:  npm run sections -- set owner/name "Heading=how-to"   (then npm run ingest)');
