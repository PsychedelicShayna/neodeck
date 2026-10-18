# Repository policy

Follow the GitHub-tree `AGENTS.md` one directory above this repository (in the
directory containing it) for branches, commits, signing, pull requests, and
merging. This file holds repository-specific values; it adds no policy-file
approval gate.

## Branches

| Role | Branch | Local checkout | Ships as |
| --- | --- | --- | --- |
| Default (promoted) | `main` | Repository checkout | Installed snapshot described in `docs/install.md`, served by `npi-deck.service` |
| Integration | `nightly` | No standing checkout; topic worktrees start from `origin/nightly` | Verification only; does not replace the live snapshot or service |

- Topic branches: from the repository checkout, `git fetch origin && git worktree add ../neodeck-wt-<slug> -b <type>/<slug> origin/nightly`.
- PRs target `nightly`. `hotfix/` PRs target `main`, followed by a PR merging `main` back into `nightly`.
- Upstream is `Shreyans13/omp-deck`, GitHub's fork parent. The old `bjb2/omp-deck` no longer exists. The local `upstream` remote still points there; changing it awaits the Captain's answer. Syncs use `sync/<date>` into `nightly`; see `docs/agents/upstream-sync.md`.
- Repository URLs use `PsychedelicShayna/neodeck`. Package scopes `@npi-deck/*`, `NPI_DECK_*` variables, state and install paths, launcher names, and service names retain their installed-runtime identity until a separate rename issue.

## Merging

- Merge commits only (`gh pr merge --merge`). Subject: `Merge PR #<number>: <conventional PR subject> (@<author>)`.
- The authoring agent merges its own PR into `nightly` once the GitHub-tree policy gates and the final-head Code Review gate in `docs/agents/pr-review-bots.md` pass, unless the assignment reserves merging to another agent or the Captain. Read every existing round and answer every finding in-thread. Do not request security rounds; fix or disprove security findings already posted.
- Contributor heads (any author other than the owner) are never executed on the owner's machine; see `docs/agents/pr-review-bots.md` › Running PR code.

## Promotion

`nightly` is promoted into `main` weekly by `.github/workflows/promote-nightly.yml`:
it opens a `sync/promote-<date>` PR and merges with a merge commit when repository
gates pass. A refused merge leaves the PR open with `ready-for-human` and fails
the run. The owner may run `gh workflow run promote-nightly.yml`.

Scheduled runs and `workflow_dispatch` require the workflow on the default
branch. The Captain performs the first nightly-to-main promotion after this
workflow lands in `nightly`; subsequent runs are available once it reaches `main`.

## Releases

Existing upstream-inherited tags use `vX.Y.Z` (currently `v0.1.0` through
`v0.6.1`). Fork releases, when they start, follow neopi's
`v<upstream>-<fork>.<YYYYMMDD>` pattern. This structure change creates no tags
and does not introduce a fork release or change package versions. Branch
promotion is separate from tagging and does not reinstall the live snapshot.

## Labels

- Type and GitHub defaults: `bug`, `enhancement`, `documentation`, `question`, `duplicate`, `invalid`, `good first issue`, `help wanted`.
- Priority: `priority: p0` … `priority: p3`. Effort: `effort: tiny`, `effort: small`, `effort: medium`, `effort: large`, `effort: very large`.
- Issue triage (`docs/agents/triage-labels.md`): `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
- PR state: `needs-review`, `ready-for-merge`, `review-stalled`.
- Other: `accessibility`, `baseline`, `upstream-sync`, `hotfix`, `entangled`, `neopi-upstream`, `codex-review`, `sentinel-review-requested`.
- Wayfinding: `wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task`.
- Legacy taxonomy: the eight `difficulty:*` buckets and `frame: hours`, `frame: days`, `frame: weeks`, `frame: months`, `frame: years` remain available during migration. `effort:*` replaces their sizing role; the mapping is in `docs/agents/issue-tracker.md`. Mars relabels open issues first; deleting legacy labels is a later Captain decision.

## Where the rest lives

| Topic | File |
| --- | --- |
| Repository conventions and workflow pointers | `AGENTS.md` |
| Installation and runtime configuration | `docs/install.md`, `docs/configuration.md` |
| Fork placement and compatibility checks | `docs/agents/fork-maintenance.md` |
| Upstream sync procedure | `docs/agents/upstream-sync.md` |
| Review-bot mechanics and owner-head safety | `docs/agents/pr-review-bots.md` |
| Issue tracker, funnel, triage labels | `docs/agents/issue-tracker.md`, `docs/agents/issue-funnel.md`, `docs/agents/triage-labels.md` |
| Domain documentation | `docs/agents/domain.md` |
