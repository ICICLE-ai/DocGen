#!/usr/bin/env node
// What changed upstream since the last ingest? Compares GitHub with site/.docgen/manifest.json.
//
//   node scripts/status.mjs [--json]
//
// Reports, per repo: new (now selected, not built yet), removed (no longer selected,
// public or existing), changed (new commits since its docs were built — compares the
// repo's pushed_at with the manifest), and new releases. Costs ~1 API call per 100 repos
// of each owner, 1 per explicitly listed repo, and 1 per changed repo (releases check).
// Prints the exact command to refresh only what changed. Writes nothing.

import fs from 'node:fs';
import { loadConfig, parseOwnerRef, parseRepoRef, MANIFEST_PATH } from './lib/config.mjs';
import { GitHub } from './lib/github.mjs';

const json = process.argv.includes('--json');
const glob = (p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
const matches = (r, ps) => ps.some((p) => glob(p).test(p.includes('/') ? r.full_name : r.name));

async function main() {
  const cfg = loadConfig();
  if (cfg.errors.length) throw new Error(`config problems: ${cfg.errors.join('; ')}`);
  const manifest = fs.existsSync(MANIFEST_PATH) ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) : null;
  if (!manifest) {
    const msg = 'No previous build found (site/.docgen/manifest.json). Run `npm run ingest` first.';
    if (json) console.log(JSON.stringify({ firstRun: true, message: msg }));
    else console.log(msg);
    return;
  }
  const gh = new GitHub();
  const src = cfg.source;

  // Current selection (same rules as ingest, without fetching READMEs).
  const current = new Map();
  for (const ref of src.owners) {
    const owner = parseOwnerRef(ref);
    for (const r of await gh.ownerRepos(owner)) {
      const skip =
        (r.fork && !src.includeForks) ||
        (r.archived && !src.includeArchived) ||
        r.disabled ||
        r.name === '.github' ||
        r.name.toLowerCase() === `${owner.toLowerCase()}.github.io` ||
        (src.include.length && !matches(r, src.include)) ||
        matches(r, src.exclude);
      if (!skip) current.set(r.full_name.toLowerCase(), r);
    }
  }
  for (const ref of src.repos) {
    const { owner, name } = parseRepoRef(ref);
    try {
      const r = await gh.repo(owner, name);
      current.set(r.full_name.toLowerCase(), r);
    } catch {
      /* not public / gone — shows up as removed */
    }
  }

  const built = new Map(manifest.repos.map((r) => [r.fullName.toLowerCase(), r]));
  const report = { builtAt: manifest.generatedAt, added: [], removed: [], changed: [], unchanged: 0 };

  for (const [key, r] of current) {
    const old = built.get(key);
    if (!old) {
      report.added.push({ repo: r.full_name, folder: r.name });
      continue;
    }
    if (r.pushed_at && old.updatedAt && new Date(r.pushed_at) > new Date(old.updatedAt)) {
      const entry = { repo: r.full_name, folder: old.name, lastBuilt: old.updatedAt, pushedAt: r.pushed_at, newReleases: [] };
      if (src.versions.enabled) {
        const known = new Set(old.versions.map((v) => v.ref));
        const rels = (await gh.releases(r.owner.login, r.name)).filter((x) => !x.draft && (src.versions.includePrereleases || !x.prerelease));
        entry.newReleases = rels
          .sort((x, y) => new Date(y.published_at || y.created_at) - new Date(x.published_at || x.created_at))
          .slice(0, src.versions.max)
          .map((x) => x.tag_name)
          .filter((t) => !known.has(t));
      }
      report.changed.push(entry);
    } else report.unchanged++;
  }
  for (const [key, old] of built) if (!current.has(key)) report.removed.push({ repo: old.fullName, folder: old.name });

  const refresh = [...report.added, ...report.changed].map((x) => x.repo);
  report.command = report.removed.length ? 'npm run ingest' : refresh.length ? `npm run ingest -- --only ${refresh.join(',')}` : null;

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`Last build: ${manifest.generatedAt}\n`);
  for (const a of report.added) console.log(`  + new       ${a.repo}`);
  for (const c of report.changed) {
    console.log(`  ~ changed   ${c.repo}  (pushed ${c.pushedAt.slice(0, 10)})${c.newReleases.length ? `  new release(s): ${c.newReleases.join(', ')}` : ''}`);
  }
  for (const r of report.removed) console.log(`  - removed   ${r.repo}  (no longer selected, public or existing)`);
  console.log(`\n${report.added.length} new, ${report.changed.length} changed, ${report.removed.length} removed, ${report.unchanged} unchanged.`);
  if (report.command) console.log(`\nRefresh with:\n  ${report.command}\n  npm run build && npm run scan`);
  else console.log('\nEverything is up to date.');
}

main().catch((e) => {
  console.error(`ERROR ${e.message}`);
  process.exit(1);
});
