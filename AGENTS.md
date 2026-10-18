# NPI deck

Web cockpit and agent fleet console for NeoPi (`npi`). Repository:
`PsychedelicShayna/neodeck`, fork of `Shreyans13/omp-deck`. The old
`bjb2/omp-deck` no longer exists; changing the local upstream remote awaits
the Captain's answer.

## Workspace policy comes first

Follow the GitHub-tree `AGENTS.md` one directory above this repository (in the
directory containing it) for branches, commits, signing, pull requests, and
merging. Repository-specific values are in `docs/policy/README.md`.

- Default branch: `main`; integration: `nightly`.
- Create topic branches in `../neodeck-wt-<slug>` from freshly fetched `origin/nightly`; PRs target `nightly`. `hotfix/` PRs target `main`, followed by a PR merging `main` back into `nightly`.
- Merge commits only: `Merge PR #<number>: <conventional PR subject> (@<author>)`.
- PR bodies use `.github/PULL_REQUEST_TEMPLATE.md` and the workspace NOTE identity block.
- Contributor PRs are read-only on the owner's machine; see `docs/agents/pr-review-bots.md` › Running PR code.
- Before any review request, finding disposition, or merge, read `docs/agents/pr-review-bots.md`: every PR needs a complete, clean Code Review on its final head and every finding needs an in-thread disposition. Do not request security rounds; fix or disprove security findings already posted.
- Weekly nightly-to-main promotion and release tags are documented in `docs/policy/README.md`.

## Fork maintenance

Before adding fork behavior or integrating upstream, read
`docs/agents/fork-maintenance.md` for placement and compatibility rules.
Before synchronizing a release, follow `docs/agents/upstream-sync.md`.
Repository slug changes do not rename package scopes, environment variables,
installed paths, launchers, or services. See `docs/install.md` for the installed
snapshot served by `npi-deck.service`; keep the live service and display
untouched during verification.

## Agent skills

### Issue tracker

GitHub Issues on `PsychedelicShayna/neodeck`; always target it explicitly because
fork discovery can resolve to the upstream parent. Read
`docs/agents/issue-tracker.md` for issue mechanics, effort sizing, legacy-label
migration, NeoPi dependency contracts, and wayfinding.

### Triage labels

Use the five canonical readiness labels, layered with type, priority, and
`effort:*`. Read `docs/agents/triage-labels.md` when triaging.

### Issue Funnel

Before publishing or amending Captain specifications, read
`docs/agents/issue-funnel.md` for publication ownership and deduplication.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. Read
`docs/agents/domain.md` before domain exploration.

## Sizing work

Whenever assessing effort or duration, estimate for an AI agent, not a human.
Use the house `effort:*` taxonomy; the legacy difficulty/frame mapping and
retention rules live in `docs/agents/issue-tracker.md#effort-and-legacy-sizing-migration`.
