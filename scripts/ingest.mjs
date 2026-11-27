#!/usr/bin/env node
// Fetch public GitHub README(s) and generate Docusaurus docs under site/docs/.
//
//   node scripts/ingest.mjs [--only repo1,repo2] [--dry-run] [--config path] [--keep-going]
//
// Unexpected errors (network, rate limit, GitHub 5xx, unreadable content) stop the run
// before anything is written, so the previous output stays intact and CI never deploys a
// site with repos silently missing. --keep-going skips the failing repo instead (local use).
// Expected skips (no README, not Markdown, private or missing repos) only warn.
//
// Layout produced:
//   site/docs/index.md                       all projects
//   site/docs/<repo>/overview.md ...         repo without releases
//   site/docs/<repo>/<tag>/overview.md ...   one folder per release (newest first)
//   site/apis/<repo>/[<tag>/]reference.md    when the repo contains an OpenAPI/Swagger spec
//   site/apis/<repo>/[<tag>/]explorer.mdx    interactive explorer for that spec
//
// Generated folders carry a _docgen.json marker; only marked folders are ever
// removed, so hand-written files under site/docs/ are left alone.

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadMapping, parseRepoRef, parseOwnerRef, describeSource, DOCS_DIR, APIS_DIR, GEN_STATIC_DIR, MANIFEST_PATH, ROOT } from './lib/config.mjs';
import { GitHub } from './lib/github.mjs';
import { buildPages, makeBuildSafe, overviewOnlyReason } from './lib/markdown.mjs';
import { redactSecrets } from './lib/secrets.mjs';
import { findSpecPaths, parseSpec, specSlug, renderReference, endpointCount } from './lib/openapi.mjs';

import { allocateRepoFolders, allocateVersionFolders, NEXT_FOLDER } from './lib/folders.mjs';
import { commitStage } from './lib/staging.mjs';

const API_FILES = path.join(GEN_STATIC_DIR, 'apis-files');
const STAGE_DIR = path.join(path.dirname(MANIFEST_PATH), 'staging');
const BACKUP_DIR = path.join(path.dirname(MANIFEST_PATH), 'backup');
// Where the writers put files. Points at the staging folder during a run; see commit().
let OUT = { docs: DOCS_DIR, apis: APIS_DIR, static: GEN_STATIC_DIR };
const outApiFiles = () => path.join(OUT.static, 'apis-files');
const SECTIONS_PATH = path.join(path.dirname(MANIFEST_PATH), 'sections.json');
let MAPPING = { forRepo: () => ({}) };

const MARKER = '_docgen.json';
const args = parseArgs(process.argv.slice(2));
const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('WARN', ...a);
// An unexpected failure: fatal (nothing written) unless --keep-going.
const failOrWarn = (msg) => {
  if (!args.keepGoing) throw new Error(msg);
  warn(`${msg} (--keep-going: continuing without it)`);
};

function parseArgs(argv) {
  const out = { only: null, dryRun: false, config: undefined, keepGoing: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--only') out.only = argv[++i];
    else if (a.startsWith('--only=')) out.only = a.slice(7);
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--keep-going') out.keepGoing = true;
    else if (a === '-h' || a === '--help') {
      console.log('usage: node scripts/ingest.mjs [--only name1,name2] [--dry-run] [--config docgen.config.json] [--keep-going]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (out.only) out.only = new Set(out.only.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  return out;
}

const glob = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
// Patterns match the repo name ("tool*") or the full name ("acme/tool*").
const matchesAny = (repo, patterns) => patterns.some((p) => glob(p).test(p.includes('/') ? repo.full_name : repo.name));

// Folder-safe version name; leading digit gets a "v" so it reads as a version.
export function versionFolder(tag) {
  let s = tag.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'release';
  if (/^\d/.test(s)) s = `v${s}`;
  return s;
}

const yamlStr = (s) => JSON.stringify(String(s));
const yamlList = (xs) => `[${xs.map(yamlStr).join(', ')}]`;

function frontmatter(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || (Array.isArray(v) && !v.length)) continue;
    const val = Array.isArray(v) ? yamlList(v) : typeof v === 'string' ? yamlStr(v) : typeof v === 'object' ? JSON.stringify(v) : v;
    lines.push(`${k}: ${val}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

// Union of: every public repo of each owner (filtered) + each explicitly listed repo.
// Explicit repos skip the fork/archived/include filters — the user asked for them by name.
async function selectRepos(gh, source) {
  const self = parseRepoRef(process.env.GITHUB_REPOSITORY);
  const isSelf = (r) => self && r.full_name.toLowerCase() === `${self.owner}/${self.name}`.toLowerCase();
  const byName = new Map();
  const add = (r) => byName.set(r.full_name.toLowerCase(), r);

  for (const ref of source.owners) {
    const owner = parseOwnerRef(ref);
    const all = await gh.ownerRepos(owner);
    const skipped = {};
    let kept = 0;
    for (const r of all) {
      const why =
        (r.fork && !source.includeForks && 'fork') ||
        (r.archived && !source.includeArchived && 'archived') ||
        (r.disabled && 'disabled') ||
        (r.name === '.github' && 'profile repo') ||
        (r.name.toLowerCase() === `${owner.toLowerCase()}.github.io` && 'Pages site repo') ||
        (isSelf(r) && "this site's own repo") ||
        (source.include.length && !matchesAny(r, source.include) && 'not in include') ||
        (matchesAny(r, source.exclude) && 'excluded');
      if (why) (skipped[why] ||= []).push(r.name);
      else {
        add(r);
        kept++;
      }
    }
    log(`${owner}: ${all.length} public repos, ${kept} selected`);
    for (const [why, names] of Object.entries(skipped)) {
      log(`  skipped ${names.length} (${why})${names.length <= 8 ? ': ' + names.join(', ') : ''}`);
    }
  }

  for (const ref of source.repos) {
    const { owner, name } = parseRepoRef(ref);
    try {
      add(await gh.repo(owner, name));
    } catch (e) {
      if (e.code === 'NOT_PUBLIC' || e.code === 'NOT_FOUND') warn(e.message); // expected: skip it
      else failOrWarn(`${owner}/${name}: ${e.message}`);
    }
  }

  // Folder = repo name; if two owners have a repo with the same name, use owner-name.
  // Folders are unique case-insensitively and avoid names Docusaurus uses (tags, index).
  const repos = [...byName.values()].sort((a, b) => a.full_name.localeCompare(b.full_name));
  const folders = allocateRepoFolders(repos);
  for (const r of repos) {
    const { folder, clash } = folders.get(r.full_name);
    r.folder = folder;
    r.label = clash ? r.full_name : r.name;
    if (clash) log(`  ${r.full_name} → folder "${r.folder}" (name shared with another repo or reserved)`);
  }
  return repos;
}

async function versionsFor(gh, repo, vcfg) {
  const fallback = [{ ref: repo.default_branch, folder: null, label: null, latest: true }];
  if (!vcfg.enabled) return fallback;
  const releases = (await gh.releases(repo.owner.login, repo.name))
    .filter((r) => !r.draft && (vcfg.includePrereleases || !r.prerelease))
    .sort((a, b) => new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at))
    .slice(0, vcfg.max);
  if (!releases.length) return fallback;
  // Unique case-insensitively; "next" is reserved for the default branch when enabled.
  const folders = allocateVersionFolders(releases.map((r) => versionFolder(r.tag_name)), { reserveNext: vcfg.includeDefaultBranch });
  const out = releases.map((r, i) => {
    const folder = folders[i];
    return {
      ref: r.tag_name,
      folder,
      label: r.tag_name,
      name: r.name || r.tag_name,
      date: (r.published_at || r.created_at || '').slice(0, 10),
      url: r.html_url,
      prerelease: r.prerelease,
      latest: i === 0,
    };
  });
  if (vcfg.includeDefaultBranch) {
    out.unshift({ ref: repo.default_branch, folder: NEXT_FOLDER, label: `${repo.default_branch} (unreleased)`, latest: false, next: true });
  }
  return out;
}

async function processRepo(gh, repo, cfg) {
  const versions = await versionsFor(gh, repo, cfg.source.versions);
  const built = [];
  for (const v of versions) {
    const readme = await gh.readme(repo.owner.login, repo.name, v.ref);
    if (!readme) {
      warn(`${repo.name}@${v.ref}: no README`);
      continue;
    }
    if (/\.[a-z]+$/i.test(readme.path) && !/\.(md|markdown|mdown|mkdn)$/i.test(readme.path)) {
      warn(`${repo.name}@${v.ref}: README is ${path.extname(readme.path)}, not Markdown — skipped`);
      continue;
    }
    // "Last updated" = last commit that touched the README at this ref.
    let commit = null;
    if (cfg.content.lastUpdated) {
      try {
        commit = await gh.lastCommit(repo.owner.login, repo.name, readme.path, v.ref);
      } catch (e) {
        failOrWarn(`${repo.full_name}@${v.ref}: could not read the README's last commit (${e.message})`);
      }
    }
    const result = buildPages({
      readme: readme.text,
      readmePath: readme.path,
      repo,
      ref: v.ref,
      versionLabel: v.label,
      content: cfg.content,
      mapping: MAPPING.forRepo(repo.full_name),
    });
    for (const w of result.warnings) (w.startsWith('re-pointed') ? log : warn)(`${repo.name}${v.label ? `@${v.label}` : ''}: ${w}`);
    let apis = [];
    if (cfg.content.openapi.enabled) {
      try {
        apis = await findApis(gh, repo, v, cfg);
      } catch (e) {
        failOrWarn(`${repo.full_name}@${v.ref}: OpenAPI detection failed (${e.message})`);
      }
    }
    built.push({ version: v, readmePath: readme.path, commit, apis, ...result });
  }
  if (!built.length && !cfg.source.includeEmpty) {
    log(`  skip ${repo.name} (no Markdown README)`);
    return null;
  }
  if (!built.length) {
    built.push({
      version: versions[0],
      readmePath: null,
      commit: null,
      title: repo.name,
      description: repo.description || `Source code for ${repo.name}.`,
      readmeTags: [],
      pages: [{ bucket: 'overview', file: 'overview.md', label: 'Overview', position: 1, body: `${repo.description || ''}\n\n[View the repository on GitHub](${repo.html_url})\n` }],
      warnings: [],
    });
  }
  return { repo, built };
}

// OpenAPI/Swagger specs in the repo at this ref (1 API call for the tree; files come from raw).
async function findApis(gh, repo, v, cfg) {
  const tree = await gh.tree(repo.owner.login, repo.name, v.ref);
  const found = [];
  const slugs = new Set();
  const seen = new Set(); // same API shipped as both .json and .yaml -> keep the first (JSON sorts first)
  for (const p of findSpecPaths(tree, cfg.content.openapi.maxPerVersion * 2)) {
    if (found.length >= cfg.content.openapi.maxPerVersion) break;
    let text = await gh.rawFile(repo.owner.login, repo.name, v.ref, p);
    if (!text) continue;
    if (cfg.content.redactSecrets) text = redactSecrets(text).text;
    const spec = parseSpec(text, p);
    if (!spec) continue;
    const key = `${spec.info?.title}|${spec.info?.version}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let slug = specSlug(spec, p);
    while (slugs.has(slug)) slug += '-1';
    slugs.add(slug);
    // "Last updated" for API pages = last commit that touched the spec (not the README) at this ref.
    let commit = null;
    if (cfg.content.lastUpdated) {
      try {
        commit = await gh.lastCommit(repo.owner.login, repo.name, p, v.ref);
      } catch (e) {
        failOrWarn(`${repo.full_name}@${v.ref}: could not read the last commit of ${p} (${e.message})`);
      }
    }
    found.push({ path: p, text, spec, slug, commit, title: spec.info?.title || repo.name, apiVersion: spec.info?.version || '', endpoints: endpointCount(spec) });
    log(`${repo.name}${v.label ? `@${v.label}` : ''}: OpenAPI spec ${p} (${found.at(-1).endpoints} endpoints)`);
  }
  return found;
}

function tagsFor(repo, readmeTags, cfg) {
  const topics = cfg.content.tagsFromTopics ? repo.topics || [] : [];
  const seen = new Set();
  return [...readmeTags, ...topics].filter((t) => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function writeRepo(entry, cfg) {
  const { repo, built } = entry;
  const repoDir = path.join(OUT.docs, repo.folder);
  fs.mkdirSync(repoDir, { recursive: true });
  const versioned = built.some((b) => b.version.folder);
  const latest = built.find((b) => b.version.latest) || built[0];
  const record = {
    name: repo.folder,
    repoName: repo.name,
    fullName: repo.full_name,
    title: latest.title,
    description: latest.description,
    url: repo.html_url,
    homepage: repo.homepage || null,
    language: repo.language,
    license: repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : null,
    stars: repo.stargazers_count,
    updatedAt: repo.pushed_at,
    docsUpdatedAt: latest.commit?.date || null,
    tags: tagsFor(repo, latest.readmeTags, cfg),
    versions: [],
    apis: [],
  };

  for (const b of built) {
    const v = b.version;
    v.position = built.indexOf(b) + 1;
    const dir = v.folder ? path.join(repoDir, v.folder) : repoDir;
    fs.mkdirSync(dir, { recursive: true });
    const tags = tagsFor(repo, b.readmeTags, cfg);
    const docBase = [repo.folder, v.folder].filter(Boolean).join('/');
    const suffix = v.folder ? ` (${v.label})` : '';
    const editable = !v.folder || v.next;
    const multi = (b.apis || []).length > 1;
    const apis = (b.apis || []).map((a) => ({ ...a, docBase: [repo.folder, v.folder, multi ? a.slug : null].filter(Boolean).join('/') }));
    for (const p of b.pages) {
      const isOverview = p.bucket === 'overview';
      const fm = frontmatter({
        title: isOverview ? `${b.title}${suffix}` : `${b.title}${suffix}: ${p.label}`,
        sidebar_label: p.label,
        sidebar_position: p.position,
        description: isOverview ? b.description : `${p.label} for ${b.title}${suffix}. ${b.description}`.slice(0, 300),
        tags,
        keywords: [repo.name, ...(repo.topics || [])].slice(0, 12),
        custom_edit_url: editable && b.readmePath ? `https://github.com/${repo.full_name}/edit/${repo.default_branch}/${b.readmePath}` : null,
        docgen_repo: repo.full_name,
        docgen_ref: v.ref,
        docgen_commit: b.commit?.sha || null,
        last_update: b.commit?.date ? { date: b.commit.date.slice(0, 10) } : null,
      });
      const provenance = b.readmePath
        ? `\n---\n\n<small>Generated from [\`${b.readmePath}\`](https://github.com/${repo.full_name}/blob/${b.commit?.sha || encodeURIComponent(v.ref)}/${b.readmePath}) in [${repo.full_name}](${repo.html_url})${v.label ? ` at \`${v.label}\`` : ''}${b.commit ? ` · commit [\`${b.commit.sha.slice(0, 7)}\`](${b.commit.url})` : ''}.</small>\n`
        : '';
      const apiSection =
        isOverview && apis.length
          ? `\n## API reference\n\n${apis.map((a) => `- **[${a.title}](/apis/${a.docBase}/reference)**${a.apiVersion ? ` \`${a.apiVersion}\`` : ''}: ${a.endpoints} endpoint(s)${cfg.content.openapi.explorer ? ` · [interactive explorer](/apis/${a.docBase}/explorer)` : ''}`).join('\n')}\n`
          : '';
      fs.writeFileSync(path.join(dir, p.file), fm + p.body + apiSection + provenance);
    }
    if (v.folder) {
      const label = v.next ? v.label : v.latest ? `${v.label} (latest)` : v.label;
      fs.writeFileSync(
        path.join(dir, '_category_.json'),
        JSON.stringify({ label, position: built.indexOf(b) + 1, collapsed: !v.latest, link: { type: 'doc', id: `${docBase}/overview` } }, null, 2) + '\n',
      );
    }
    writeApis(repo, b, apis, suffix, tags, cfg, record);
    record.versions.push({
      label: v.label,
      folder: v.folder,
      ref: v.ref,
      date: v.date || null,
      commit: b.commit ? { sha: b.commit.sha, date: b.commit.date, url: b.commit.url } : null,
      latest: Boolean(v.latest),
      releaseUrl: v.url || null,
      route: `docs/${docBase}/overview`,
      pages: b.pages.map((p) => ({ bucket: p.bucket, label: p.label, route: `docs/${docBase}/${p.file.replace(/\.md$/, '')}`, file: path.relative(OUT.docs, path.join(dir, p.file)) })),
    });
  }

  if (record.apis.length) {
    const apiRepoDir = path.join(OUT.apis, repo.folder);
    const apiVersioned = record.apis.some((a) => a.versionFolder);
    fs.writeFileSync(
      path.join(apiRepoDir, '_category_.json'),
      JSON.stringify({ label: repo.label, collapsed: true, ...(apiVersioned ? { link: { type: 'generated-index', title: `${latest.title} APIs`, description: latest.description, slug: `/${repo.folder}` } } : {}) }, null, 2) + '\n',
    );
    fs.writeFileSync(path.join(apiRepoDir, MARKER), JSON.stringify({ generatedBy: 'docgen', repo: repo.full_name }, null, 2) + '\n');
  }

  const category = { label: repo.label, collapsed: true, link: versioned ? { type: 'generated-index', title: latest.title, description: latest.description, slug: `/${repo.folder}` } : { type: 'doc', id: `${repo.folder}/overview` } };
  fs.writeFileSync(path.join(repoDir, '_category_.json'), JSON.stringify(category, null, 2) + '\n');
  fs.writeFileSync(path.join(repoDir, MARKER), JSON.stringify({ generatedBy: 'docgen', repo: repo.full_name }, null, 2) + '\n');
  return record;
}

function writeApis(repo, b, apis, suffix, tags, cfg, record) {
  if (!apis.length) return;
  const v = b.version;
  const vdir = path.join(OUT.apis, repo.folder, v.folder || '');
  fs.mkdirSync(vdir, { recursive: true });
  if (v.folder) {
    const label = v.next ? v.label : v.latest ? `${v.label} (latest)` : v.label;
    fs.writeFileSync(path.join(vdir, '_category_.json'), JSON.stringify({ label, position: v.position ?? 1, collapsed: !v.latest }, null, 2) + '\n');
  }
  for (const a of apis) {
    const dir = path.join(OUT.apis, a.docBase);
    fs.mkdirSync(dir, { recursive: true });
    const fileName = path.posix.basename(a.path);
    const staticRel = ['apis-files', a.docBase, fileName].join('/');
    fs.mkdirSync(path.dirname(path.join(OUT.static, staticRel)), { recursive: true });
    fs.writeFileSync(path.join(OUT.static, staticRel), a.text);
    const ref = a.commit?.sha || v.ref;
    const sourceUrl = `https://github.com/${repo.full_name}/blob/${encodeURIComponent(ref)}/${a.path}`;
    const rawUrl = `https://raw.githubusercontent.com/${repo.full_name}/${encodeURIComponent(ref)}/${a.path}`;
    const desc = (a.spec.info?.description || `${a.title} — HTTP API of ${repo.full_name}.`).replace(/\s+/g, ' ').slice(0, 250);
    const common = {
      tags: [...tags, 'API'],
      keywords: [repo.name, 'api', 'openapi', ...(repo.topics || [])].slice(0, 12),
      docgen_repo: repo.full_name,
      docgen_ref: v.ref,
      last_update: a.commit?.date ? { date: a.commit.date.slice(0, 10) } : null,
    };
    const ref1 = frontmatter({ title: `${a.title}${suffix}`, sidebar_label: 'API reference', sidebar_position: 1, description: desc, ...common });
    const body = makeBuildSafe(renderReference({ spec: a.spec, sourceUrl, rawUrl, explorer: cfg.content.openapi.explorer ? './explorer.mdx' : null }));
    const footer = `\n\n---\n\n<small>Generated from [\`${a.path}\`](${sourceUrl}) in [${repo.full_name}](${repo.html_url})${v.label ? ` at \`${v.label}\`` : ''}. Project docs: [${b.title}](/docs/${[repo.folder, v.folder].filter(Boolean).join('/')}/overview).</small>\n`;
    fs.writeFileSync(path.join(dir, 'reference.md'), ref1 + body + footer);
    if (cfg.content.openapi.explorer) {
      const ex = frontmatter({ title: `${a.title}${suffix}: interactive explorer`, sidebar_label: 'Interactive explorer', sidebar_position: 2, hide_table_of_contents: true, description: desc, ...common });
      fs.writeFileSync(
        path.join(dir, 'explorer.mdx'),
        `${ex}import ApiExplorer from '@site/src/components/ApiExplorer';\n\n<ApiExplorer specUrl={${JSON.stringify('/' + staticRel)}} title={${JSON.stringify(a.title)}} sourceUrl={${JSON.stringify(sourceUrl)}} />\n`,
      );
    }
    if (apis.length > 1) {
      fs.writeFileSync(path.join(dir, '_category_.json'), JSON.stringify({ label: a.title, collapsed: false }, null, 2) + '\n');
    }
    record.apis.push({
      title: a.title,
      apiVersion: a.apiVersion,
      endpoints: a.endpoints,
      version: v.label,
      versionFolder: v.folder,
      latest: Boolean(v.latest),
      specPath: a.path,
      specUrl: '/' + staticRel,
      sourceUrl,
      description: desc,
      docId: `${a.docBase}/reference`,
      route: `apis/${a.docBase}/reference`,
      explorerRoute: cfg.content.openapi.explorer ? `apis/${a.docBase}/explorer` : null,
      file: path.relative(OUT.apis, path.join(dir, 'reference.md')),
    });
  }
}

function writeApiIndex(records, cfg) {
  const withApis = records.filter((r) => r.apis && r.apis.length);
  const idx = path.join(OUT.apis, 'index.md');
  if (!withApis.length) return; // commit() removes a previous APIs index
  fs.mkdirSync(OUT.apis, { recursive: true });
  const rows = withApis.flatMap((r) =>
    r.apis
      .filter((a) => a.latest || !a.versionFolder)
      .map((a) => `- **[${a.title}](./${a.file})**${a.apiVersion ? ` \`${a.apiVersion}\`` : ''} — ${r.title}${a.version ? ` (${a.version})` : ''} · ${a.endpoints} endpoint(s)${a.explorerRoute ? ` · [explorer](./${a.file.replace(/reference\.md$/, 'explorer.mdx')})` : ''}`),
  );
  const body = [
    frontmatter({ title: 'All APIs', sidebar_label: 'All APIs', sidebar_position: 0, slug: '/', last_update: { date: new Date().toISOString().slice(0, 10) }, description: `HTTP API references for ${cfg.site.title}.` }),
    'HTTP API references generated from the OpenAPI / Swagger specifications found in each repository. Every API has a static reference (searchable) and an interactive explorer.',
    '',
    ...rows,
    '',
  ].join('\n');
  fs.writeFileSync(idx, body);
}

function writeIndex(records, cfg) {
  const rows = records.map((r) => {
    const latest = r.versions.find((v) => v.latest) || r.versions[0];
    const link = `./${latest.pages[0].file}`;
    const ver = latest.label ? ` · \`${latest.label}\`` : '';
    const tags = r.tags.length ? ` · ${r.tags.map((t) => `\`${t}\``).join(' ')}` : '';
    return `- **[${r.title === r.name ? r.name : `${r.title} (${r.name})`}](${link})**${ver} — ${r.description}${tags}`;
  });
  const body = [
    frontmatter({
      title: 'All projects',
      sidebar_label: 'All projects',
      sidebar_position: 0,
      slug: '/',
      last_update: { date: new Date().toISOString().slice(0, 10) },
      description: cfg.site.description || cfg.site.tagline,
    }),
    cfg.site.description || cfg.site.tagline,
    '',
    `Every project below has an **Overview** and, where its README provides them, **Tutorials**, **How-to guides**, **Reference** and **Explanation** pages ([Diátaxis](https://diataxis.fr/)). Browse by [tag](/docs/tags) or use the search bar.`,
    '',
    ...rows,
    '',
  ].join('\n');
  fs.mkdirSync(OUT.docs, { recursive: true });
  fs.writeFileSync(path.join(OUT.docs, 'index.md'), body);
}

// Per repo: is the README structured (Diátaxis template)? Where did each section go, and
// why? Read by `npm run sections` and the docgen-map skill. Latest version per repo.
function writeSectionsReport(entries, outFile, partial) {
  let old = [];
  if (partial && fs.existsSync(SECTIONS_PATH)) old = JSON.parse(fs.readFileSync(SECTIONS_PATH, 'utf8')).repos || [];
  const fresh = entries.map(({ repo, built }) => {
    const b = built.find((x) => x.version.latest) || built[0];
    return {
      repo: repo.full_name,
      folder: repo.folder,
      version: b.version.label || b.version.ref,
      readmePath: b.readmePath,
      readmeCommit: b.commit?.sha || null,
      structured: Boolean(b.structured),
      unclassified: (b.sections || []).filter((x) => x.source === 'default').length,
      sections: b.sections || [],
      overviewOnly: overviewOnlyReason(b.sections || []),
    };
  });
  const ids = new Set(fresh.map((r) => r.repo.toLowerCase()));
  const repos = [...old.filter((r) => !ids.has(String(r.repo).toLowerCase())), ...fresh].sort((a, b) => a.repo.localeCompare(b.repo));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), repos }, null, 2) + '\n');
}

// Generated paths the new output replaces. Only DocGen's own output is ever touched:
// folders carrying the marker file, the generated index pages and copied API specs.
const isGeneratedIndex = (p, label) => fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes(`sidebar_label: "${label}"`);
function retireList(onlyFolders) {
  const out = [];
  for (const root of [DOCS_DIR, APIS_DIR]) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      const p = path.join(root, name);
      if (onlyFolders && !onlyFolders.has(name)) continue;
      if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, MARKER))) out.push(p);
    }
  }
  // Copied specs: retire per repo folder, the same level the installs use.
  if (onlyFolders) for (const name of onlyFolders) out.push(path.join(API_FILES, name));
  else if (fs.existsSync(API_FILES)) for (const name of fs.readdirSync(API_FILES)) out.push(path.join(API_FILES, name));
  if (isGeneratedIndex(path.join(DOCS_DIR, 'index.md'), 'All projects')) out.push(path.join(DOCS_DIR, 'index.md'));
  if (isGeneratedIndex(path.join(APIS_DIR, 'index.md'), 'All APIs')) out.push(path.join(APIS_DIR, 'index.md'));
  return out.filter((p) => fs.existsSync(p));
}

// Everything written to the staging folder, mapped to where it belongs.
function installList() {
  const pairs = [];
  const add = (stageRoot, finalRoot) => {
    if (!fs.existsSync(stageRoot)) return;
    for (const name of fs.readdirSync(stageRoot)) pairs.push([path.join(stageRoot, name), path.join(finalRoot, name)]);
  };
  add(OUT.docs, DOCS_DIR);
  add(OUT.apis, APIS_DIR);
  add(outApiFiles(), API_FILES);
  return pairs;
}

// Every page the records promise must exist in the staging folder before anything is swapped.
function validateStage(fresh) {
  const missing = [];
  for (const r of fresh) {
    for (const v of r.versions) for (const p of v.pages) if (!fs.existsSync(path.join(OUT.docs, p.file))) missing.push(p.file);
    for (const api of r.apis || []) if (!fs.existsSync(path.join(OUT.apis, api.file))) missing.push(api.file);
  }
  if (!fs.existsSync(path.join(OUT.docs, 'index.md'))) missing.push('index.md');
  if (missing.length) throw new Error(`generated output is incomplete (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}); nothing was changed`);
}

async function main() {
  const cfg = loadConfig(args.config && path.resolve(args.config));
  MAPPING = loadMapping();
  const problems = [...cfg.errors, ...MAPPING.errors];
  if (problems.length) {
    console.error('Configuration problems:\n' + problems.map((e) => `  - ${e}`).join('\n'));
    process.exit(1);
  }
  const gh = new GitHub();
  log(`docgen ingest — ${describeSource(cfg.source)}; GitHub API: ${gh.authenticated ? 'authenticated' : 'anonymous (60 req/h; set GITHUB_TOKEN for more)'}`);

  let repos = await selectRepos(gh, cfg.source);
  const previous = fs.existsSync(MANIFEST_PATH) ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')).repos || [] : [];
  // --only refreshes a subset. That is only consistent while every repo keeps its folder:
  // adding a repo can rename another (a/tool → a-tool once b/tool arrives). Then refresh all.
  let partial = Boolean(args.only);
  if (partial) {
    const subset = repos.filter((r) => [r.name, r.full_name, r.folder].some((n) => args.only.has(n.toLowerCase())));
    if (!subset.length) throw new Error(`--only matched no selected repository`);
    const oldFolder = new Map(previous.map((r) => [String(r.fullName).toLowerCase(), r.name]));
    const moved = repos.filter((r) => oldFolder.has(r.full_name.toLowerCase()) && oldFolder.get(r.full_name.toLowerCase()) !== r.folder);
    if (!previous.length) {
      log('--only: no previous build to merge into; refreshing everything');
      partial = false;
    } else if (moved.length) {
      log(`--only: folder names changed (${moved.map((r) => `${r.full_name}: ${oldFolder.get(r.full_name.toLowerCase())} → ${r.folder}`).join(', ')}); refreshing everything to keep the site consistent`);
      partial = false;
    } else repos = subset;
  }
  if (args.dryRun) {
    for (const r of repos) log(`  would build ${r.full_name} → site/docs/${r.folder}/`);
    return;
  }

  // Fetch everything first; only touch the output folders once every repo succeeded.
  const failures = [];
  const entries = (await pool(repos, 4, async (r) => {
    try {
      return await processRepo(gh, r, cfg);
    } catch (e) {
      if (args.keepGoing) warn(`${r.full_name}: ${e.message} (--keep-going: skipped)`);
      else failures.push(`${r.full_name}: ${e.message}`);
      return null;
    }
  })).filter(Boolean);
  if (failures.length) {
    throw new Error(
      `${failures.length} repo(s) failed, so nothing was changed (the previous output is intact):\n` +
        failures.map((f) => `  - ${f}`).join('\n') +
        '\nRe-run (most failures are temporary), or use --keep-going to build without them locally.',
    );
  }

  if (!entries.length) throw new Error('no documentation was produced — check the source settings and that the repos have Markdown READMEs');

  // Write everything to a staging folder; the live output is untouched until commit.
  fs.rmSync(STAGE_DIR, { recursive: true, force: true });
  if (fs.existsSync(BACKUP_DIR)) {
    warn(`a previous run was interrupted while installing output; discarding ${path.relative(ROOT, BACKUP_DIR)} (generated content is rebuilt from GitHub)`);
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  }
  OUT = { docs: path.join(STAGE_DIR, 'docs'), apis: path.join(STAGE_DIR, 'apis'), static: path.join(STAGE_DIR, 'static') };

  // Owner display names/descriptions for the home page header (fetched before any write).
  const owners = [];
  for (const ref of cfg.source.owners) {
    try {
      owners.push(await gh.ownerProfile(parseOwnerRef(ref)));
    } catch (e) {
      warn(`could not read the profile of ${ref} for the home page header (${e.message})`);
    }
  }

  const fresh = entries.map((e) => writeRepo(e, cfg));
  let records = fresh;
  if (partial) {
    // Reconcile by repository identity, never by folder name.
    const ids = new Set(fresh.map((r) => r.fullName.toLowerCase()));
    records = [...previous.filter((r) => !ids.has(String(r.fullName).toLowerCase())), ...fresh];
  }
  records.sort((a, b) => a.name.localeCompare(b.name));
  writeIndex(records, cfg);
  writeApiIndex(records, cfg);

  // Metadata is staged too, so pages, manifest and section report change together or not at all.
  const META = path.join(STAGE_DIR, 'meta');
  writeSectionsReport(entries, path.join(META, 'sections.json'), partial);
  fs.writeFileSync(
    path.join(META, 'manifest.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), source: { owners: cfg.source.owners, repos: cfg.source.repos }, owners, hasApis: records.some((r) => r.apis && r.apis.length), repos: records }, null, 2) + '\n',
  );
  validateStage(fresh);
  for (const f of ['sections.json', 'manifest.json']) JSON.parse(fs.readFileSync(path.join(META, f), 'utf8'));

  // Swap everything in at once; on failure the previous output (pages and metadata) is restored.
  try {
    commitStage({
    retire: [...retireList(partial ? new Set(entries.map((e) => e.repo.folder)) : null), ...[SECTIONS_PATH, MANIFEST_PATH].filter((p) => fs.existsSync(p))],
    installs: [...installList(), [path.join(META, 'sections.json'), SECTIONS_PATH], [path.join(META, 'manifest.json'), MANIFEST_PATH]],
    backupDir: BACKUP_DIR,
    });
  } finally {
    fs.rmSync(STAGE_DIR, { recursive: true, force: true }); // success or rollback: no leftovers
    OUT = { docs: DOCS_DIR, apis: APIS_DIR, static: GEN_STATIC_DIR };
  }
  const report = JSON.parse(fs.readFileSync(SECTIONS_PATH, 'utf8')).repos;
  const needs = report.filter((r) => r.unclassified);
  if (needs.length) log(`${needs.length} repo(s) have unclassified README sections (left on Overview): ${needs.map((r) => r.repo).join(', ')}. Run \`npm run sections\` or the docgen-map skill`);
  const plain = report.filter((r) => r.overviewOnly);
  if (plain.length) log(`${plain.length} repo(s) have only an Overview page:\n${plain.map((r) => `  - ${r.repo}: ${r.overviewOnly}`).join('\n')}`);

  const pages = records.reduce((n, r) => n + r.versions.reduce((m, v) => m + v.pages.length, 0), 0);
  const apiCount = records.reduce((n, r) => n + (r.apis ? r.apis.length : 0), 0);
  log(`done: ${records.length} project(s), ${pages} page(s)${apiCount ? `, ${apiCount} API reference(s)` : ''} in ${path.relative(ROOT, DOCS_DIR)} — ${gh.calls} API call(s)${gh.remaining !== null ? `, ${gh.remaining} remaining` : ''}`);
}

main().catch((e) => {
  console.error(`ERROR ${e.message}`);
  process.exit(1);
});
