// OpenAPI / Swagger: find spec files in a repo tree, parse them, and render a static
// Markdown reference page (searchable, indexable, readable by LLMs). The interactive
// explorer page is rendered client-side by site/src/components/ApiExplorer.
//
// YAML is parsed with js-yaml, which ships with Docusaurus (declared in package.json).

import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const SPEC_NAME = /(^|\/)(openapi|swagger)([._-][^/]*)?\.(json|ya?ml)$/i;
const IGNORE_DIR = /(^|\/)(node_modules|vendor|\.github|test|tests|__tests__|fixtures?|examples?|samples?|third_party|dist|build)\//i;

// Candidate spec paths from a repo tree, shallowest first.
export function findSpecPaths(tree, max = 3) {
  return tree
    .filter((t) => SPEC_NAME.test(t.path) && !IGNORE_DIR.test(t.path) && (t.size === undefined || t.size < 5 * 1024 * 1024))
    .map((t) => t.path)
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .slice(0, max);
}

// Text -> spec object, or null if it is not an OpenAPI/Swagger document.
export function parseSpec(text, filePath) {
  let doc;
  try {
    doc = /\.json$/i.test(filePath) ? JSON.parse(text) : require('js-yaml').load(text, { json: true });
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || !(doc.openapi || doc.swagger) || !doc.info) return null;
  return doc;
}

export const specSlug = (spec, filePath) =>
  (spec.info?.title || path.posix.basename(filePath).replace(/\.(json|ya?ml)$/i, ''))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'api';

// ------------------------------------------------------------------ rendering

const cell = (v) =>
  String(v ?? '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function resolveRef(spec, obj) {
  let o = obj;
  for (let i = 0; o && o.$ref && i < 5; i++) {
    const parts = o.$ref.replace(/^#\//, '').split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    o = parts.reduce((acc, k) => (acc ? acc[k] : undefined), spec);
  }
  return o || {};
}

function typeOf(spec, schema) {
  if (!schema) return '';
  if (schema.$ref) return schema.$ref.split('/').pop();
  const s = schema;
  if (s.type === 'array') return `${typeOf(spec, s.items) || 'any'}[]`;
  if (s.enum) return `${s.type || 'enum'} (${s.enum.slice(0, 6).join(', ')}${s.enum.length > 6 ? ', …' : ''})`;
  if (s.oneOf || s.anyOf) return (s.oneOf || s.anyOf).map((x) => typeOf(spec, x)).join(' \\| ');
  return [s.type, s.format].filter(Boolean).join(' / ');
}

function operations(spec) {
  const ops = [];
  for (const [p, item] of Object.entries(spec.paths || {})) {
    const shared = item.parameters || [];
    for (const m of METHODS) {
      if (!item[m]) continue;
      ops.push({ path: p, method: m, op: item[m], shared });
    }
  }
  return ops;
}

/**
 * Markdown body for the reference page (no front matter).
 * @param {object} o
 * @param {object} o.spec       parsed spec
 * @param {string} o.sourceUrl  blob URL of the spec in the repo
 * @param {string} o.rawUrl     raw download URL
 * @param {string} o.explorer   relative link to the explorer page, or null
 */
export function renderReference({ spec, sourceUrl, rawUrl, explorer }) {
  const info = spec.info || {};
  const out = [];
  if (info.description) out.push(info.description.trim(), '');

  out.push('| Detail | Value |', '|---|---|');
  if (info.version) out.push(`| Version | \`${cell(info.version)}\` |`);
  out.push(`| Specification | ${spec.openapi ? `OpenAPI ${cell(spec.openapi)}` : `Swagger ${cell(spec.swagger)}`} |`);
  out.push(`| Source | [${cell(path.posix.basename(sourceUrl))}](${sourceUrl}) · [download](${rawUrl}) |`);
  if (info.license?.name) out.push(`| License | ${info.license.url ? `[${cell(info.license.name)}](${info.license.url})` : cell(info.license.name)} |`);
  if (info.contact?.url) out.push(`| Contact | ${info.contact.url} |`);
  out.push('');

  if (explorer) out.push(':::tip Try it', `Open the [interactive API explorer](${explorer}) to browse schemas and request/response examples.`, ':::', '');

  const servers = spec.servers || (spec.host ? [{ url: `${(spec.schemes || ['https'])[0]}://${spec.host}${spec.basePath || ''}` }] : []);
  if (servers.length) {
    out.push('## Servers', '');
    for (const s of servers) out.push(`- \`${s.url}\`${s.description ? ` — ${cell(s.description)}` : ''}`);
    out.push('');
  }

  const schemes = spec.components?.securitySchemes || spec.securityDefinitions || {};
  if (Object.keys(schemes).length) {
    out.push('## Authentication', '', '| Scheme | Type | Details |', '|---|---|---|');
    for (const [name, sch] of Object.entries(schemes)) {
      const details = [sch.scheme, sch.bearerFormat, sch.in && sch.name ? `${sch.name} in ${sch.in}` : '', sch.description].filter(Boolean).join(' · ');
      out.push(`| \`${cell(name)}\` | ${cell(sch.type)} | ${cell(details)} |`);
    }
    out.push('');
  }

  const ops = operations(spec);
  out.push('## Endpoints', '');
  if (!ops.length) out.push('_This specification defines no paths._', '');

  // Summary table, then details grouped by tag.
  if (ops.length) {
    out.push('| Method | Path | Summary |', '|---|---|---|');
    for (const o of ops) out.push(`| \`${o.method.toUpperCase()}\` | \`${cell(o.path)}\` | ${cell(o.op.summary || o.op.operationId || '')} |`);
    out.push('');
  }
  const groups = new Map();
  for (const o of ops) {
    const tag = (o.op.tags && o.op.tags[0]) || 'Other';
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag).push(o);
  }
  const untagged = groups.size === 1 && groups.has('Other');
  const h = untagged ? '###' : '####';
  for (const [tag, list] of groups) {
    if (!untagged) out.push(`### ${tag}`, '');
    for (const { path: p, method, op, shared } of list) {
      out.push(`${h} \`${method.toUpperCase()}\` ${p.replace(/[<>]/g, '')}`, '');
      if (op.deprecated) out.push('> **Deprecated**', '');
      if (op.summary) out.push(`**${cell(op.summary)}**`, '');
      if (op.description) out.push(op.description.trim(), '');
      const params = [...shared, ...(op.parameters || [])].map((x) => resolveRef(spec, x)).filter((x) => x.in !== 'body');
      if (params.length) {
        out.push('| Parameter | In | Type | Required | Description |', '|---|---|---|---|---|');
        for (const pr of params) out.push(`| \`${cell(pr.name)}\` | ${cell(pr.in)} | ${cell(typeOf(spec, pr.schema || pr))} | ${pr.required ? 'yes' : 'no'} | ${cell(pr.description)} |`);
        out.push('');
      }
      const body = op.requestBody ? resolveRef(spec, op.requestBody) : (op.parameters || []).map((x) => resolveRef(spec, x)).find((x) => x.in === 'body');
      if (body) {
        const content = body.content ? Object.entries(body.content).map(([ct, v]) => `\`${ct}\`${v.schema ? ` → ${typeOf(spec, v.schema)}` : ''}`) : [typeOf(spec, body.schema)];
        out.push(`**Request body**${body.required ? ' (required)' : ''}: ${content.join(', ')}${body.description ? ` — ${cell(body.description)}` : ''}`, '');
      }
      const responses = Object.entries(op.responses || {});
      if (responses.length) {
        out.push('| Status | Description | Content |', '|---|---|---|');
        for (const [code, r0] of responses) {
          const r = resolveRef(spec, r0);
          const content = r.content ? Object.entries(r.content).map(([ct, v]) => `\`${ct}\`${v.schema ? ` ${typeOf(spec, v.schema)}` : ''}`).join(', ') : r.schema ? typeOf(spec, r.schema) : '';
          out.push(`| \`${cell(code)}\` | ${cell(r.description)} | ${cell(content)} |`);
        }
        out.push('');
      }
    }
  }

  const schemas = spec.components?.schemas || spec.definitions || {};
  const names = Object.keys(schemas);
  if (names.length) {
    out.push('## Schemas', '');
    for (const n of names.slice(0, 200)) {
      const s = schemas[n] || {};
      out.push(`### ${n}`, '');
      if (s.description) out.push(cell(s.description), '');
      const props = Object.entries(s.properties || {});
      if (props.length) {
        const req = new Set(s.required || []);
        out.push('| Field | Type | Required | Description |', '|---|---|---|---|');
        for (const [k, v] of props) out.push(`| \`${cell(k)}\` | ${cell(typeOf(spec, v))} | ${req.has(k) ? 'yes' : 'no'} | ${cell(v.description)} |`);
        out.push('');
      } else if (s.type || s.enum) out.push(`Type: ${typeOf(spec, s)}`, '');
    }
  }
  return out.join('\n');
}

export const endpointCount = (spec) => operations(spec).length;
