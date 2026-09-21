# Domain Docs

This is a single-context repository.

## Before working in the codebase

1. Read root `CONTEXT.md`.
2. Read ADRs under `docs/adr/` that affect the work.
3. Use the glossary's canonical terms and avoid its rejected synonyms.
4. Surface conflicts with an ADR explicitly rather than silently overriding the decision.

Missing domain documentation is not itself an error. Domain-modeling skills create terms and ADRs lazily when decisions are resolved.

## Layout

```text
/
|- CONTEXT.md
|- docs/
|  |- adr/
|  `- agents/
`- src/
```
