---
name: docgen-readme
description: Scaffold or restructure a project's README.md into the Diátaxis layout that DocGen turns into separate pages — overview (description, Tags line, license, references, issue reporting) followed by Tutorials, How-To Guides, Reference and Explanation sections separated by `---`. Keeps every fact from the existing README, never invents content, leaves guidance as HTML comments (which DocGen strips before publishing), and never commits or pushes without confirmation. Use when the user wants a README to produce better docs pages, asks to "Diátaxis-ify" or standardize a README, or a repo's docs come out as one long Overview page.
---

# DocGen — Diátaxis README

Runs **inside the source repository** being documented (not the site repo), on its
top-level `README.md`. The template is `templates/README.md` next to this file.

## Why this layout

DocGen splits a README on these exact section headings:

| README heading | Page | Diátaxis question it answers |
|----------------|------|------------------------------|
| everything before the first one | Overview | What is this? |
| `# Tutorials` | Tutorials | Teach me, step by step (learning) |
| `# How-To Guides` | How-to guides | How do I achieve X? (task) |
| `# Reference` | Reference | What exactly are the options/API? (information) |
| `# Explanation` | Explanation | Why does it work this way? (understanding) |

Sections are separated by a line containing only `---`. A `**Tags:** a, b` line under
the description becomes page tags. READMEs without these headings still work (DocGen
classifies ordinary sections by name), but the template gives the author control.

## Steps

1. **Read** the existing `README.md` (and `docs/` if referenced) fully.
2. **Map** each existing section to one bucket using the table above. Typical:
   Installation / Quick start → Tutorials; Usage, Configuration, Deployment,
   Troubleshooting → How-To Guides; CLI flags, API, environment variables, config keys →
   Reference; Architecture, Design, Concepts, FAQ "why" answers → Explanation.
   Badges, description, license, citation, acknowledgements, contact → overview.
3. **Rewrite structure, not substance.** Move sections; adjust heading levels so each
   bucket's sub-sections are `##`/`###`; keep code blocks, links and wording. Do not
   invent commands, flags, versions or claims. Where a bucket has no material, leave
   its heading plus the template's HTML-comment guidance — comments are stripped by
   DocGen, so placeholders never reach the published site. Omit a bucket entirely
   if the user prefers.
4. **Tags.** Ask the user for 1–5 tags if none exist; suggest some from the repo topics.
   Do not invent a controlled vocabulary.
5. **License.** Keep or add a license line that matches the repo's `LICENSE` file.
   Never change the license itself.
6. **Relative links** are fine — DocGen rewrites them to absolute GitHub URLs pinned to
   each release. Keep in-README `#anchor` links; DocGen re-points them across pages.
7. **Show the diff** and explain what moved where. Commit/push **only** after an
   explicit yes, on a branch, and prefer a pull request if the repo has collaborators.

## Finish

End with a short summary: sections moved, sections added, anything left for the user, and
AI usage only if your tool shows exact figures (never estimated); otherwise name the
command where the user can check it (see AGENTS.md, "Run summary").

## Do not

- Delete content the user did not ask to delete (move it instead).
- Add secrets, internal hostnames or personal emails (DocGen redacts credential
  patterns, but do not rely on that).
- Touch files other than `README.md` unless asked.
