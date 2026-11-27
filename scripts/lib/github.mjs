// Minimal GitHub REST client (Node >= 22 global fetch, no dependencies).
//
// Security rules enforced here:
//   - A token (GITHUB_TOKEN / GH_TOKEN) is optional and only ever sent to api.github.com.
//   - The token is never logged, written to disk or embedded in output.
//   - Only repositories that GitHub reports as public are returned.

const API = 'https://api.github.com';

export class GitHub {
  constructor({ token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '', log = () => {} } = {}) {
    this.token = token;
    this.log = log;
    this.calls = 0;
    this.remaining = null;
  }

  get authenticated() {
    return Boolean(this.token);
  }

  async request(pathOrUrl, { accept = 'application/vnd.github+json', allow404 = false } = {}) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`;
    if (new URL(url).origin !== API) throw new Error(`refusing to call non-GitHub-API URL: ${url}`);
    const headers = {
      Accept: accept,
      'User-Agent': 'docgen',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    for (let attempt = 0; attempt < 3; attempt++) {
      this.calls++;
      let res;
      try {
        res = await fetch(url, { headers });
      } catch (e) {
        if (attempt === 2) throw new Error(`network error calling ${url}: ${e.message}`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      const rem = res.headers.get('x-ratelimit-remaining');
      if (rem !== null) this.remaining = Number(rem);
      if (res.status === 404 && allow404) return { status: 404, data: null, headers: res.headers };
      if ((res.status === 403 || res.status === 429) && this.remaining === 0) {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        const mins = Math.max(1, Math.round((reset - Date.now()) / 60000));
        throw new Error(
          `GitHub API rate limit reached (resets in ~${mins} min). ` +
            (this.token ? '' : 'Set GITHUB_TOKEN (a read-only token is enough) to raise the limit from 60 to 5000 requests/hour.'),
        );
      }
      if (res.status >= 500 && attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`GitHub API ${res.status} for ${url.replace(API, '')}: ${body.slice(0, 200)}`);
      }
      return { status: res.status, data: await res.json(), headers: res.headers };
    }
    throw new Error(`failed to call ${url}`);
  }

  async paginate(pathname) {
    const out = [];
    let next = `${API}${pathname}${pathname.includes('?') ? '&' : '?'}per_page=100`;
    while (next) {
      const { data, headers } = await this.request(next);
      out.push(...data);
      const link = headers.get('link') || '';
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      next = m ? m[1] : null;
    }
    return out;
  }

  async repo(owner, name) {
    const { data } = await this.request(`/repos/${owner}/${name}`, { allow404: true });
    const fail = (code, msg) => Object.assign(new Error(msg), { code });
    if (!data) throw fail('NOT_FOUND', `repository ${owner}/${name} not found (or not public) — skipped`);
    if (!isPublic(data)) throw fail('NOT_PUBLIC', `repository ${owner}/${name} is not public — skipped (docgen only publishes public repositories)`);
    return data;
  }

  // Display name + description of a user or org (for the home page header).
  async ownerProfile(owner) {
    const org = await this.request(`/orgs/${owner}`, { allow404: true });
    const d = org.data || (await this.request(`/users/${owner}`, { allow404: true })).data;
    if (!d) throw new Error(`GitHub account "${owner}" not found`);
    return {
      login: d.login,
      type: org.data ? 'Organization' : 'User',
      name: d.name || d.login,
      description: (org.data ? d.description : d.bio) || '',
      url: d.html_url,
      website: d.blog || null,
    };
  }

  // Public repos of an organization, falling back to a user account.
  async ownerRepos(owner) {
    const org = await this.request(`/orgs/${owner}`, { allow404: true });
    const list = org.data
      ? await this.paginate(`/orgs/${owner}/repos?type=public&sort=full_name`)
      : await this.paginate(`/users/${owner}/repos?type=owner&sort=full_name`);
    return list.filter(isPublic);
  }

  async releases(owner, name) {
    return this.paginate(`/repos/${owner}/${name}/releases`);
  }

  // README at a ref -> { text, path } or null. Uses the API so any README filename
  // GitHub recognises (README.md, readme.rst, docs/README.md ...) is found.
  async readme(owner, name, ref) {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const { data } = await this.request(`/repos/${owner}/${name}/readme${q}`, { allow404: true });
    if (!data || data.encoding !== 'base64') return null;
    return { text: Buffer.from(data.content, 'base64').toString('utf8'), path: data.path };
  }

  // Most recent commit touching `filePath` at `ref` -> { sha, date, url } or null.
  async lastCommit(owner, name, filePath, ref) {
    const q = `?path=${encodeURIComponent(filePath)}&sha=${encodeURIComponent(ref)}&per_page=1`;
    const { data } = await this.request(`/repos/${owner}/${name}/commits${q}`, { allow404: true });
    const c = Array.isArray(data) && data[0];
    if (!c) return null;
    return { sha: c.sha, date: c.commit?.committer?.date || c.commit?.author?.date || null, url: c.html_url };
  }

  // Every file path in the repo at `ref` (one call; GitHub truncates very large trees).
  async tree(owner, name, ref) {
    const { data } = await this.request(`/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { allow404: true });
    return data && Array.isArray(data.tree) ? data.tree.filter((t) => t.type === 'blob').map((t) => ({ path: t.path, size: t.size })) : [];
  }

  // Raw file from raw.githubusercontent.com. Public content only: the token is never sent here.
  // Returns null ONLY when the file does not exist (404). Temporary failures (network,
  // 429, 5xx) are retried, then thrown, so a spec is never silently dropped from the site.
  async rawFile(owner, name, ref, filePath) {
    const url = `https://raw.githubusercontent.com/${owner}/${name}/${encodeURIComponent(ref)}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
    let last = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      let res;
      try {
        res = await fetch(url, { headers: { 'User-Agent': 'docgen' } });
      } catch (e) {
        last = `network error: ${e.message}`;
        continue;
      }
      if (res.ok) return res.text();
      if (res.status === 404) return null;
      last = `HTTP ${res.status}`;
      if (res.status !== 429 && res.status < 500) break; // other 4xx: retrying won't help
    }
    throw new Error(`could not download ${owner}/${name}@${ref}:${filePath} (${last})`);
  }

  async rateLimit() {
    const { data } = await this.request('/rate_limit');
    return data.resources.core;
  }
}

export function isPublic(repo) {
  return repo && repo.private === false && (repo.visibility === undefined || repo.visibility === 'public');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
