// Docusaurus config driven entirely by ../docgen.config.json (+ the manifest written
// by `npm run ingest`). Edit those, not this file, for title / source / branding.

import fs from 'node:fs';
import { themes as prismThemes } from 'prism-react-renderer';
import rehypeSanitizeReadme from './src/plugins/rehype-sanitize-readme.mjs';
import { loadConfig, resolveSiteUrl, brandAsset, sourceUrl as sourceUrlOf, MANIFEST_PATH, APIS_DIR, GEN_STATIC_DIR } from '../scripts/lib/config.mjs';

const cfg = loadConfig();
if (cfg.errors.length) {
  throw new Error(`docgen.config.json has problems:\n${cfg.errors.map((e) => `  - ${e}`).join('\n')}`);
}
let manifest = { repos: [], owners: [] };
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
} catch {
  /* no ingest yet: the home page explains what to run */
}

const { url, baseUrl } = resolveSiteUrl(cfg.site);
const logo = brandAsset(cfg.branding.logo, 'img/docgen-logo.svg');
const favicon = brandAsset(cfg.branding.favicon, brandAsset(cfg.branding.logo, 'img/favicon.svg'));
const socialCard = brandAsset(cfg.branding.socialCard, 'img/social-card.png');
const banner = brandAsset(cfg.branding.banner, '');
const sourceUrl = sourceUrlOf(cfg.source);
const hasApis = Boolean(manifest.hasApis) && fs.existsSync(APIS_DIR);

// ---- Who the hub is for, and what the header says ---------------------------------
// name: config → the single GitHub owner's display name → the single repo's title → site title
const owners = manifest.owners || [];
const repos = manifest.repos || [];
const singleOwner = cfg.source.owners.length === 1 && !cfg.source.repos.length ? owners[0] : null;
const singleRepo = !cfg.source.owners.length && repos.length === 1 ? repos[0] : null;
const hubName = cfg.site.name || singleOwner?.name || singleRepo?.title || cfg.site.title;
const heroTitle = cfg.site.heroTitle || `Welcome to the Official Documentation Hub for ${hubName}`;
const heroText = cfg.site.description || singleOwner?.description || singleRepo?.description || cfg.site.tagline;
const description = cfg.site.description || cfg.site.tagline || heroText;

// ---- Footer (centered): links + © <build year> <holder> -----------------------------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const year = new Date().getFullYear();
const built = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const copyright = [
  `© ${year} ${esc(cfg.site.copyrightHolder || hubName)}. All rights reserved.`,
  cfg.site.footer ? esc(cfg.site.footer) : null,
  `<span class="footer__meta">Generated from GitHub with DocGen · last built ${built}</span>`,
]
  .filter(Boolean)
  .join('<br/>');

const staticDirectories = ['static', '../branding', ...(fs.existsSync(GEN_STATIC_DIR) ? [GEN_STATIC_DIR] : [])];

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: cfg.site.title,
  tagline: cfg.site.tagline,
  favicon,
  url,
  baseUrl,
  trailingSlash: false,
  onBrokenLinks: 'warn',
  onBrokenAnchors: 'warn',
  markdown: {
    // .md files are parsed as CommonMark, so READMEs with raw `{`, `<`, HTML comments
    // etc. build without MDX escaping. .mdx files (the API explorers) get full MDX.
    format: 'detect',
    mermaid: true,
    hooks: { onBrokenMarkdownLinks: 'warn' },
  },
  // ../branding: user logo/favicon/banner. .docgen/static: copies of OpenAPI specs.
  staticDirectories,
  i18n: { defaultLocale: 'en', locales: ['en'] },
  customFields: { description, sourceUrl, hubName, heroTitle, heroText, banner, hasApis },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          path: 'docs',
          routeBasePath: 'docs',
          sidebarPath: './sidebars.mjs',
          // Repo names like "2048-game" must not lose their leading number.
          numberPrefixParser: false,
          // Dates come from each page's last_update front matter (the source file's
          // last commit), not from this repo's git history.
          showLastUpdateTime: true,
          // README HTML comes from other people's repos: keep only safe documentation HTML.
          rehypePlugins: [rehypeSanitizeReadme],
        },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
        sitemap: {
          changefreq: 'weekly',
          priority: 0.5,
          ignorePatterns: [`${baseUrl}docs/tags/**`, `${baseUrl}apis/tags/**`],
          filename: 'sitemap.xml',
        },
      }),
    ],
  ],

  themes: ['@docusaurus/theme-mermaid'],

  plugins: [
    'docusaurus-lunr-search',
    ['./src/plugins/docgen.mjs', { primaryColor: cfg.branding.primaryColor, logo, description, sourceUrl }],
    // Second docs section for HTTP APIs, only when some repo ships an OpenAPI spec.
    ...(hasApis
      ? [
          [
            '@docusaurus/plugin-content-docs',
            {
              id: 'apis',
              path: 'apis',
              routeBasePath: 'apis',
              sidebarPath: './sidebars-apis.mjs',
              numberPrefixParser: false,
              showLastUpdateTime: true,
              rehypePlugins: [rehypeSanitizeReadme],
            },
          ],
        ]
      : []),
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: socialCard,
      metadata: [
        { name: 'description', content: description },
        { name: 'generator', content: 'docgen' },
      ],
      colorMode: { respectPrefersColorScheme: true },
      docs: { sidebar: { hideable: true, autoCollapseCategories: true } },
      navbar: {
        title: cfg.site.title,
        logo: { alt: `${cfg.site.title} logo`, src: logo },
        items: [
          { type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Documentation' },
          ...(hasApis ? [{ type: 'docSidebar', sidebarId: 'apis', docsPluginId: 'apis', position: 'left', label: 'APIs' }] : []),
          { to: '/docs/tags', label: 'Tags', position: 'left' },
          { href: sourceUrl, label: 'GitHub', position: 'right' },
        ],
      },
      footer: {
        style: 'dark',
        // Simple (untitled) links render as one centered row.
        links: [
          { label: 'Documentation', to: '/docs' },
          ...(hasApis ? [{ label: 'APIs', to: '/apis' }] : []),
          { label: 'Tags', to: '/docs/tags' },
          { label: 'GitHub', href: sourceUrl },
          { label: 'llms.txt', href: `${url}${baseUrl}llms.txt` },
          { label: 'Sitemap', href: `${url}${baseUrl}sitemap.xml` },
        ],
        copyright,
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
        additionalLanguages: ['bash', 'json', 'yaml', 'toml', 'python', 'java', 'go', 'rust', 'docker', 'powershell'],
      },
    }),
};

export default config;
