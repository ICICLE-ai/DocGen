// Rehype plugin: allowlist sanitizer for README HTML.
//
// DocGen publishes READMEs written by other people, and raw HTML in them reaches the page
// (Docusaurus parses it with rehype-raw before user rehype plugins run). This plugin runs
// right after that step on every docs page and keeps only documentation HTML:
//
//   kept      common text/layout elements (div align, p, img, picture, details, tables, …)
//             with an allowlist of attributes per element
//   unwrapped unknown or form-ish containers (<font>, <form>, <label>, …): tag removed,
//             text kept
//   dropped   active or page-altering content with everything inside it: script, style,
//             iframe, object, embed, base, meta, link, svg, math, form controls, …
//   cleaned   no event handlers, no style attributes, no srcdoc; href/src/poster/cite/srcset
//             only with relative, #, http(s) (and mailto: for links) URLs; class names only
//             from Markdown's own output (code languages, task lists, footnotes)
//
// Nodes produced by Docusaurus' own Markdown plugins (mdxJsx*, mdx* expressions) are kept;
// in .md files raw HTML can never become one of those. Dependency-free on purpose.

const DROP = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript',
  'template', 'base', 'meta', 'link', 'title', 'head', 'svg', 'math', 'portal', 'slot',
  'button', 'select', 'option', 'optgroup', 'textarea', 'output', 'datalist',
  'dialog', 'canvas', 'param', 'track',
]);

const GLOBAL_ATTRS = new Set(['id', 'title', 'lang', 'dir', 'align', 'ariaLabel', 'ariaHidden', 'ariaDescribedBy', 'className']);

// Null prototype: a tag named "constructor" or "__proto__" must not find inherited members.
const ELEMENTS = Object.assign(Object.create(null), {
  a: ['href', 'name', 'target', 'rel', 'dataFootnoteRef', 'dataFootnoteBackref'],
  abbr: [], b: [], bdi: [], bdo: [], blockquote: ['cite'], br: [], caption: [], center: [],
  cite: [], code: [], col: ['span', 'width'], colgroup: ['span', 'width'], dd: [], del: ['cite', 'dateTime'],
  details: ['open'], dfn: [], div: [], dl: [], dt: [], em: [], figcaption: [], figure: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [], hr: [], i: [],
  img: ['src', 'alt', 'width', 'height', 'srcSet', 'sizes', 'loading', 'decoding'],
  ins: ['cite', 'dateTime'], kbd: [], li: ['value'], mark: [], ol: ['start', 'type', 'reversed'],
  p: [], picture: [], pre: [], q: ['cite'], rp: [], rt: [], ruby: [], s: [], samp: [],
  section: ['dataFootnotes'], small: [],
  source: ['src', 'srcSet', 'sizes', 'media', 'type', 'width', 'height'],
  span: [], strike: [], strong: [], sub: [], summary: [], sup: [],
  table: ['width'], tbody: [], td: ['colSpan', 'rowSpan', 'width', 'height', 'vAlign'],
  tfoot: [], th: ['colSpan', 'rowSpan', 'scope', 'width', 'height', 'vAlign'], thead: [],
  time: ['dateTime'], tr: [], tt: [], u: [], ul: [], var: [],
  video: ['src', 'poster', 'controls', 'muted', 'loop', 'playsInline', 'width', 'height', 'preload'],
  audio: ['src', 'controls', 'muted', 'loop', 'preload'],
  wbr: [],
});

// Markdown's own class names (remark-gfm, code fences, footnotes). Anything else could reuse
// theme classes (e.g. fixed-position navbar styles) to overlay the page.
const SAFE_CLASS = /^(?:language-[\w+#.-]+|task-list-item|contains-task-list|footnotes|sr-only|data-footnote-backref)$/;
const URL_ATTRS = new Set(['href', 'src', 'poster', 'cite']);

function safeUrl(value, attr) {
  // Browsers ignore control characters and whitespace inside a scheme ("java\tscript:").
  const v = String(value).replace(/[\u0000- \u007f-\u009f]/g, '');
  const m = v.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!m) return true; // relative path, #anchor or //host (inherits https)
  const scheme = m[1].toLowerCase();
  return scheme === 'http' || scheme === 'https' || (attr === 'href' && scheme === 'mailto');
}

const safeSrcSet = (v) => String(v).split(',').every((part) => safeUrl(part.trim().split(/\s+/)[0] || '', 'src'));

function cleanProperties(el) {
  const allowed = Object.hasOwn(ELEMENTS, el.tagName) ? ELEMENTS[el.tagName] : [];
  const out = Object.create(null);
  for (const [key, value] of Object.entries(el.properties || {})) {
    if (key === '__proto__') continue;
    if (!GLOBAL_ATTRS.has(key) && !allowed.includes(key)) continue;
    if (URL_ATTRS.has(key) && !safeUrl(value, key)) continue;
    if (key === 'srcSet' && !safeSrcSet(value)) continue;
    if (key === 'className') {
      const classes = (Array.isArray(value) ? value : String(value).split(/\s+/)).filter((c) => SAFE_CLASS.test(c));
      if (classes.length) out.className = classes;
      continue;
    }
    if (key === 'target') {
      if (value === '_blank') out.target = '_blank';
      continue;
    }
    if (key === 'rel') continue; // re-added below for target=_blank
    out[key] = value;
  }
  if (out.target === '_blank') out.rel = ['noopener', 'noreferrer'];
  el.properties = { ...out };
}

const isMdxNode = (n) => typeof n.type === 'string' && n.type.startsWith('mdx');

function sanitizeChildren(parent) {
  if (!Array.isArray(parent.children)) return;
  const next = [];
  for (const child of parent.children) {
    if (child.type === 'text') next.push(child);
    else if (isMdxNode(child)) {
      sanitizeChildren(child);
      next.push(child);
    } else if (child.type === 'element') {
      const tag = String(child.tagName || '').toLowerCase();
      child.tagName = tag;
      if (DROP.has(tag)) continue;
      if (tag === 'input') {
        // Markdown task lists render as a disabled checkbox; keep only exactly that.
        const p = child.properties || {};
        if (p.type === 'checkbox' && p.disabled !== undefined && p.disabled !== false) {
          child.properties = { type: 'checkbox', disabled: true, checked: Boolean(p.checked) };
          next.push(child);
        }
        continue;
      }
      sanitizeChildren(child);
      if (Object.hasOwn(ELEMENTS, tag)) {
        cleanProperties(child);
        next.push(child);
      } else {
        next.push(...(child.children || [])); // unknown tag: keep its (already clean) content
      }
    }
    // comments, doctypes, raw strings: dropped
  }
  parent.children = next;
}

export function sanitizeTree(tree) {
  sanitizeChildren(tree);
  return tree;
}

export default function rehypeSanitizeReadme() {
  return (tree) => {
    sanitizeTree(tree);
  };
}
