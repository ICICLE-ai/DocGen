---
name: docgen-update
description: Keep a DocGen site current without breaking it. (1) Picks up new commits, new releases, new repos and removed repos in the documented GitHub accounts. It runs `npm run status`, refreshes only what changed, maps any new unclassified sections, rebuilds, checks links, scans and reports the differences, then asks before pushing (the push triggers the redeploy). (2) Changes which repos are documented. (3) Upgrades the DocGen engine itself from the upstream template while preserving the user's config, branding and custom pages. Use when the user says "update the docs", "pull in the latest commits/releases", "a repo changed", "add/remove a repo", "refresh the site", or "update docgen".
---

# DocGen — update

Three kinds of update. Work out which one the user means, and ask if it's unclear.

| User says | Section |
|-----------|---------|
| "update the docs", "new release of X", "pull latest commits", "refresh" | A. Content |
| "add repo Y", "stop publishing Z", "also include my org" | B. Selection |
| "update docgen", "get the latest engine/skills" | C. Engine |

Rules for all three:
- `npm run build`, `npm run check` and `npm run scan` must pass before anything goes live.
- Ask before committing, pushing or triggering a deploy.
- Never hand-edit `site/docs/`. It is regenerated from GitHub every time.

## A. Content: new commits, releases, repos

The live site only changes when someone pushes. Upstream README edits and new releases
show up after the next push. This section brings them in, lets the user preview them,
and then pushes on approval.

1. **What changed upstream?**
   ```bash
   npm run status            # add --json to parse it
   ```
   It compares GitHub with the last build (`site/.docgen/manifest.json`) and lists:
   - `+ new`: repos now selected that were never built
   - `~ changed`: new commits since the last build, plus any new release tags
   - `- removed`: no longer selected, no longer public, or deleted
   It then prints the refresh command. If it says there is no previous build, run
   `npm run ingest` and skip to step 3.

2. **Refresh only what changed** (cheap and fast):
   ```bash
   npm run ingest -- --only owner/repo-a,owner/repo-b
   ```
   If anything was *removed*, run a full `npm run ingest` instead. That is the only way
   a removed repo's folder is deleted.
   A new release automatically gets its own folder, labelled `(latest)`. Older releases
   shift down, and anything beyond `versions.max` drops off.

3. **New sections to classify?** If ingest reports unclassified sections (a README
   changed or a new repo arrived), run the `docgen-map` skill.

4. **Rebuild and check:**
   ```bash
   npm run build && npm run check && npm run scan
   ```
   Fix failures with the `docgen-build` skill.

5. **Report the differences** in plain words. For example: "smart_labeler: new release
   v2.2.0 (now latest), README last changed 2026-11-20; widget: README updated; gadget:
   removed (made private)". Each page shows **Last updated** (the date of the last
   commit to that README) and a "Generated from … commit `abc1234`" line, so the user
   can check them. Offer `npm run serve` to preview.

6. **Ask, then push** (same choices as `docgen-build` § 7: push now, test first, not yet).
   Commit `docgen.mapping.json` if it changed. For a pure refresh, nothing is staged,
   so push an empty commit; the push is the only trigger:
   ```bash
   git commit --allow-empty -m "docs: refresh from upstream" && git push
   ```

## B. Selection: add or remove repos

1. Show the candidates: `npm run list -- <user> [<org> ...]`.
2. Edit `source` in `docgen.config.json` (`owners`, `repos`, `include`, `exclude`).
   The mapping table is in `docgen-setup` § 3d.
3. Confirm: `npm run ingest -- --dry-run`, then `npm run site`.
4. With the user's OK, commit **only** `docgen.config.json` (and `branding/` if it
   changed) and push. The push triggers the deploy.

## C. Engine: upgrade DocGen itself

Upgrade the engine without touching the user's choices.

**User-owned (never overwrite):** `docgen.config.json`, `docgen.mapping.json`, `branding/`,
`site/src/css/custom.css`, any added `site/src/pages/*` other than `index.js`, and any
workflow changes the user made on purpose (ask).
**Engine-owned (safe to update):** `scripts/`, `skills/`, `site/docusaurus.config.mjs`,
`site/sidebars.mjs`, `site/sidebars-apis.mjs`, `site/src/plugins/`, `site/src/components/`, `site/src/pages/index.*`,
`site/static/img/` (defaults), `docgen.schema.json`, `docgen.config.example.json`,
`package.json`, `package-lock.json`, `.nvmrc`, `.github/workflows/deploy.yml`,
`AGENTS.md`, `README.md`.

1. Ask for the upstream DocGen repo URL (the template this site was made from), then:
   ```bash
   git status                                  # must be clean; otherwise ask the user to commit or stash first
   git remote add upstream <docgen-repo-url> 2>/dev/null || true
   git fetch upstream
   git switch -c docgen-upgrade
   ```
2. Show what's new: `git log --oneline HEAD..upstream/main` (or, for a site created with
   "Use this template", which shares no history: `git diff HEAD upstream/main --stat`).
3. Bring in engine files only:
   ```bash
   git checkout upstream/main -- scripts skills site/docusaurus.config.mjs site/sidebars.mjs site/sidebars-apis.mjs \
     site/src/plugins site/src/components site/src/pages/index.js site/src/pages/index.module.css site/static/img \
     docgen.schema.json docgen.config.example.json package.json package-lock.json .nvmrc \
     AGENTS.md README.md .github/workflows/deploy.yml
   ```
   If the user customised one of these (`git diff upstream/main -- <file>` before
   checking it out shows their changes), merge by hand and keep their intent.
4. Check that the config still validates against the new schema. If new options
   appeared, explain them, and change the user's config only if they agree.
5. Verify:
   ```bash
   npm ci && npm test && npm run doctor && npm run site      # site = ingest + build + check + scan
   ```
6. Summarise what changed and ask before committing. Commit on the `docgen-upgrade`
   branch, then with the user's OK merge it into `main` and push. Only pushes to `main`
   deploy, so the branch itself is a safe place to review.

## Report

Always finish with: what changed, build and scan results, whether it is live or waiting
for CI, and the next step.

End with the **run summary** from AGENTS.md ("Run summary"): exact numbers from command
output, and AI usage only if your tool shows it (never estimated).
