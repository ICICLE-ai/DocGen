// Secret patterns shared by the ingest step (redaction) and scripts/scan.mjs (gate).
// Deliberately specific: each pattern matches a credential *format*, not a keyword,
// so documentation that merely says "set your API_KEY" is not flagged.

export const SECRET_PATTERNS = [
  ['private key block', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g],
  ['AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['Slack webhook', /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['OpenAI/Anthropic-style key', /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{32,}\b/g],
  ['Stripe live key', /\b[rs]k_live_[0-9A-Za-z]{24,}\b/g],
  ['Hugging Face token', /\bhf_[A-Za-z0-9]{34,}\b/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['JSON Web Token', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}\b/g],
  ['password in URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'<>]+:[^\s@/"'<>]{6,}@[^\s"'<>]+/gi],
];

// Documentation examples that look like secrets. Deliberately narrow: a value is only
// exempt when it is a published example, a template placeholder, or obviously fake
// (one or two repeated characters). Substrings such as "example" in a hostname do NOT
// exempt a match: a real password in a URL whose host is db.example.com is still reported.
const KNOWN_EXAMPLES = new Set([
  'AKIAIOSFODNN7EXAMPLE', // AWS documentation
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', // jwt.io
]);
const TEMPLATE = /<[^<>\s]{1,40}>|\$\{[^}]{1,40}\}|\{\{[^}]{1,40}\}\}|%[A-Z_]{2,40}%/;
// URL passwords are exempt only when they are clearly not a value at all: filler (***, xxx)
// or a template variable. Weak words ("password", "admin") can be real credentials.
const PASSWORD_FILLER = /^(?:\*+|x+|X+|\.+|<[^<>]+>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\{\{[^}]+\}\}|%[A-Za-z_]+%)$/;
const lowEntropy = (v) => new Set(v.replace(/[^A-Za-z0-9]/g, '')).size <= 2;

export function isPlaceholder(kind, match) {
  if (KNOWN_EXAMPLES.has(match)) return true;
  if (kind === 'password in URL') {
    const pw = (match.match(/^[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'<>]+:([^\s@/"'<>]+)@/i) || [])[1] || '';
    return PASSWORD_FILLER.test(pw);
  }
  if (TEMPLATE.test(match)) return true;
  // The variable part after the fixed prefix (ghp_, AKIA, sk-, xoxb-, …) is fake filler.
  const body = match.replace(/^(?:github_pat_|gh[pousr]_|AKIA|ASIA|xox[abprs]-|AIza|sk-(?:proj-|ant-[a-z0-9]+-)?|[rs]k_live_|hf_|npm_)/, '');
  return lowEntropy(body);
}

export function findSecrets(text) {
  const hits = [];
  for (const [kind, re] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (isPlaceholder(kind, m[0])) continue;
      hits.push({ kind, index: m.index, match: m[0] });
    }
  }
  return hits;
}

export function redactSecrets(text) {
  const kinds = [];
  let out = text;
  for (const [kind, re] of SECRET_PATTERNS) {
    out = out.replace(re, (m) => {
      if (isPlaceholder(kind, m)) return m;
      kinds.push(kind);
      return '[REDACTED]';
    });
  }
  return { text: out, kinds };
}

export const mask = (s) => (s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`);
