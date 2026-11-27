import React, { useEffect, useRef, useState } from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import BrowserOnly from '@docusaurus/BrowserOnly';

// Interactive OpenAPI explorer (Redoc standalone), loaded on demand in the browser.
// Pinned version + Subresource Integrity: the browser refuses the script if the CDN
// copy is ever altered. The spec itself is served from this site (static copy).
const REDOC_SRC = 'https://cdn.jsdelivr.net/npm/redoc@2.5.4/bundles/redoc.standalone.js';
const REDOC_SRI = 'sha384-w447zOpYfw/1Tv/5AK9NfHTlQIqE3RVR6KY62jCyy9zNDgO64cMwGGP1Fj0zJVf5';

let loading = null;
function loadRedoc() {
  if (window.Redoc) return Promise.resolve(window.Redoc);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = REDOC_SRC;
      s.integrity = REDOC_SRI;
      s.crossOrigin = 'anonymous';
      s.referrerPolicy = 'no-referrer';
      s.async = true;
      s.onload = () => resolve(window.Redoc);
      s.onerror = () => {
        loading = null;
        reject(new Error('could not load the explorer script'));
      };
      document.head.appendChild(s);
    });
  }
  return loading;
}

function Explorer({ url, sourceUrl }) {
  const el = useRef(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const primary = getComputedStyle(document.documentElement).getPropertyValue('--ifm-color-primary').trim() || '#2563eb';
    loadRedoc()
      .then((Redoc) => {
        if (cancelled || !el.current) return;
        Redoc.init(
          url,
          {
            scrollYOffset: '.navbar',
            // Specs come from other people's repos: sanitize HTML in descriptions.
            untrustedSpec: true,
            hideHostname: false,
            expandResponses: '200,201',
            theme: { colors: { primary: { main: primary } }, typography: { fontFamily: 'var(--ifm-font-family-base)', code: { fontFamily: 'var(--ifm-font-family-monospace)' } } },
          },
          el.current,
          (err) => err && setError(String(err.message || err)),
        );
      })
      .catch((e) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error) {
    return (
      <div className="alert alert--warning" role="alert">
        The interactive explorer could not be loaded ({error}). Use the static reference page, or open the{' '}
        <a href={url}>specification file</a>
        {sourceUrl ? (
          <>
            {' '}
            (<a href={sourceUrl}>source on GitHub</a>)
          </>
        ) : null}
        .
      </div>
    );
  }
  return <div ref={el} className="docgen-api-explorer" />;
}

export default function ApiExplorer({ specUrl, title, sourceUrl }) {
  const url = useBaseUrl(specUrl);
  return (
    <div>
      <p>
        Interactive reference for <strong>{title}</strong>. <a href={url}>Download the specification</a>.
      </p>
      <BrowserOnly fallback={<p>Loading the API explorer…</p>}>{() => <Explorer url={url} sourceUrl={sourceUrl} />}</BrowserOnly>
    </div>
  );
}
