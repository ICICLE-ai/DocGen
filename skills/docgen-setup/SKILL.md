---
name: docgen-setup
description: Start here. Creates a new DocGen documentation hub, or reconfigures an existing one. If the current folder is not a DocGen project, it first checks git and Node.js 22+ (no Python), then downloads the DocGen template into a new folder or GitHub repo. It then installs dependencies and interviews the user: what to document (personal account, orgs, both, or hand-picked public repos, chosen from a live list), hub name, banner text, footer, logo, favicon, colour, releases and APIs. Writes docgen.config.json and runs the preflight doctor, then hands over to docgen-build. Use when someone says "create a docs site/hub", "set up docgen", "make docs for <user/org/repo>", or wants to change which repos are documented or the branding.
---

# DocGen — setup

Goal: leave the user with a DocGen project, a valid `docgen.config.json`, their branding
in place, and `npm run doctor -- --online` reporting **Ready**. Then hand over to
`docgen-build`.

DocGen template repository: **https://github.com/ICICLE-ai/DocGen**

## 0. Where am I?

A DocGen project is a folder containing `docgen.config.json`, `scripts/ingest.mjs` and
`AGENTS.md`.

- **Inside one** (or a parent folder is one): `cd` to its root and skip to step 2.
- **Not inside one** (the skills were installed with `npx skills add …` and the user is in an
  empty or unrelated folder): do step 1, then step 1b to create the project.

## 1. Preflight — check the toolchain before anything else

Run these three commands and read the versions:

```bash
git --version
node --version
npm --version
```

| Tool | Needed | If missing or too old |
|------|--------|------------------------|
| git | any recent | macOS: `xcode-select --install` · Windows: `winget install Git.Git` · Linux: distro package (`apt install git`) |
| Node.js | **22 or newer** (22 or 24 LTS, see `.nvmrc`) | `nvm install 22 && nvm use` (or fnm/volta) · macOS: `brew install node@22` · Windows: `winget install OpenJS.NodeJS.LTS` · https://nodejs.org |
| npm | ships with Node | reinstall Node |
| Python | **not needed** | do not install it for this project |

Installing system software is the user's call: show the command, explain it, and
run it only after they agree. Stop if Node is still below 22: DocGen requires a supported LTS line, and Node 20
reached end of life in April 2026.

## 1b. Create the project from the template (only when not inside one)

Ask two things:
1. **Folder / repo name** [`my-docs`]. Naming the repo `<username>.github.io` serves the
   site at `https://<username>.github.io/`; any other name serves at
   `https://<username>.github.io/<name>/`.
2. **Create the GitHub repo now, or only a local folder?** [local folder; the GitHub repo
   can be created later with `docgen-deploy`].

Then, depending on the answer and on whether the GitHub CLI is installed and logged in
(`gh auth status`):

```bash
# A) GitHub repo + local clone in one step (needs gh). Ask before running: it creates a public repo.
gh repo create <name> --template ICICLE-ai/DocGen --public --clone
cd <name>

# B) Local folder only (works everywhere)
git clone --depth 1 https://github.com/ICICLE-ai/DocGen.git <name>
cd <name>
rm -rf .git && git init -b main          # Windows PowerShell: Remove-Item -Recurse -Force .git
```

Never clone into a non-empty folder or overwrite existing files. If `<name>` exists,
ask for another name. From now on, work in the new folder: it contains `AGENTS.md` and
all DocGen skills under `skills/`.

## 2. Install dependencies

```bash
npm ci          # uses package-lock.json; fall back to `npm install` if there is no lockfile
```

## 3. Decide what to document

Ask these in order. Skip any the user has already answered ("all my repos and
acme's" answers 3a and 3c). Present choices as a short numbered list. Use your tool's
multiple-choice prompt if it has one, otherwise plain text.

### 3a. Whose repositories?

> Which GitHub repositories should the site cover?
> 1. **My personal account**: repos under github.com/<you>
> 2. **An organization** (or several)
> 3. **Both** my account and one or more organizations
> 4. **Only specific repositories** (from anywhere)

Then ask for the names it needs: their GitHub username and/or the org name(s).
Don't guess a username from git config, an email or the folder name. Confirm it.

### 3b. Show what is there

For options 1–3, list the candidates (no config needed, ~1 API call per 100 repos):

```bash
npm run list -- <username> [<org> ...]
```

Show the user the numbered output (or a summary if it is very long: the count per
owner plus the most recently pushed repos). Forks and archived repos are flagged.
They are skipped by default.

### 3c. All of them, or a selection?

> Do you want to publish:
> 1. **All** public repos listed (forks and archived skipped) *(default)*
> 2. **All except** some: tell me which to leave out
> 3. **Only some**: tell me which (numbers, names, or a pattern like `ml-*`)

Also ask, only if the list contains any: *include forks?* *include archived repos?* [no]

Only **public** repositories can ever be published. Private ones never appear in
the list and are refused if named, even if a token could see them. Say this if the
user mentions a private repo.

### 3d. Map the answers to config

| User's answer | `source` config |
|---------------|-----------------|
| All repos of my account | `"owners": ["<you>"]` |
| All repos of an org | `"owners": ["<org>"]` |
| My account + orgs | `"owners": ["<you>", "<org1>", "<org2>"]` |
| All except a few | `owners` + `"exclude": ["repo-a", "<org>/repo-b", "sandbox-*"]` |
| Only a few (any owners) | `"repos": ["<you>/a", "<org>/b"]`, with no `owners` |
| Only those matching a pattern | `owners` + `"include": ["ml-*"]` |
| Whole org + one repo from elsewhere | `"owners": ["<org>"], "repos": ["<other>/<repo>"]` |
| Forks / archived too | `"includeForks": true` / `"includeArchived": true` |

Rules of thumb:
- When the user picks a few repos by number or name, write them to `repos` as
  `owner/name`. That list is explicit and stable, and new repos won't silently appear.
  Use `owners` (optionally with `include`/`exclude`) when they want new repos to
  show up on their own.
- Patterns without `/` match the repo name in every owner. Use `owner/pattern` to
  target one owner.
- Repos in `repos` are always included, even forks or archived ones.
- If two owners have a repo with the same name, both get published, in folders named
  `<owner>-<name>`. Tell the user.

### 3e. Site details

Ask in one batch, with defaults in brackets:

1. **Site title** (navbar) and one-line **tagline** [derived from the account/org name].
2. **Hub name**: who the hub is for, e.g. "Acme Research Lab". The home page heading reads
   *"Welcome to the Official Documentation Hub for <name>"* [the GitHub display name of the
   single account, or the single repo's title] → `site.name`. A custom heading goes in
   `site.heroTitle`.
3. **Banner text** under the heading → `site.description` [the GitHub org/user description
   or repo description, else the tagline]. Optional wide **banner image** → `branding.banner`
   (~1600×500) [none].
4. **Footer**: copyright holder → `site.copyrightHolder` [hub name]. The year is always
   the build year. Also an optional extra line, e.g. a funding acknowledgement →
   `site.footer`. The footer is centered and also links Documentation, APIs, Tags, GitHub,
   llms.txt and the sitemap.
5. **Logo** and **favicon**: a local file path, an `https://` URL, or none [neutral
   DocGen default]. The favicon falls back to the logo.
6. **Brand colour** as `#rrggbb` [`#2563eb`].
7. **Releases**: one folder per GitHub release (newest 5) [yes]. Prereleases [no].
   A `next` folder built from the default branch [no].
8. **APIs**: repos that contain an `openapi.*` / `swagger.*` (.json/.yaml) file get an
   **APIs** menu entry with a static reference plus an interactive explorer [yes]. The
   explorer loads Redoc from jsDelivr in the visitor's browser (pinned version,
   integrity-checked). Use `content.openapi.explorer: false` for no third-party script.
9. **Where it will live** (just to pick the site repo's name later): a repo named
   `<you>.github.io` serves at `https://<you>.github.io/`; any other name serves at
   `https://<you>.github.io/<repo>/`; an org account works the same way
   (`https://<org>.github.io/…`). Nothing in the config changes.

Do not ask for tokens, and never have one pasted into the chat. None are needed; see step 6.

## 4. Branding

- Local file → copy it into `branding/` (e.g. `branding/logo.svg`,
  `branding/favicon.ico`) and reference it as `"branding/logo.svg"`. Files in
  `branding/` are served from the site root.
- URL → you may reference it directly (`"logo": "https://…"`), but prefer downloading it
  into `branding/` so the site does not depend on a third-party host. Only `https://`.
- Accept `.svg .png .ico .webp .jpg/.jpeg`. A social card must be PNG/JPG (1200×630).
- Never use another organization's logo unless the user says they own it.
- Nothing given → leave the fields empty; the neutral defaults in `site/static/img/` apply.

## 5. Write `docgen.config.json`

Start from `docgen.config.example.json` and keep only what differs from the defaults.
Replace the `YOUR-…` placeholder. Examples:

```json
{ "site": { "title": "Ada's Projects" }, "source": { "owners": ["ada"] } }
```

```json
{ "site": { "title": "Acme Docs" },
  "source": { "owners": ["ada", "acme"], "exclude": ["acme/sandbox-*", "dotfiles"] },
  "branding": { "logo": "branding/logo.svg", "primaryColor": "#0f766e" } }
```

```json
{ "site": { "title": "Selected Tools" }, "source": { "repos": ["ada/widget", "acme/gadget"] } }
```

Before going on, show the user exactly which repos will be built:

```bash
npm run ingest -- --dry-run
```

Adjust `include`/`exclude`/`repos` until the list matches what they want.

Every field is documented in `docgen.schema.json` (editors autocomplete from it).
Leave `site.url` / `site.baseUrl` as `"auto"` for GitHub Pages. CI fills them in,
including custom domains. (Older configs with `mode`/`repo`/`org` still work.)

## 6. Verify

```bash
npm run doctor -- --online
```

Fix every `✖`. A `!` on **GitHub token** is fine for small hubs. Anonymous access allows 60
API requests/hour **per IP address**, and a run costs ≈ 4 requests per repo without
releases, or 1 + 3 per release folder (≈ 16 for a repo with 5+ releases). The doctor's
**Rate limit** line estimates it for this config. Above ~50 requests (≈ 12 plain repos or
3 with releases), or on a shared campus/office network, suggest a token. CI never needs
one.

Token rules (also in AGENTS.md, rule 1):
- If `gh` is logged in, you may run `export GITHUB_TOKEN=$(gh auth token)`; the value never
  appears. Otherwise ask the user to create a fine-grained token (Public repositories,
  read-only, no permissions) and export it **in their own terminal**.
- Never ask for the token in the chat, never print it (`echo`, `env`, `printenv`), never put
  it on a command line, in a file or in the config, and never read `.env` or key files.
- Check with `npm run doctor`, which shows only whether a token is set.

## 7. Hand over

Tell the user what was configured, then continue with the `docgen-build` skill
(ingest → map unclassified sections → build → link check → scan → ask before pushing).
Do not commit or push here.

End with the **run summary** from AGENTS.md ("Run summary"): exact numbers from command
output, and AI usage only if your tool shows it (never estimated).
