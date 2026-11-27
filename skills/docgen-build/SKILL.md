---
name: docgen-build
description: Build, verify and publish the DocGen documentation hub. Fetches READMEs from the configured public GitHub repos, keeps READMEs that already follow the Diátaxis template as they are, and sends unclassified sections to docgen-map. Builds the Docusaurus site (search, tags, versions, APIs, llms.txt, sitemap, schema.org), checks that no link or page 404s, runs the leak scan, then asks the user whether to push now or test it themselves first. The push is what triggers the GitHub Actions build and deploy. Use when the user asks to build, rebuild, preview, check, refresh, publish or push the docs site, or after docgen-setup.
---

# DocGen — build, check, publish

The local loop. Nothing reaches the live site until the user approves a push.

```
ingest → (map unclassified sections) → build → check links → scan → preview → ask → push
```

Run from the DocGen project root. If there is no `docgen.config.json`, or it still contains
a `YOUR-` placeholder, run `docgen-setup` first. `node_modules/` missing → `npm ci`.

## 1. Ingest

```bash
npm run ingest                       # all configured repos
npm run ingest -- --dry-run          # just list what would be built
npm run ingest -- --only owner/repo  # refresh one or a few repos
```

What it does, so you can explain it:
1. Lists the selected public repos (`source.owners` minus filters, plus `source.repos`).
2. For each repo, uses GitHub **releases** (newest `versions.max`) as version folders, or the
   default branch if there are none. Reads the README **at each release tag**.
3. Cleans it: strips front matter and HTML comments, redacts credential-shaped strings,
   rewrites relative links and images to GitHub URLs pinned to that tag.
4. Splits it into Diátaxis pages:
   - **README already structured** (`# Tutorials`, `# How-To Guides`, `# Reference`,
     `# Explanation`) → used as-is.
   - Otherwise each top-level section is placed by `docgen.mapping.json`, then by heading
     rules, and anything left is **unclassified** (kept on Overview).
5. Finds `openapi.*` / `swagger.*` specs and generates **APIs** pages.
6. Writes `site/docs/`, `site/apis/`, the manifest and the section report
   `site/.docgen/sections.json`.

## 2. Map unclassified sections (only if reported)

If ingest prints *"N repo(s) have unclassified README sections"*, or `npm run sections`
lists any, follow the **`docgen-map`** skill. It classifies them with the Diátaxis
definitions, the user approves, and you re-run `npm run ingest`. If the user prefers
to skip, the sections simply stay on the Overview page. That's fine, and not an error.

## 3. Build

```bash
npm run build        # site/docs + site/apis → site/build (Docusaurus)
```

## 4. Check: no broken links, no 404s

```bash
npm run check                # blocking: internal links, assets, expected pages, 404 page
npm run check -- --external  # also request external links (warnings; slower)
```

- `✖` lines are **blocking**: a visitor would hit a 404. Fix them before going further.
- `!` lines are warnings: an `#anchor` that matches no heading (usually a typo in the
  upstream README), or an external link that failed (often bot protection or a rate
  limit, as with crates.io). List them for the user. Fix them upstream if they're real.

## 5. Leak scan

```bash
npm run scan
```

It must pass. Never weaken `scripts/lib/secrets.mjs` to make it pass. See `docgen-deploy`
§ "If the scan fails".

`npm run site` runs ingest → build → check → scan in one go.

## Fixing failures: fix the cause, not the output

`site/docs/` and `site/apis/` are regenerated on every run, locally and in CI, so **hand
edits there are lost**.

| Problem | Fix |
|---|---|
| Wrong page for a section | `docgen-map` (records it in `docgen.mapping.json`) |
| README barely has headings | `docgen-readme` in that source repo (with the maintainer's OK) |
| `ERROR N repo(s) failed, so nothing was changed` | A fetch failed (network, rate limit). Nothing was overwritten. Re-run; a token helps with rate limits. Never push a site built with `--keep-going` without telling the user which repo is missing |
| README HTML missing on a page | The sanitizer removed unsafe HTML (scripts, iframes, forms, inline SVG, `style`). Expected. Never weaken the sanitizer to bring it back |
| Splitter or link bug | fix `scripts/lib/markdown.mjs`, add a test in `scripts/test/`, run `npm test` |
| Broken link in the upstream README | tell the user which repo/line. Don't push to other people's repos |
| Repo that shouldn't be there | `source.exclude` |
| Rate limit | wait for the reset time in the error, or run `export GITHUB_TOKEN=$(gh auth token)` (never print, paste or write the token; see AGENTS.md rule 1) |

## 6. Preview

```bash
npm run serve        # production build at http://localhost:3000 (search works here)
```

## 7. Report, then ask before pushing

Report in a few lines:
- projects, pages and API references produced (from the ingest summary)
- how many READMEs were already structured, mapped, or left with sections on Overview
- `check` result (blocking / warnings) and `scan` result
- what changed compared with the live site, if known (new repos, new releases, remapped sections)

Then ask:

> Everything builds and checks clean. What next?
> 1. **Push now**: I commit the changes and push. GitHub Actions rebuilds and deploys (~3 min).
> 2. **I'll test first**: preview with `npm run serve`, then push yourself (commands below).
> 3. **Not yet**: leave everything uncommitted.

Only push when the user picks 1. Never push with blocking `check` or `scan` failures.

**What gets committed:** only source files: `docgen.config.json`, `docgen.mapping.json`,
`branding/`, and any engine changes. Generated folders (`site/docs/`, `site/apis/`,
`site/build/`, `site/.docgen/`) are gitignored, because CI regenerates them from the same
config and mapping.

```bash
git status                                   # review: no generated files, no secrets
git add docgen.config.json docgen.mapping.json branding/   # plus engine files you changed
git commit -m "docs: <what changed>"
git push                                     # ← triggers the GitHub Actions build + deploy
```

If nothing is staged but upstream READMEs or releases changed (a pure refresh), there is
nothing to commit. Trigger the deploy with an empty commit, which is the only trigger:

```bash
git commit --allow-empty -m "docs: refresh from upstream" && git push
```

No GitHub remote yet, or GitHub Pages not enabled → use `docgen-deploy` first.

After pushing, point the user to the **Actions** tab. The run repeats ingest → build →
check → scan and then deploys with the same config and committed mapping. It fetches
READMEs fresh, so upstream edits made since your preview are included (usually none).

End with the **run summary** from AGENTS.md ("Run summary"): exact numbers from command
output, and AI usage only if your tool shows it (never estimated).
