# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `joaquinCastellano350/incident-command-center`. Use the `gh` CLI for all operations.

## Conventions

- Create an issue with `gh issue create --title "..." --body "..."`.
- Read an issue with `gh issue view <number> --comments`, including labels.
- List issues with `gh issue list --state open --json number,title,body,labels,comments` and the appropriate label or state filters.
- Comment with `gh issue comment <number> --body "..."`.
- Apply or remove labels with `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close with `gh issue close <number> --comment "..."`.
- Infer the repository from the Git remote.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Publishing

When a skill says to publish to the issue tracker, create a GitHub issue.

When a skill says to fetch the relevant ticket, use `gh issue view <number> --comments`.

## Wayfinding

The map is one issue labeled `wayfinder:map`. Child tickets use GitHub sub-issues where available and `wayfinder:<type>` labels. Use native issue dependencies for blocking when available, with a `Blocked by: #<n>` fallback. An open, unblocked, unassigned child is on the frontier. Claim work by assigning the issue to the current user; resolve it by posting the answer, closing the issue, and adding its context pointer to the map.
