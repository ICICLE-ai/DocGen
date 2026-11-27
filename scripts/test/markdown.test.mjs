// node --test scripts/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPages, classify, rewriteRelativeLinks, Slugger, extractTagsLine } from '../lib/markdown.mjs';
import { findSecrets, redactSecrets } from '../lib/secrets.mjs';
import { resolveSiteUrl, parseRepoRef } from '../lib/config.mjs';

const repo = { name: 'demo', full_name: 'acme/demo', html_url: 'https://github.com/acme/demo', description: 'A demo project.', license: { spdx_id: 'MIT' }, language: 'Go', topics: [] };
const content = { diataxis: 'auto', stopAtHeadings: [], tagsFromReadme: true, redactSecrets: true };

test('slugger matches github-slugger', () => {
  const s = new Slugger();
  assert.equal(s.slug('Hello, World!'), 'hello-world');
  assert.equal(s.slug('Hello, World!'), 'hello-world-1');
  assert.equal(s.slug('Über café'), 'über-café');
});

test('relative links and images become absolute, pinned to the ref', () => {
  const out = rewriteRelativeLinks('![x](img/a.png) [doc](docs/guide.md#top) [ext](https://x.org) <img src="./b.svg">\n```\n[keep](raw.md)\n```', {
    raw: 'https://raw.githubusercontent.com/acme/demo/v1',
    blob: 'https://github.com/acme/demo/blob/v1',
    dir: '.',
  });
  assert.match(out, /raw\.githubusercontent\.com\/acme\/demo\/v1\/img\/a\.png/);
  assert.match(out, /github\.com\/acme\/demo\/blob\/v1\/docs\/guide\.md#top/);
  assert.match(out, /\(https:\/\/x\.org\)/);
  assert.match(out, /src="https:\/\/raw\.githubusercontent\.com\/acme\/demo\/v1\/b\.svg"/);
  assert.match(out, /\[keep\]\(raw\.md\)/);
});

test('strict Diátaxis template is split on its section headings', () => {
  const parts = classify('Intro text\n\n---\n\n# Tutorials\n\nStep 1\n\n---\n\n# How-To Guides\n\nDo X\n\n---\n\n# Explanation\n\nWhy', 'auto');
  assert.deepEqual(parts.map((p) => p.bucket), ['overview', 'tutorials', 'how-to', 'explanation']);
  assert.equal(parts[1].text, 'Step 1');
});

test('auto mode classifies ordinary README sections', () => {
  const body = ['Intro.', '## Installation', 'a\nb\nc\nd', '## Usage', 'a\nb\nc\nd', '## Architecture', 'a\nb\nc\nd', '## License', 'MIT'].join('\n\n');
  const parts = classify(body, 'auto');
  assert.deepEqual(parts.map((p) => p.bucket), ['overview', 'tutorials', 'how-to', 'explanation', 'overview']);
});

test('tiny sections stay on the overview', () => {
  const parts = classify('Intro.\n\n## Install\n\nnpm i demo', 'auto');
  assert.deepEqual(parts.map((p) => p.bucket), ['overview', 'overview']);
});

test('anchor links follow their heading to another page', () => {
  const readme = ['# Demo', 'See [install](#installation).', '## Installation', 'a\nb\nc\nd'].join('\n\n');
  const { pages } = buildPages({ readme, readmePath: 'README.md', repo, ref: 'main', content });
  const overview = pages.find((p) => p.bucket === 'overview').body;
  assert.match(overview, /\(\.\/tutorials\.md#installation\)/);
});

test('tags line is extracted and removed', () => {
  const { tags, body } = extractTagsLine('Text\n\n**Tags:** CLI, Rust\n\nMore');
  assert.deepEqual(tags, ['CLI', 'Rust']);
  assert.doesNotMatch(body, /Tags/);
});

test('secrets are redacted, placeholders are not', () => {
  const fake = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const { text, kinds } = redactSecrets(`token ${fake} and ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`);
  assert.equal(kinds.length, 1);
  assert.match(text, /\[REDACTED\]/);
  assert.equal(findSecrets('export GITHUB_TOKEN=<your-token>').length, 0);
});

test('site URL resolution', () => {
  assert.deepEqual(resolveSiteUrl({ url: 'auto', baseUrl: 'auto' }, { GITHUB_REPOSITORY: 'Acme/docs' }), { url: 'https://acme.github.io', baseUrl: '/docs/' });
  assert.deepEqual(resolveSiteUrl({ url: 'auto', baseUrl: 'auto' }, { GITHUB_REPOSITORY: 'acme/acme.github.io' }), { url: 'https://acme.github.io', baseUrl: '/' });
  assert.deepEqual(resolveSiteUrl({ url: 'auto', baseUrl: 'auto' }, { DOCGEN_SITE_URL: 'https://docs.acme.dev/' }), { url: 'https://docs.acme.dev', baseUrl: '/' });
  assert.deepEqual(parseRepoRef('https://github.com/acme/demo.git'), { owner: 'acme', name: 'demo' });
});

test('source: owners + repos, legacy keys folded in, deduped', async () => {
  const { normalizeSource, validate, sourceUrl } = await import('../lib/config.mjs');
  const s = normalizeSource({ mode: 'org', org: 'acme', owners: ['me', 'ACME'], repos: ['x/y'], repo: '' });
  assert.deepEqual(s.owners, ['me', 'acme']);
  assert.deepEqual(s.repos, ['x/y']);
  assert.equal(s.mode, undefined);
  assert.equal(sourceUrl(normalizeSource({ repo: 'x/y' })), 'https://github.com/x/y');
  assert.equal(sourceUrl(s), 'https://github.com/me');
  const base = { versions: { max: 5 }, include: [], exclude: [] };
  const cfg = (source) => ({ source: { ...base, ...normalizeSource(source) }, branding: {}, content: { diataxis: 'auto' } });
  assert.match(validate(cfg({})).join(), /at least one/);
  assert.match(validate(cfg({ owners: ['YOUR-USERNAME-OR-ORG'] })).join(), /placeholder/);
  assert.deepEqual(validate(cfg({ owners: ['me'], repos: ['https://github.com/a/b'] })), []);
});

test('OpenAPI: spec detection, parsing and reference rendering', async () => {
  const { findSpecPaths, parseSpec, renderReference, endpointCount } = await import('../lib/openapi.mjs');
  const tree = [{ path: 'openapi.json' }, { path: 'docs/swagger.yaml' }, { path: 'node_modules/x/openapi.json' }, { path: 'tests/openapi.json' }, { path: 'README.md' }];
  assert.deepEqual(findSpecPaths(tree), ['openapi.json', 'docs/swagger.yaml']);
  assert.equal(parseSpec('{"name":"not a spec"}', 'openapi.json'), null);
  const spec = parseSpec('openapi: 3.0.0\ninfo: {title: Pets, version: "1.0"}\npaths:\n  /pets:\n    get:\n      summary: List | all\n      responses: {"200": {description: ok}}\n', 'openapi.yaml');
  assert.equal(spec.info.title, 'Pets');
  assert.equal(endpointCount(spec), 1);
  const md = renderReference({ spec, sourceUrl: 'https://github.com/a/b/blob/main/openapi.yaml', rawUrl: 'https://raw.githubusercontent.com/a/b/main/openapi.yaml', explorer: './explorer.mdx' });
  assert.match(md, /\| `GET` \| `\/pets` \| List \\\| all \|/);
  assert.match(md, /interactive API explorer\]\(\.\/explorer\.mdx\)/);
});

test('classification precedence: template > mapping > rules > unclassified', () => {
  const body = ['Intro.', '## Installation', 'a\nb\nc\nd', '## Benchmark', 'a\nb\nc\nd', '## Odd heading', 'x', '## Sponsors', 'logos'].join('\n\n');
  const plain = classify(body, 'auto');
  assert.deepEqual(plain.map((p) => [p.heading, p.bucket, p.source]), [
    [null, 'overview', 'intro'],
    ['Installation', 'tutorials', 'rule'],
    ['Benchmark', 'overview', 'default'],
    ['Odd heading', 'overview', 'default'],
    ['Sponsors', 'overview', 'rule'],
  ]);
  // Mapping wins over rules and defaults, is never folded, and "omit" drops the section.
  const mapped = classify(body, 'auto', { benchmark: 'explanation', 'odd heading': 'how-to', sponsors: 'omit', installation: 'reference' });
  assert.deepEqual(mapped.map((p) => [p.heading, p.bucket, p.source]), [
    [null, 'overview', 'intro'],
    ['Installation', 'reference', 'mapping'],
    ['Benchmark', 'explanation', 'mapping'],
    ['Odd heading', 'how-to', 'mapping'],
  ]);
  // Template headings ignore the mapping entirely.
  const tpl = classify('Intro\n\n---\n\n# Tutorials\n\nStep\n\n---\n\n# Explanation\n\nWhy', 'auto', { tutorials: 'reference' });
  assert.deepEqual(tpl.map((p) => p.source), ['intro', 'template', 'template']);
  assert.equal(tpl[1].bucket, 'tutorials');
});

test('overviewOnlyReason explains why a README has no Diátaxis page', async () => {
  const { classify, overviewOnlyReason } = await import('../lib/markdown.mjs');
  const report = (body) => classify(body, 'auto', {}).map((p) => ({ heading: p.heading, category: p.bucket, source: p.source, ...(p.foldedFrom ? { foldedFrom: p.foldedFrom } : {}) }));
  assert.match(overviewOnlyReason(report('Just some text.\n')), /no headings/);
  assert.match(overviewOnlyReason(report('Hi.\n## Zebra facts\nStripes.\n')), /not classified yet \("Zebra facts"\)/);
  assert.match(overviewOnlyReason(report('Hi.\n## Installation\nrun it\n')), /"Installation" matched a Diátaxis category but were too short/);
  assert.match(overviewOnlyReason(report('Hi.\n## License\nMIT\n')), /"License" are about the project itself/);
  const rich = report('Hi.\n## Usage\n' + 'step\n'.repeat(6));
  assert.equal(overviewOnlyReason(rich), null);
});
