// DocGen site plugin (no dependencies):
//   - exposes the ingest manifest to React pages (usePluginData('docgen'))
//   - brand colour: derives the Infima palette from one hex colour
//   - schema.org JSON-LD: WebSite + Organization on every page,
//     TechArticle + SoftwareSourceCode + BreadcrumbList on every generated doc page
//   - build/llms.txt, build/llms-full.txt and a .md twin of every doc page (llmstxt.org)
//   - build/robots.txt pointing at the sitemap

import fs from 'node:fs';
import path from 'node:path';

// ------------------------------------------------------------ colour helpers
function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
const hsl = ([h, s, l]) => `hsl(${h.toFixed(1)} ${(s * 100).toFixed(1)}% ${(Math.min(1, Math.max(0, l)) * 100).toFixed(1)}%)`;
function palette(hex, dark) {
  const [h, s, l0] = hexToHsl(hex);
  const l = dark ? Math.max(l0, 0.62) : Math.min(l0, 0.5);
  const shade = (f) => hsl([h, s, f < 0 ? l * (1 + f) : l + (1 - l) * f]);
  return [
    `--ifm-color-primary: ${hsl([h, s, l])};`,
    `--ifm-color-primary-dark: ${shade(-0.1)};`,
    `--ifm-color-primary-darker: ${shade(-0.15)};`,
    `--ifm-color-primary-darkest: ${shade(-0.3)};`,
    `--ifm-color-primary-light: ${shade(0.1)};`,
    `--ifm-color-primary-lighter: ${shade(0.15)};`,
    `--ifm-color-primary-lightest: ${shade(0.3)};`,
  ].join('');
}

// ------------------------------------------------------------ helpers
const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
};
const stripFrontmatter = (t) => t.replace(/^---\n[\s\S]*?\n---\n/, '');
function frontmatterValue(text, key) {
  const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return m[1].trim();
  }
}
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;

function builtHtml(outDir, route) {
  for (const f of [`${route}.html`, path.join(route, 'index.html')]) {
    const p = path.join(outDir, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export default function docgenPlugin(context, options) {
  const { siteDir, siteConfig } = context;
  const site = siteConfig.url.replace(/\/$/, '') + siteConfig.baseUrl;
  const abs = (route) => site + route.split('/').map(encodeURIComponent).join('/');
  const manifestPath = path.join(siteDir, '.docgen', 'manifest.json');

  return {
    name: 'docgen',

    getPathsToWatch() {
      return [manifestPath];
    },

    async loadContent() {
      return readJson(manifestPath, { repos: [] });
    },

    async contentLoaded({ content, actions }) {
      actions.setGlobalData(content);
    },

    injectHtmlTags() {
      const color = options.primaryColor || '#2563eb';
      const logoUrl = /^https?:/.test(options.logo) ? options.logo : site + options.logo;
      return {
        headTags: [
          `<style>:root{${palette(color, false)}}[data-theme='dark']{${palette(color, true)}}</style>`,
          ld({
            '@context': 'https://schema.org',
            '@graph': [
              { '@type': 'WebSite', '@id': `${site}#website`, url: site, name: siteConfig.title, description: options.description, publisher: { '@id': `${site}#org` } },
              { '@type': 'Organization', '@id': `${site}#org`, name: siteConfig.title, url: site, logo: logoUrl, sameAs: [options.sourceUrl] },
            ],
          }),
        ],
      };
    },

    async postBuild({ outDir, content }) {
      const docsDir = path.join(siteDir, 'docs');
      const repos = content.repos || [];
      let ldCount = 0;

      // Per-page JSON-LD + .md twins.
      for (const r of repos) {
        const code = {
          '@type': 'SoftwareSourceCode',
          name: r.title,
          description: r.description,
          codeRepository: r.url,
          url: r.homepage || r.url,
          programmingLanguage: r.language || undefined,
          license: r.license ? `https://spdx.org/licenses/${r.license}.html` : undefined,
          keywords: r.tags.length ? r.tags.join(', ') : undefined,
          dateModified: r.updatedAt || undefined,
        };
        for (const v of r.versions) {
          for (const p of v.pages) {
            const src = path.join(docsDir, p.file);
            if (!fs.existsSync(src)) continue;
            const md = fs.readFileSync(src, 'utf8');
            const title = frontmatterValue(md, 'title') || r.title;
            const crumbs = [
              ['Docs', 'docs'],
              [r.name, v.folder ? `docs/${r.name}` : `docs/${r.name}/overview`],
              ...(v.folder ? [[v.label, v.route]] : []),
              ...(p.bucket !== 'overview' ? [[p.label, p.route]] : []),
            ];
            const graph = {
              '@context': 'https://schema.org',
              '@graph': [
                {
                  '@type': 'TechArticle',
                  headline: title,
                  description: frontmatterValue(md, 'description') || r.description,
                  url: abs(p.route),
                  inLanguage: 'en',
                  isPartOf: { '@id': `${site}#website` },
                  about: { ...code, version: v.label || undefined },
                  articleSection: p.label,
                  dateModified: v.commit?.date || undefined,
                },
                {
                  '@type': 'BreadcrumbList',
                  itemListElement: crumbs.map(([name, route], i) => ({ '@type': 'ListItem', position: i + 1, name, item: abs(route) })),
                },
              ],
            };
            const html = builtHtml(outDir, p.route);
            if (html) {
              const text = fs.readFileSync(html, 'utf8');
              if (!text.includes('"TechArticle"')) {
                fs.writeFileSync(html, text.replace('</head>', `${ld(graph)}</head>`));
                ldCount++;
              }
            }
            const twin = path.join(outDir, `${p.route}.md`);
            fs.mkdirSync(path.dirname(twin), { recursive: true });
            fs.writeFileSync(twin, `# ${title}\n\n${stripFrontmatter(md).trim()}\n`);
          }
        }
      }

      // API reference pages: WebAPI JSON-LD + .md twins.
      const apisDir = path.join(siteDir, 'apis');
      for (const r of repos) {
        for (const a of r.apis || []) {
          const src = path.join(apisDir, a.file);
          if (!fs.existsSync(src)) continue;
          const md = fs.readFileSync(src, 'utf8');
          const html = builtHtml(outDir, a.route);
          if (html) {
            const text = fs.readFileSync(html, 'utf8');
            if (!text.includes('"WebAPI"')) {
              const graph = {
                '@context': 'https://schema.org',
                '@type': 'WebAPI',
                name: a.title,
                description: a.description,
                url: abs(a.route),
                documentation: abs(a.route),
                version: a.apiVersion || undefined,
                provider: { '@id': `${site}#org` },
                isBasedOn: a.sourceUrl,
              };
              fs.writeFileSync(html, text.replace('</head>', `${ld(graph)}</head>`));
              ldCount++;
            }
          }
          const twin = path.join(outDir, `${a.route}.md`);
          fs.mkdirSync(path.dirname(twin), { recursive: true });
          fs.writeFileSync(twin, `# ${frontmatterValue(md, 'title') || a.title}\n\n${stripFrontmatter(md).trim()}\n`);
        }
      }

      // llms.txt — curated index.
      const latestOf = (r) => r.versions.find((v) => v.latest) || r.versions[0];
      const lines = [`# ${siteConfig.title}`, '', `> ${options.description || siteConfig.tagline}`, ''];
      lines.push(
        'Each project has an Overview page and, where available, Tutorials, How-to guides, Reference and Explanation pages (Diátaxis). Every page is also available as Markdown by appending `.md` to its URL.',
        `Full text of the latest docs for every project: ${site}llms-full.txt`,
        '',
        '## Projects',
        '',
      );
      for (const r of repos) {
        const v = latestOf(r);
        lines.push(`- [${r.title}](${abs(`${v.route}.md`)})${v.label ? ` (${v.label})` : ''}: ${r.description}`);
        for (const p of v.pages.filter((x) => x.bucket !== 'overview')) lines.push(`  - [${p.label}](${abs(`${p.route}.md`)})`);
      }
      const apiList = repos.flatMap((r) => (r.apis || []).filter((a) => a.latest || !a.versionFolder).map((a) => ({ r, a })));
      if (apiList.length) {
        lines.push('', '## APIs', '');
        for (const { r, a } of apiList) {
          lines.push(`- [${a.title}](${abs(`${a.route}.md`)})${a.apiVersion ? ` (${a.apiVersion})` : ''}: HTTP API of ${r.title}, ${a.endpoints} endpoint(s). OpenAPI spec: ${site}${a.specUrl.replace(/^\//, '')}`);
        }
      }
      const older = repos.flatMap((r) => r.versions.filter((v) => !v.latest).map((v) => ({ r, v })));
      if (older.length) {
        lines.push('', '## Optional', '');
        for (const { r, v } of older) lines.push(`- [${r.title} ${v.label}](${abs(`${v.route}.md`)}): older release`);
      }
      fs.writeFileSync(path.join(outDir, 'llms.txt'), lines.join('\n') + '\n');

      // llms-full.txt — latest version of every project, all pages.
      const full = [`# ${siteConfig.title}`, '', `> ${options.description || siteConfig.tagline}`, ''];
      for (const r of repos) {
        const v = latestOf(r);
        full.push('', `# ${r.title}${v.label ? ` (${v.label})` : ''}`, '', `Source: ${r.url}`, `Docs: ${abs(v.route)}`, '');
        for (const p of v.pages) {
          const src = path.join(docsDir, p.file);
          if (!fs.existsSync(src)) continue;
          full.push(`## ${p.label}`, '', stripFrontmatter(fs.readFileSync(src, 'utf8')).trim(), '');
        }
      }
      fs.writeFileSync(path.join(outDir, 'llms-full.txt'), full.join('\n') + '\n');

      fs.writeFileSync(path.join(outDir, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${site}sitemap.xml\n`);
      fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
      // For scripts/check.mjs: where the site lives, so links can be resolved.
      fs.mkdirSync(path.join(siteDir, '.docgen'), { recursive: true });
      fs.writeFileSync(path.join(siteDir, '.docgen', 'build-info.json'), JSON.stringify({ url: siteConfig.url, baseUrl: siteConfig.baseUrl, builtAt: new Date().toISOString() }, null, 2) + '\n');
      console.log(`[docgen] ${repos.length} project(s); JSON-LD on ${ldCount} page(s); llms.txt, llms-full.txt, robots.txt written`);
    },
  };
}
