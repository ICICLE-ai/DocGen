// Loads docgen.config.json, fills defaults and validates it.
// Shared by the CLI scripts and site/docusaurus.config.js (standard library only).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SITE_DIR = path.join(ROOT, 'site');
export const DOCS_DIR = path.join(SITE_DIR, 'docs');
export const APIS_DIR = path.join(SITE_DIR, 'apis');
export const GEN_STATIC_DIR = path.join(SITE_DIR, '.docgen', 'static');
export const MANIFEST_PATH = path.join(SITE_DIR, '.docgen', 'manifest.json');
export const BRANDING_DIR = path.join(ROOT, 'branding');

const DEFAULTS = {
  site: {
    title: 'Documentation',
    tagline: 'Tutorials, how-to guides, reference and explanation for our projects.',
    description: '',
    url: 'auto',
    baseUrl: 'auto',
    name: '', // who the hub is for; defaults to the GitHub org/user display name or repo title
    heroTitle: '', // defaults to "Welcome to the Official Documentation Hub for <name>"
    copyrightHolder: '', // defaults to name
    footer: '', // extra footer line
  },
  source: {
    owners: [], // every public repo of these users/orgs
    repos: [], // plus exactly these repos (owner/name)
    include: [],
    exclude: [],
    includeForks: false,
    includeArchived: false,
    includeEmpty: false,
    versions: {
      enabled: true,
      max: 5,
      includePrereleases: false,
      includeDefaultBranch: false,
    },
  },
  branding: {
    logo: '',
    favicon: '',
    socialCard: '',
    banner: '',
    primaryColor: '#2563eb',
  },
  content: {
    diataxis: 'auto',
    stopAtHeadings: [],
    tagsFromTopics: true,
    tagsFromReadme: true,
    redactSecrets: true,
    lastUpdated: true,
    openapi: {
      enabled: true,
      maxPerVersion: 3,
      explorer: true,
    },
  },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function merge(base, over) {
  if (!isObj(over)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('$')) continue;
    out[k] = isObj(base[k]) && isObj(v) ? merge(base[k], v) : v;
  }
  return out;
}

// "owner/name", "https://github.com/owner/name(.git)(/...)" -> {owner, name}
export function parseRepoRef(value) {
  const s = String(value || '').trim().replace(/\.git$/, '');
  const m = s.match(/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(?:\/.*)?$/);
  return m ? { owner: m[1], name: m[2] } : null;
}

// "acme", "https://github.com/acme" -> "acme"
export function parseOwnerRef(value) {
  const s = String(value || '').trim().replace(/\/+$/, '');
  const m = s.match(/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]+)$/);
  return m ? m[1] : null;
}

// Where the site will live. Explicit config wins; then DOCGEN_SITE_URL (set in CI
// from actions/configure-pages, so custom domains work); then the GitHub Pages default
// for GITHUB_REPOSITORY; then localhost.
export function resolveSiteUrl(site, env = process.env) {
  const norm = (base) => {
    let b = base || '/';
    if (!b.startsWith('/')) b = `/${b}`;
    if (!b.endsWith('/')) b = `${b}/`;
    return b;
  };
  if (site.url && site.url !== 'auto') {
    return { url: site.url.replace(/\/+$/, ''), baseUrl: norm(site.baseUrl === 'auto' ? '/' : site.baseUrl) };
  }
  if (env.DOCGEN_SITE_URL) {
    const u = new URL(env.DOCGEN_SITE_URL);
    return { url: u.origin, baseUrl: site.baseUrl !== 'auto' ? norm(site.baseUrl) : norm(u.pathname) };
  }
  const repo = parseRepoRef(env.GITHUB_REPOSITORY);
  if (repo) {
    const owner = repo.owner.toLowerCase();
    const userSite = repo.name.toLowerCase() === `${owner}.github.io`;
    return {
      url: `https://${owner}.github.io`,
      baseUrl: site.baseUrl !== 'auto' ? norm(site.baseUrl) : userSite ? '/' : `/${repo.name}/`,
    };
  }
  return { url: 'http://localhost:3000', baseUrl: site.baseUrl !== 'auto' ? norm(site.baseUrl) : '/' };
}

// Fold the legacy single-source keys (mode/repo/org) into owners/repos, dedupe.
export function normalizeSource(source) {
  const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const uniq = (xs) => [...new Map(xs.map((x) => [String(x).toLowerCase(), x])).values()];
  const owners = uniq([...asList(source.owners), ...asList(source.org)].map((o) => String(o).trim()).filter(Boolean));
  const repos = uniq([...asList(source.repos), ...asList(source.repo)].map((r) => String(r).trim()).filter(Boolean));
  const out = { ...source, owners, repos };
  delete out.mode;
  delete out.org;
  delete out.repo;
  return out;
}

// The GitHub link shown in the navbar/footer.
export function sourceUrl(source) {
  const owners = source.owners.map(parseOwnerRef).filter(Boolean);
  const repos = source.repos.map(parseRepoRef).filter(Boolean);
  if (!owners.length && repos.length === 1) return `https://github.com/${repos[0].owner}/${repos[0].name}`;
  const first = owners[0] || (repos[0] && repos[0].owner);
  return first ? `https://github.com/${first}` : 'https://github.com';
}

export const describeSource = (source) =>
  [source.owners.length ? `all public repos of ${source.owners.join(', ')}` : '', source.repos.length ? `repos ${source.repos.join(', ')}` : '']
    .filter(Boolean)
    .join(' + ');

export function validate(cfg) {
  const errors = [];
  const { source, branding, content } = cfg;
  if (!source.owners.length && !source.repos.length) {
    errors.push('source needs at least one entry in "owners" (users/orgs: all their public repos) or "repos" (owner/name)');
  }
  for (const o of source.owners) {
    if (/YOUR-/i.test(o)) errors.push(`source.owners: "${o}" is still the placeholder — set your GitHub username or org`);
    else if (!parseOwnerRef(o)) errors.push(`source.owners: "${o}" must be a user/org name or https://github.com/<name>`);
  }
  for (const r of source.repos) {
    if (/YOUR-/i.test(r)) errors.push(`source.repos: "${r}" is still the placeholder — set it to owner/name`);
    else if (!parseRepoRef(r)) errors.push(`source.repos: "${r}" must be "owner/name" or https://github.com/owner/name`);
  }
  if (!Number.isInteger(source.versions.max) || source.versions.max < 1) errors.push('source.versions.max must be an integer >= 1');
  if (!['auto', 'strict', 'off'].includes(content.diataxis)) errors.push('content.diataxis must be "auto", "strict" or "off"');
  if (branding.primaryColor && !/^#[0-9a-fA-F]{6}$/.test(branding.primaryColor)) errors.push('branding.primaryColor must be a #rrggbb hex colour');
  for (const key of ['logo', 'favicon', 'socialCard', 'banner']) {
    const v = branding[key];
    if (!v || /^https:\/\//.test(v)) continue;
    const abs = path.resolve(ROOT, v);
    if (!abs.startsWith(BRANDING_DIR + path.sep)) errors.push(`branding.${key} must be an https:// URL or a file inside branding/ (got "${v}")`);
    else if (!fs.existsSync(abs)) errors.push(`branding.${key}: file not found: ${v}`);
  }
  return errors;
}

export function loadConfig(file = path.join(ROOT, 'docgen.config.json')) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${path.relative(process.cwd(), file) || file}. Copy docgen.config.example.json to docgen.config.json and fill in "source".`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
  const cfg = merge(DEFAULTS, raw);
  cfg.source = normalizeSource(cfg.source);
  cfg.errors = validate(cfg);
  return cfg;
}

// Map a branding entry to what Docusaurus expects: absolute URL or a path served from
// the static dir. Files in branding/ are served from the site root (staticDirectories).
export function brandAsset(value, fallback) {
  if (!value) return fallback;
  if (/^https:\/\//.test(value)) return value;
  const abs = path.resolve(ROOT, value);
  if (!abs.startsWith(BRANDING_DIR + path.sep) || !fs.existsSync(abs)) return fallback;
  return path.relative(BRANDING_DIR, abs).split(path.sep).join('/');
}

// ------------------------------------------------------------------ section mapping
// docgen.mapping.json — where each README section goes, for READMEs that don't follow
// the Diátaxis template. Written by the docgen-map skill (an AI agent, locally) or by
// hand, reviewed by a person and committed, so CI applies the same decisions.
//
// { "repos": { "owner/repo": { "readmeCommit": "<sha>", "sections": { "Heading text": "how-to" } },
//              "*":          { "sections": { "Sponsors": "omit" } } } }
export const MAPPING_PATH = path.join(ROOT, 'docgen.mapping.json');
export const MAPPING_CATEGORIES = ['overview', 'tutorials', 'how-to', 'reference', 'explanation', 'omit'];

const normKey = (h) => String(h || '').replace(/\s+/g, ' ').trim().toLowerCase();

export function loadMapping(file = MAPPING_PATH) {
  const empty = { errors: [], forRepo: () => ({}), raw: { repos: {} } };
  if (!fs.existsSync(file)) return empty;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ...empty, errors: [`docgen.mapping.json is not valid JSON: ${e.message}`] };
  }
  const errors = [];
  const table = new Map();
  for (const [repo, entry] of Object.entries(raw.repos || {})) {
    if (repo !== '*' && !parseRepoRef(repo)) errors.push(`docgen.mapping.json: "${repo}" must be "owner/name" or "*"`);
    const secs = Object.create(null);
    for (const [heading, cat] of Object.entries((entry && entry.sections) || {})) {
      if (!MAPPING_CATEGORIES.includes(cat)) errors.push(`docgen.mapping.json: ${repo} → "${heading}": "${cat}" is not one of ${MAPPING_CATEGORIES.join(', ')}`);
      else secs[normKey(heading)] = cat;
    }
    table.set(repo.toLowerCase(), secs);
  }
  return {
    errors,
    raw,
    forRepo: (fullName) => Object.assign(Object.create(null), table.get('*') || {}, table.get(String(fullName).toLowerCase()) || {}),
  };
}
