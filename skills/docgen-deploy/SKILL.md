---
name: docgen-deploy
description: Publish a DocGen site to GitHub Pages with the bundled GitHub Actions workflow (rebuild + redeploy on every push to main, and only then) and verify nothing private leaks. Walks through creating the GitHub repo, pushing, enabling Pages with the "GitHub Actions" source, custom domains, and the security checklist. Use for the first-time GitHub setup (create the repo, first push, enable Pages), CI questions, or a custom domain. Day-to-day pushes are handled at the end of docgen-build. Always confirm before creating repositories or pushing.
---

# DocGen — deploy

Outward-facing actions (creating a repo, pushing, enabling Pages) need an explicit
"yes" from the user each time. Show the exact commands first.

## 0. Gate

```bash
npm run site     # ingest + build + scan; must exit 0
```

Do not continue on a failure. Run `docgen-build` to fix it.

## 1. Security checklist (all must hold)

- [ ] `npm run scan` passes (docs, build output, every git-tracked file, workflows).
- [ ] `git status --ignored` shows no `.env*`, `*.pem`, `*.key`, `.npmrc`, `.netrc` staged.
- [ ] `docgen.config.json` contains no tokens, emails or internal URLs.
- [ ] `.github/workflows/deploy.yml` uses no `secrets.*` (only the built-in
      `github.token`), has `permissions: contents: read` at the top level, and uses
      `pull_request`, never `pull_request_target`.
- [ ] Source repos are public. (Ingest refuses private repos, and in org mode filters
      on `private: false` and `visibility: public`.)

Why it is safe by design: no analytics or third-party keys; the only credential is
the runner's ephemeral, read-only `GITHUB_TOKEN`, sent only to `api.github.com`,
never written to disk or logs; generated docs are rebuilt from public data on every run;
credential-shaped strings in READMEs are redacted at ingest and the build is scanned
again before upload.

## 2. Put the site in a GitHub repo

If it is not a git repo yet:

```bash
git init -b main
git add .
git commit -m "DocGen docs site"
```

Create an **empty** GitHub repo (`<owner>/<site-repo>`) — with the GitHub CLI if
installed (`gh repo create <owner>/<site-repo> --public --source . --push`), otherwise
in the browser at https://github.com/new, then:

```bash
git remote add origin https://github.com/<owner>/<site-repo>.git
git push -u origin main
```

Name the repo `<owner>.github.io` to serve from `https://<owner>.github.io/`;
any other name serves from `https://<owner>.github.io/<site-repo>/`. `site.url` /
`site.baseUrl` stay `"auto"` either way.

## 3. Enable GitHub Pages

Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
(With `gh`: `gh api -X POST repos/<owner>/<site-repo>/pages -f build_type=workflow`.)

Then push again (an empty commit is fine: `git commit --allow-empty -m "docs: first deploy" && git push`).
Pushing is the only trigger. The deploy job prints the live URL. If the very first run failed
at "Read GitHub Pages URL", it ran before Pages was enabled: use **Re-run all jobs**.

## 4. What triggers a rebuild

The workflow's first job (`gate`) skips build and deploy in the template repository itself and while
`docgen.config.json` still has the `YOUR-` placeholder, so those runs show as *skipped*, not failed.

**Only a push to `main`.** The user stays in control: build and check locally
(`docgen-build`), approve, push, and the workflow runs ingest → build → check → scan →
deploy. There is no schedule, no PR build and no manual trigger.

| You want the site to pick up… | Do |
|---|---|
| config, branding, mapping or engine changes | commit and push them |
| new README edits / releases in source repos | `docgen-update` (or `npm run site`), then `git commit --allow-empty -m "docs: refresh" && git push` |

If the user later asks for automatic refreshes, adding a `schedule:` (cron) or
`workflow_dispatch:` trigger to `.github/workflows/deploy.yml` is a one-line change. Only
do it on request.

## 5. Custom domain (optional)

Settings → Pages → Custom domain, then add the DNS record GitHub shows. No config change
is needed: CI passes the Pages URL to the build (`DOCGEN_SITE_URL`), so canonical
URLs, sitemap, llms.txt and JSON-LD use the custom domain.

## If the scan fails

- Finding in `site/docs` or `site/build`: an upstream README contains a credential the
  redactor did not catch. It is **already public** in that repo — tell the user to have
  it rotated and removed upstream. Meanwhile exclude that repo (`source.exclude`) or
  add the pattern to `scripts/lib/secrets.mjs` (with a test).
- Finding in a tracked file: remove the file/value, and if it was ever committed,
  rotate the credential — history keeps it.
- Workflow finding: restore the stock `deploy.yml` settings.

## Report

Live URL, workflow run status, and the checklist result. Never force-push or rewrite
history without being asked.

End with the **run summary** from AGENTS.md ("Run summary"): exact numbers from command
output, and AI usage only if your tool shows it (never estimated).
