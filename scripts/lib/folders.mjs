// Output folder allocation. Every generated folder must be unique, compared
// case-insensitively (macOS and Windows file systems, and URLs people type, ignore case),
// and must not collide with routes Docusaurus generates itself.

// Top-level names under site/docs and site/apis that Docusaurus or DocGen already use.
export const RESERVED_TOP = ['tags', 'index', 'category'];
// Version folder used for the default branch when versions.includeDefaultBranch is on.
export const NEXT_FOLDER = 'next';

function claim(taken, wanted) {
  let name = wanted;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${wanted}-${n}`;
  taken.add(name.toLowerCase());
  return name;
}

/**
 * Assign each repo a folder. A repo keeps its plain name when nobody else wants it;
 * repos sharing a name (case-insensitive) or using a reserved name become owner-name,
 * with -2, -3 … only if that is taken too (e.g. a repo literally named "a-tool").
 * Deterministic: input is processed in full_name order.
 * @param {{name: string, full_name: string, owner: {login: string}}[]} repos
 * @returns {Map<string, {folder: string, clash: boolean}>} keyed by full_name
 */
export function allocateRepoFolders(repos) {
  const sorted = [...repos].sort((a, b) => a.full_name.localeCompare(b.full_name));
  const count = new Map();
  for (const r of sorted) count.set(r.name.toLowerCase(), (count.get(r.name.toLowerCase()) || 0) + 1);
  const reserved = new Set(RESERVED_TOP);
  const taken = new Set(reserved);
  const out = new Map();
  // Pass 1: unambiguous plain names claim first, so they never get pushed aside.
  for (const r of sorted) {
    const key = r.name.toLowerCase();
    if (count.get(key) === 1 && !reserved.has(key)) out.set(r.full_name, { folder: claim(taken, r.name), clash: false });
  }
  // Pass 2: everything else gets owner-name (made unique if needed).
  for (const r of sorted) {
    if (!out.has(r.full_name)) out.set(r.full_name, { folder: claim(taken, `${r.owner.login}-${r.name}`), clash: true });
  }
  return out;
}

/**
 * Make release folder names unique within one repo, reserving "next" when the default
 * branch gets its own folder.
 * @param {string[]} wanted  sanitized folder names in release order (newest first)
 * @param {{reserveNext?: boolean}} [opts]
 */
export function allocateVersionFolders(wanted, { reserveNext = false } = {}) {
  const taken = new Set(reserveNext ? [NEXT_FOLDER] : []);
  return wanted.map((w) => claim(taken, w));
}
