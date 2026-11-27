import React, { useMemo, useState } from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import Head from '@docusaurus/Head';
import useBaseUrl from '@docusaurus/useBaseUrl';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import { usePluginData } from '@docusaurus/useGlobalData';
import styles from './index.module.css';

const SECTIONS = { tutorials: 'Tutorials', 'how-to': 'How-to', reference: 'Reference', explanation: 'Explanation' };

function ProjectCard({ repo }) {
  const latest = repo.versions.find((v) => v.latest) || repo.versions[0];
  const href = useBaseUrl(`/${latest.route}`);
  return (
    <article className={styles.card}>
      <div className={styles.cardHead}>
        <Link className={styles.cardTitle} to={href}>
          {repo.title}
        </Link>
        {latest.label && <span className={styles.version}>{latest.label}</span>}
      </div>
      <p className={styles.cardDesc}>{repo.description}</p>
      <div className={styles.sections}>
        {latest.pages
          .filter((p) => p.bucket !== 'overview')
          .map((p) => (
            <Link key={p.bucket} className={styles.section} to={`/${p.route}`}>
              {SECTIONS[p.bucket] || p.label}
            </Link>
          ))}
      </div>
      <div className={styles.meta}>
        {repo.language && <span>{repo.language}</span>}
        {repo.license && <span>{repo.license}</span>}
        {repo.versions.length > 1 && <span>{repo.versions.length} versions</span>}
        {repo.docsUpdatedAt && <span title="Last README change">Updated {repo.docsUpdatedAt.slice(0, 10)}</span>}
        <a href={repo.url} target="_blank" rel="noopener noreferrer">
          GitHub ↗
        </a>
      </div>
    </article>
  );
}

export default function Home() {
  const { siteConfig } = useDocusaurusContext();
  const { repos = [] } = usePluginData('docgen') || {};
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState(null);

  const tags = useMemo(() => {
    const count = new Map();
    for (const r of repos) for (const t of r.tags) count.set(t, (count.get(t) || 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 24);
  }, [repos]);

  const shown = repos.filter((r) => {
    const q = query.trim().toLowerCase();
    const hay = `${r.name} ${r.title} ${r.description} ${r.tags.join(' ')}`.toLowerCase();
    return (!q || hay.includes(q)) && (!tag || r.tags.includes(tag));
  });

  const single = repos.length === 1;
  const { description, heroTitle, heroText, banner, hasApis } = siteConfig.customFields;
  const bannerUrl = useBaseUrl(banner || '/');
  const heroStyle = banner ? { backgroundImage: `linear-gradient(rgba(15,23,42,.65), rgba(15,23,42,.65)), url(${/^https?:/.test(banner) ? banner : bannerUrl})` } : undefined;

  return (
    <Layout title="Home" description={description}>
      <Head>
        <meta property="og:type" content="website" />
      </Head>
      <header className={banner ? `${styles.hero} ${styles.heroBanner}` : styles.hero} style={heroStyle}>
        <div className="container">
          <h1 className={styles.title}>{heroTitle}</h1>
          {heroText && <p className={styles.tagline}>{heroText}</p>}
          <div className={styles.actions}>
            <Link className="button button--primary button--lg" to={single ? `/${repos[0].versions[0].route}` : '/docs'}>
              {single ? 'Read the documentation' : 'Browse the documentation'}
            </Link>
            {hasApis && (
              <Link className="button button--secondary button--lg" to="/apis">
                Explore the APIs
              </Link>
            )}
            <Link className="button button--secondary button--lg" to="/docs/tags">
              Browse by tag
            </Link>
          </div>
        </div>
      </header>
      <main className="container margin-vert--lg">
        {repos.length === 0 ? (
          <p className={styles.empty}>
            No documentation yet. Run <code>npm run ingest</code> to fetch it from GitHub.
          </p>
        ) : (
          <>
            {!single && (
              <div className={styles.filters}>
                <input
                  className={styles.search}
                  type="search"
                  placeholder={`Filter ${repos.length} projects…`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Filter projects"
                />
                <div className={styles.tags}>
                  {tags.map(([t]) => (
                    <button key={t} type="button" className={t === tag ? styles.tagOn : styles.tag} onClick={() => setTag(t === tag ? null : t)}>
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className={styles.grid}>
              {shown.map((r) => (
                <ProjectCard key={r.name} repo={r} />
              ))}
            </div>
            {!shown.length && <p className={styles.empty}>No project matches that filter.</p>}
          </>
        )}
      </main>
    </Layout>
  );
}
