#!/usr/bin/env node
// List the public repositories of one or more GitHub users/orgs, so a person (or an
// agent) can choose what to document. Needs no config. Costs ~1 API call per 100 repos.
//
//   node scripts/list.mjs <user-or-org> [<user-or-org> ...] [--json]
//
// Output is numbered; forks and archived repos are flagged (they are skipped by
// default unless includeForks / includeArchived is set, or the repo is listed by name).

import { parseOwnerRef } from './lib/config.mjs';
import { GitHub } from './lib/github.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const owners = args.filter((a) => !a.startsWith('--')).map(parseOwnerRef);

if (!owners.length || owners.includes(null)) {
  console.error('usage: node scripts/list.mjs <user-or-org> [<user-or-org> ...] [--json]');
  process.exit(2);
}

const gh = new GitHub();
const rows = [];
try {
  for (const owner of owners) {
    for (const r of await gh.ownerRepos(owner)) {
      rows.push({
        fullName: r.full_name,
        name: r.name,
        owner: r.owner.login,
        ownerType: r.owner.type, // "User" | "Organization"
        description: r.description || '',
        fork: r.fork,
        archived: r.archived,
        stars: r.stargazers_count,
        pushedAt: (r.pushed_at || '').slice(0, 10),
        topics: r.topics || [],
      });
    }
  }
} catch (e) {
  console.error(`ERROR ${e.message}`);
  process.exit(1);
}

if (json) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const width = Math.min(40, Math.max(4, ...rows.map((r) => r.fullName.length)));
let current = null;
rows.forEach((r, i) => {
  if (r.owner !== current) {
    current = r.owner;
    const n = rows.filter((x) => x.owner === r.owner).length;
    console.log(`\n${r.owner} (${r.ownerType === 'Organization' ? 'organization' : 'user'}) — ${n} public repos`);
  }
  const flags = [r.fork && 'fork', r.archived && 'archived'].filter(Boolean).join(', ');
  const desc = r.description.length > 70 ? `${r.description.slice(0, 69)}…` : r.description;
  console.log(`${String(i + 1).padStart(4)}. ${r.fullName.padEnd(width)}  ★${String(r.stars).padEnd(5)} ${r.pushedAt}  ${flags ? `[${flags}] ` : ''}${desc}`);
});
const skipped = rows.filter((r) => r.fork || r.archived).length;
console.log(`\n${rows.length} public repos; ${skipped} fork/archived (skipped by default when documenting a whole account).`);
