# AGENTS.md — DocGen

Instructions for any AI coding agent (Codex, Cursor, Copilot, Gemini CLI, Claude Code,
Windsurf, Aider, …) working in this repository. This is the single source of agent
guidance; there are no tool-specific copies.

## What this repo is

**DocGen** turns public GitHub repositories, from a personal account, one or more
organizations, a hand-picked list, or any mix of these, into a
[Diátaxis](https://diataxis.fr/)-structured [Docusaurus](https://docusaurus.io/)
documentation hub. The user builds and checks it locally, approves, and pushes. Each push
to `main` makes GitHub Actions rebuild and deploy it to GitHub Pages.

- One folder per repo (folder name = repo name); one sub-folder per GitHub release.
- READMEs that follow the Diátaxis template are used as-is. Other READMEs are split by
  `docgen.mapping.json` (decisions made with the `docgen-map` skill), then by heading
  rules. Anything still unclassified stays on Overview.
- Pages: Overview / Tutorials / How-to guides / Reference / Explanation, each with
  **Last updated** (last commit to that README) and a link to the source commit.
- OpenAPI/Swagger specs found in repos → **APIs** section (static reference + explorer).
- Home page *"Welcome to the Official Documentation Hub for <name>"*, navbar
  **Documentation** / **APIs**, centered footer with *© <build year> <holder>*.
- Built in: lunr search, tags, sitemap, robots.txt, `llms.txt`, `llms-full.txt`, a `.md` twin
  of every page, schema.org JSON-LD, custom logo/favicon/banner/colour.
- **Toolchain: git + Node.js ≥ 22 (LTS). No Python.** The engine is plain Node.

## Layout

| Path | What it is |
|------|------------|
| `docgen.config.json` | **User-owned.** Source repos, site texts, branding, content options |
| `docgen.mapping.json` | **User-owned, committed.** Where non-template README sections go (written by `docgen-map`) |
| `docgen.schema.json` | JSON Schema for the config (every option documented) |
| `docgen.config.example.json` | Fuller example |
| `branding/` | **User-owned.** Logo / favicon / banner / social card; served from the site root |
| `scripts/ingest.mjs` | GitHub → `site/docs/`, `site/apis/`, manifest, section report |
| `scripts/sections.mjs` | Section report (`npm run sections`) and `set` to record mappings |
| `scripts/check.mjs` | Link check over the build: internal links, assets, pages, anchors, optional external |
| `scripts/list.mjs` | Lists the public repos of users/orgs (to choose what to document) |
| `scripts/status.mjs` | What changed upstream since the last ingest |
| `scripts/doctor.mjs` | Preflight: Node, npm, git, deps, config, optional GitHub reachability |
| `scripts/scan.mjs` | Leak gate over docs, build output, git-tracked files and workflows |
| `site/src/plugins/rehype-sanitize-readme.mjs` | Allowlist sanitizer for README/OpenAPI HTML on every docs page (security-critical; tested in `scripts/test/security.test.mjs`) |
| `scripts/lib/markdown.mjs` | README cleaning, link rewriting, Diátaxis classification, anchor re-pointing |
| `scripts/lib/openapi.mjs` | OpenAPI/Swagger detection, parsing, static reference rendering |
| `scripts/lib/github.mjs` | Minimal GitHub REST client (public repos only) |
| `scripts/lib/secrets.mjs` | Credential patterns (redaction at ingest + scan gate) |
| `scripts/lib/folders.mjs` | Unique, case-insensitive output folders (repos, releases, reserved names) |
| `scripts/lib/staging.mjs` | Swaps staged output into place; restores the previous output on failure |
| `scripts/lib/config.mjs` | Config + mapping loading/validation, site URL resolution, branding paths |
| `scripts/test/` | `node --test` unit tests |
| `site/docusaurus.config.mjs` | Docusaurus config generated from the config file + manifest |
| `site/src/plugins/docgen.mjs` | llms.txt, JSON-LD, robots.txt, `.md` twins, brand palette, build info |
| `site/src/pages/index.js` | Hub home page |
| `site/src/components/ApiExplorer.js` | Interactive OpenAPI explorer (Redoc, pinned + SRI) |
| `site/docs/`, `site/apis/`, `site/.docgen/`, `site/build/` | **Generated**, gitignored, rebuilt locally and in CI |
| `skills/` | Agent skills (see below) |
| `.github/workflows/ci.yml` | Template repo only: `npm test` + sample hub build on PRs; the required `test` check of the `main` ruleset (set in repo settings, see README) |
| `.github/dependabot.yml` | Weekly npm / Actions update PRs (majors ignored) |
| `.github/workflows/deploy.yml` | CI on push to `main` only: gate (skips in the template repo or while the config has the `YOUR-` placeholder) → ingest → build → check → scan → deploy |

## Commands (run from the repo root)

```bash
npm ci                          # install (first run)
npm run doctor [-- --online]    # preflight; fix every ✖
npm run list -- <user> [<org>]  # list an account's public repos (to choose from)
npm run ingest                  # fetch + generate site/docs, site/apis
npm run ingest -- --dry-run     # list repos the config would build
npm run ingest -- --only a,b    # refresh only these repos
npm run sections                # README sections still unclassified (--all, --repo, --json)
npm run sections -- set owner/name "Heading=how-to"   # record a mapping decision
npm run status                  # what changed upstream since the last ingest
npm run build                   # Docusaurus production build → site/build
npm run check [-- --external]   # link check: blocking on 404s, warnings for anchors/external
npm run scan                    # leak gate
npm run site                    # ingest + build + check + scan
npm run serve                   # preview the build (search works here)
npm test                        # engine unit tests
```

"Ready to push" means `npm run site` exits 0, **and the user has said yes**.

## Skills

Plain-Markdown skills in `skills/<name>/SKILL.md` ([Agent Skills](https://agentskills.io)
format). Read the matching file and follow it when the request fits. They can also be
installed into an agent with `npx skills add ICICLE-ai/DocGen` (see README).

| Skill | Use when |
|-------|----------|
| `skills/docgen-setup` | Start here: creates the project from the template if needed, toolchain check, choose repos, hub texts, branding |
| `skills/docgen-build` | Build → check → scan → preview → **ask** → push |
| `skills/docgen-map` | Classify unclassified README sections into Diátaxis categories (records `docgen.mapping.json`) |
| `skills/docgen-update` | Pull in upstream changes, change the selection, or upgrade the engine |
| `skills/docgen-deploy` | First-time GitHub setup: repo, first push, enable Pages, custom domain, security checklist |
| `skills/docgen-readme` | Restructure a *source* repo's README into the Diátaxis template |

Typical flow: setup → build (→ map) → [user approves] → push. Later: update → push.

### Run summary (end of every skill)

When a skill finishes, or stops at "ask before pushing", end your reply with this block.
Leave out lines that don't apply to the task.

```
DocGen run summary · <skill>
- Repos:      <n> documented (<added> added, <removed> removed, <refreshed> refreshed)
- Output:     <pages> pages · <apis> API references · <versions> version folders
- Sections:   <n> classified by AI in <m> repos (docgen-map) · <k> still unclassified
- Overview only: <repo>: <short reason>   (one line per repo; "none" if every repo has a Diátaxis page)
- GitHub API: <calls> calls used, <remaining> left this hour (from the ingest "done:" line)
- Checks:     tests <pass/fail> · links <ok/broken> · leak scan <clean/findings>
- AI usage:   <exact figures from your tool>, or "not visible to the agent: see <command>"
- Files:      <changed files, or "none">
- Pushed:     no, waiting for your approval / yes, <commit> → Actions run
- Next:       <one step>
```

Rules for the summary:
- Take numbers from command output (`ingest`, `check`, `scan`, `npm test`). Never estimate
  or round them.
- **AI usage (tokens, cost):** report it only if your tool shows you exact figures for this
  session. Most agents can't see their own token count. Then don't guess; write "not
  visible to the agent" and name where the user can see it: Claude Code `/cost` (API)
  or `/usage` (plans), Codex CLI `/status`, Gemini CLI `/stats`, Cursor and GitHub
  Copilot in their account's usage page. A made-up number is worse than none.
- The summary must not contain tokens, secrets or environment variable values.
- **Overview only:** list every repo whose README produced no Tutorials, How-to, Reference
  or Explanation page. Start from the reason `npm run sections` prints (no headings, only
  an intro, unclassified sections, sections too short, or only "about the project"
  sections). If you read the README, add a few words on its content in your own words,
  e.g. "a 12-line intro that links to an external docs site". One line per repo.

## Rules

1. **Never leak secrets or private data.**
   - Do not create `.env` files, print environment variables, or write tokens to any
     file. `GITHUB_TOKEN` is optional, read from the shell, sent only to `api.github.com`.
   - **Never read secret files**, not even to debug: `.env*`, `*.pem`, `*.key`, `*.p12`,
     `*.pfx`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc`, `credentials.json`, or credential
     stores such as `~/.config/gh/hosts.yml`. Don't open, `cat`, `grep`, `head`, summarize or
     copy them. DocGen never needs them. If a task seems to, stop and ask the user.
   - **Never print a token's value.** No `echo $GITHUB_TOKEN`, `env`, `printenv`, `set`,
     `gh auth token` on its own, or redirecting it to a file or log. To check whether a token
     is set, run `npm run doctor` (it reports present or absent only).
   - **Never ask for a token in the chat.** If the user pastes one anyway, don't repeat it,
     don't use it, and tell them to revoke it (GitHub → Settings → Developer settings) and
     create a new one, because it is now in the conversation log.
   - **Never put a literal token on a command line, in a script or in a config.** The only
     forms allowed: run `export GITHUB_TOKEN=$(gh auth token)` (the value never appears),
     or ask the user to export it in their own terminal.
   - Do not add `secrets.*` to workflows, `pull_request_target` triggers, or analytics
     that need keys. The scan fails on these.
   - Only public repositories are published. Do not weaken `isPublic()` or the
     visibility filter, and do not weaken `scripts/lib/secrets.mjs` to make a scan pass.
2. **The user controls publishing.** Never commit or push without an explicit yes, and
   never with blocking `check` or `scan` failures. A push to `main` deploys the live site.
   Don't add schedules or other triggers to the workflow unless asked.
3. **AI never runs in CI.** Classification decisions are made locally (`docgen-map`),
   approved by the user and committed in `docgen.mapping.json`. CI only reads them.
4. **Keep untrusted content sanitized.** README and OpenAPI content is written by other
   people. Don't weaken `site/src/plugins/rehype-sanitize-readme.mjs`, remove it from the
   docs plugins, or drop Redoc's `untrustedSpec`. Add allowed HTML only with a test in
   `scripts/test/security.test.mjs`. Don't make ingest errors non-fatal: a failed fetch must
   stop the run (`--keep-going` is for local use only).
5. **Don't hand-edit generated folders** (`site/docs/`, `site/apis/`). Fix the engine
   (with a test), the mapping, the upstream README, or `source.exclude`.
6. **Never invent or rewrite documentation content.** You choose categories; the text
   stays the README author's.
7. **Config over code.** User-facing choices belong in `docgen.config.json` (add a schema
   entry and a default in `scripts/lib/config.mjs` when adding an option).
8. **Keep the engine dependency-free:** Node standard library only in `scripts/`, except
   `js-yaml` (part of Docusaurus) for YAML specs. No Python. If you bump the Redoc version
   in `ApiExplorer.js`, update its SRI hash too.
9. Don't use another organization's logo or name as branding unless the user owns it.
10. Edit narrowly; run `npm test` after engine changes.

## Gotchas

- `.md` docs are parsed as CommonMark (`markdown.format: 'detect'`), so raw READMEs build
  without MDX escaping. Only the generated `explorer.mdx` files use MDX.
- `numberPrefixParser: false`: repo names like `2048-game` keep their number.
- Version folders are sanitized tags; a tag starting with a digit gets a `v` prefix.
- Anonymous GitHub API: 60 requests/hour **per IP** (shared on campus/office networks).
  A run costs ≈ 4 requests per repo without releases, 1 + 3 per release folder otherwise
  (≈ 16 for a repo with 5+ releases). Suggest a token above ~50 requests (≈ 12 plain repos
  or 3 with releases); `npm run doctor -- --online` estimates it. CI uses the built-in
  token (1,000/hour). Locally: `export GITHUB_TOKEN=$(gh auth token)` in the user's shell.
- `"type": "module"` must **not** be set in `package.json` (breaks Docusaurus SSR); ESM
  files use `.mjs`.
- Search (lunr) only works on a production build (`npm run serve`), not `npm start`.
- Mapping keys are top-level README headings (case-insensitive). A renamed heading falls
  back to the rules. `npm run sections` shows it again.
- The template repo (and an unconfigured hub) shows *build*/*deploy* as **skipped**: the
  `gate` job checks `github.event.repository.is_template` and the `YOUR-` placeholder. A
  token never makes private repos publishable: `isPublic()` filters them everywhere.
- `package.json` `overrides` lift `tinypool`, `serialize-javascript` and `uuid` (pinned to
  vulnerable versions by Docusaurus 3.10.2) to fixed releases. When upgrading Docusaurus,
  remove an override once Docusaurus itself depends on a fixed version, then run
  `npm audit`, a full `npm run site` and `npm start`.
- Ingest writes to `site/.docgen/staging/` and swaps it in at the end; never write
  directly into `site/docs/` or `site/apis/` from the writers (use `OUT`).
