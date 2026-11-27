#!/usr/bin/env node
// Preflight check: is this machine ready to build a docgen site?
//
//   node scripts/doctor.mjs            local checks
//   node scripts/doctor.mjs --online   also checks GitHub reachability, rate limit and the source
//
// Needs only Node itself. Python is NOT required. Exit code 1 if anything blocking fails.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, loadConfig, parseRepoRef, parseOwnerRef, describeSource } from './lib/config.mjs';
import { GitHub } from './lib/github.mjs';

const online = process.argv.includes('--online');
const results = [];
const ok = (name, detail) => results.push(['ok', name, detail]);
const bad = (name, detail, fix) => results.push(['fail', name, detail, fix]);
const note = (name, detail, fix) => results.push(['warn', name, detail, fix]);

function version(cmd, args = ['--version']) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' }).trim();
  } catch {
    return null;
  }
}

// Node
const major = Number(process.versions.node.split('.')[0]);
if (major >= 22) ok('Node.js', `v${process.versions.node} (>= 22 required; use an LTS release: 22 or 24)`);
else bad('Node.js', `v${process.versions.node} is too old`, 'Install Node 22 or newer (22 or 24 LTS): https://nodejs.org or `nvm install 22`');

// npm
const npm = version('npm');
if (npm) ok('npm', `v${npm}`);
else bad('npm', 'not found on PATH', 'npm ships with Node.js — reinstall Node from https://nodejs.org');

// git
const git = version('git');
if (git) ok('git', git.replace(/^git version /, 'v'));
else bad('git', 'not found on PATH', 'Install git: https://git-scm.com/downloads (macOS: `xcode-select --install`)');

// Python — explicitly not needed.
ok('Python', 'not required (the whole pipeline is Node.js)');

// Dependencies
const core = path.join(ROOT, 'node_modules', '@docusaurus', 'core', 'package.json');
if (fs.existsSync(core)) ok('Dependencies', `@docusaurus/core ${JSON.parse(fs.readFileSync(core, 'utf8')).version} installed`);
else bad('Dependencies', 'node_modules missing', 'Run `npm install` (or `npm ci`) in the project root');

// Config
let cfg = null;
try {
  cfg = loadConfig();
  if (cfg.errors.length) bad('docgen.config.json', cfg.errors.join('; '), 'Fix the listed fields (see docgen.config.example.json)');
  else ok('docgen.config.json', describeSource(cfg.source));
} catch (e) {
  bad('docgen.config.json', e.message, 'cp docgen.config.example.json docgen.config.json');
}

// Branding
if (cfg && !cfg.errors.length) {
  const b = cfg.branding;
  ok('Branding', `logo: ${b.logo || 'default'}, favicon: ${b.favicon || (b.logo ? 'same as logo' : 'default')}, colour: ${b.primaryColor}`);
}

// Token (presence only — never print it)
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (token) ok('GitHub token', 'set (used only for api.github.com, never written to disk)');
else note('GitHub token', 'not set — anonymous API limit is 60 requests/hour', 'Optional. For large orgs: export GITHUB_TOKEN=<read-only token>. CI uses the built-in token automatically.');

// .env files that could leak into a commit
for (const f of ['.env', '.env.local', 'site/.env']) {
  if (fs.existsSync(path.join(ROOT, f))) note('Secrets hygiene', `${f} exists`, 'It is gitignored, but docgen never needs one — delete it if unused');
}

if (online) {
  const gh = new GitHub();
  try {
    const rl = await gh.rateLimit();
    ok('GitHub API', `reachable, ${rl.remaining}/${rl.limit} requests left this hour`);
    if (cfg && !cfg.errors.length) {
      let total = 0;
      for (const ref of cfg.source.owners) {
        const owner = parseOwnerRef(ref);
        const repos = await gh.ownerRepos(owner);
        total += repos.length;
        ok(`Source: ${owner}`, `${repos.length} public repositories`);
      }
      for (const ref of cfg.source.repos) {
        const { owner, name } = parseRepoRef(ref);
        const r = await gh.repo(owner, name);
        total += 1;
        ok(`Source: ${r.full_name}`, `public (default branch ${r.default_branch})`);
      }
      // Per repo: 1 (release list) + ~3 per version folder (README, last commit, tree).
      // Repos without releases build one folder; repos with releases up to versions.max.
      const max = cfg.source.versions.enabled ? Math.max(1, cfg.source.versions.max) : 1;
      const overhead = cfg.source.owners.length * 3 + cfg.source.repos.length; // listings + one lookup per named repo
      const low = total * 4 + overhead;
      const high = total * (1 + 3 * max) + overhead;
      const range = low === high ? `~${low}` : `~${low} (no releases) to ~${high} (every repo with ${max}+ releases)`;
      if (token) ok('Rate limit', `${range} API calls per run; your token allows 5,000/hour`);
      else if (low > 50) note('Rate limit', `${range} API calls per run; anonymous limit is 60/hour`, 'Export a token before running ingest: export GITHUB_TOKEN=$(gh auth token)  (see README "Use a GitHub token")');
      else if (high > 50) note('Rate limit', `${range} API calls per run; anonymous limit is 60/hour`, 'Fine if few of these repos publish releases; otherwise export a token: export GITHUB_TOKEN=$(gh auth token)');
      else ok('Rate limit', `${range} API calls per run; fits the anonymous 60/hour (no token needed)`);
    }
  } catch (e) {
    bad('GitHub API', e.message, 'Check your network connection and the source settings');
  }
}

const icon = { ok: '✔', warn: '!', fail: '✖' };
const width = Math.max(...results.map((r) => r[1].length));
console.log('docgen doctor\n');
for (const [status, name, detail, fix] of results) {
  console.log(`${icon[status]} ${name.padEnd(width)}  ${detail}`);
  if (fix && status !== 'ok') console.log(`  ${' '.repeat(width)}  → ${fix}`);
}
const failed = results.filter((r) => r[0] === 'fail').length;
console.log(failed ? `\n${failed} blocking problem(s).` : '\nReady.');
process.exit(failed ? 1 : 0);
