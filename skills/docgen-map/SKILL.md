---
name: docgen-map
description: Classify README sections into Diátaxis categories (tutorials, how-to guides, reference, explanation, or overview) when a README does not follow the Diátaxis template, so DocGen splits it into the right pages. Reads the section report from the last ingest, judges each unclassified (or questionable) section by its actual content against the Diátaxis definitions, shows the proposed mapping to the user for approval, and records it in docgen.mapping.json, which is committed so CI applies the same decisions without calling AI. Use after `npm run ingest` reports unclassified sections, when a docs page looks wrongly split, or when the user says "map/classify/organize the README sections".
---

# DocGen — map README sections to Diátaxis

DocGen splits each README in this order of preference:

1. **Template**: the README already uses `# Tutorials`, `# How-To Guides`, `# Reference`,
   `# Explanation`. It is used as-is and there is nothing to map.
2. **Mapping**: `docgen.mapping.json` says where a heading goes. This skill writes it.
3. **Rules**: heading keywords (Installation → Tutorials, Usage → How-to, …).
4. **Unclassified**: nothing matched, so the section stays on Overview. These need a decision.

Your job: decide 2 for the sections that ended up in 4 (and fix 3 where the rules got it
wrong), using judgement about **what the content does for the reader**, not just the
heading. You never rewrite README text. You only choose a category per section.

Run from the DocGen project root. If there is no `docgen.config.json`, run `docgen-setup`.

## 1. Get the report

```bash
npm run ingest                    # if not run since the config or READMEs changed
npm run sections                  # repos with unclassified sections, with a preview of each
npm run sections -- --json        # same, machine-readable (headings, current category, source, preview)
npm run sections -- --repo owner/name   # every section of one repo
```

If it says **"Nothing needs a decision"**, every README is either template-structured or
fully classified. Tell the user and stop, unless they asked you to review a specific repo.

The preview is only the first ~280 characters. When a section is ambiguous, read the full
generated page (`site/docs/<repo>/[<version>/]overview.md`) or the README on GitHub.

## 2. Classify each section with Diátaxis

Diátaxis (by Daniele Procida, [diataxis.fr](https://diataxis.fr/)) says documentation
serves four distinct needs. It plots them on two axes: **action vs. cognition**
(doing vs. knowing) and **acquisition vs. application** (studying vs. working).

| Category | Oriented to | The reader is… | It reads like… | Ask yourself |
|---|---|---|---|---|
| **tutorials** | learning | a newcomer *studying*, acquiring skills | a lesson: "In this tutorial we will…", a guided, safe sequence of steps with a visible result at the end, where the teacher takes responsibility | *Would a beginner follow this start to finish to learn?* |
| **how-to** | a goal or task | a competent user *at work* with a specific problem | directions: "To do X, run…", steps for a real-world goal, may branch, assumes knowledge | *Does this help someone who already knows the basics get a job done?* |
| **reference** | information | someone *at work* who needs facts | austere, accurate, complete descriptions of the machinery: options, flags, API endpoints, config keys, env vars, tables | *Would someone look this up rather than read it through?* |
| **explanation** | understanding | someone *studying*, stepping back | discussion: context, background, design decisions, trade-offs, "why", history, comparisons, theory | *Does this deepen understanding rather than tell you what to do?* |
| **overview** | orientation | anyone landing on the project | what it is, features, demo, badges, status, license, citation, contributing, contact, acknowledgements | *Is this "about the project" rather than about using it?* |
| **omit** | — | nobody reading the docs | sponsor logos, ads, duplicated tables of contents, link lists to translations | *Would the docs be better without it?* Use sparingly, and always ask the user |

Tie-breakers:
- **Installation**: a single `pip install x` belongs on the Overview or with the Tutorial. A
  long, platform-by-platform guide is how-to.
- **Examples**: one worked walkthrough for a beginner is a tutorial. A collection of task
  recipes ("Using X with Y") is how-to.
- **Benchmarks / comparisons / "origin of the name" / alternatives**: explanation, or
  overview when they're short.
- **FAQ**: mostly "how do I…" makes it how-to. Mostly "why does…" makes it explanation.
- **Configuration**: a table of every key is reference. "How to configure X for Y" is how-to.
- A section that mixes categories goes where **most** of it belongs. Suggest
  `docgen-readme` to split it properly upstream.
- When unsure, leave it on **overview**. A slightly long Overview is better than a wrong page.

## 3. Show the proposal and get approval

Present one compact table per repo before writing anything:

```
sharkdp/fd @ v10.5.2
  Heading                              Now        → Proposed     Why
  Integration with other programs      overview   → how-to       recipes for using fd with fzf, rofi, emacs
  Benchmark                            overview   → explanation  performance comparison and method
  Demo                                 overview   → overview     screencast, about the project
```

Ask: *apply all / change some / skip?* Apply only what the user approves.

## 4. Record and apply

```bash
npm run sections -- set owner/name "Heading text=how-to" "Other heading=explanation"
npm run sections -- set "*" "Sponsors=omit"          # applies to every repo
npm run ingest
npm run sections                                       # should now report nothing unclassified
```

`set` validates categories, merges into `docgen.mapping.json` and notes the README commit
the decision was made against. Headings match case-insensitively. Template headings
always win over the mapping.

Then continue with `docgen-build` (build → link check → scan → ask before pushing).
`docgen.mapping.json` must be **committed and pushed** with the rest, because CI reads it
to apply the same decisions. CI never calls AI. (CI fetches READMEs fresh, so an upstream
edit made after your preview shows up too; a renamed heading falls back to the rules.)

## Repos with only an Overview page

`npm run sections` lists them with a reason. Give these extra attention: read the whole
README and look for anything that really is a tutorial, how-to, reference or explanation
(by content, not heading). Propose it like any other section. If nothing qualifies, don't
force it. A README that is only an intro is honest as Overview. In the run summary, give
one line per such repo with the reason in plain words, e.g. "only a short intro and a link
to the project website", or "no headings: suggest docgen-readme in the source repo".

## Finish

End with the **run summary** from AGENTS.md ("Run summary"), including how many sections
you classified in how many repos and how many remain. Report AI usage only if your tool
shows exact figures (never estimated).

## Keeping mappings current

- A renamed heading falls back to the rules (or Overview), so re-run this skill after
  upstream README changes. `npm run sections` shows anything newly unclassified.
- Mappings for headings that no longer exist do no harm. Remove them when tidying.
- For a README that is mostly unclassifiable (few or no headings), mapping can't help.
  Suggest `docgen-readme` in that source repo instead.
