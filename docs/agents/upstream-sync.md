# Synchronizing an upstream release

Upstream is `Shreyans13/omp-deck` (GitHub's fork parent). The old
`bjb2/omp-deck` no longer exists. The existing `upstream` remote still names
it: its replacement awaits the Captain's answer. Do not silently rewrite the
remote. Until that answer, fetch and inspect releases using the explicit
`https://github.com/Shreyans13/omp-deck.git` URL.

Syncs land on `sync/<date>` through a PR into `nightly`, never directly on
`main` or `nightly`. Promotion into `main` is separate
(`docs/policy/README.md` › Promotion). The fetched remote branch is the source
of truth, not a local checkout or another feature worktree.

## 1. Preserve and establish the baseline

Fetch `origin`. Preserve dirty work and local-ahead commits on named local
WIP/topic branches with signed commits; leave unrelated checkouts untouched.
Do not use a stash as durable storage or reset a local default branch.
Validate and merge prerequisite topic PRs before syncing, then fetch again.

Read `docs/agents/fork-maintenance.md`. Pin `origin/nightly`, the selected
upstream release tag and peeled commit, and relevant open PR heads. Select
the newest intended upstream release tag, not an arbitrary branch tip:

```sh
git ls-remote --tags https://github.com/Shreyans13/omp-deck.git 'v*'
```

Inspect tag versions and verify any tag signature. An invalid signature is a
blocker; record an unsigned tag explicitly. Preserve WIP and recovery refs
until integration and isolated smoke proof are complete.

## 2. Create a fresh integration worktree

Fetch the selected tag explicitly from `https://github.com/Shreyans13/omp-deck.git`,
record its exact commit, and create the worktree from freshly fetched
`origin/nightly`:

```sh
git worktree add ../neodeck-wt-sync-<date> -b sync/<date> origin/nightly
```

In that new worktree, create `backup/neodeck-pre-upstream-<date>` at the pinned
fork baseline. Record the source commit, tag commit, recovery ref, and open PR
heads in `docs/updates/<date>-upstream-<tag>.md`.

## 3. Merge and maintain the conflict ledger

Merge the selected tag with `git merge --no-ff --no-commit <tag>`. Resolve
conflicts personally, sequentially, one file at a time; research may be
read-only delegated, but resolution ownership stays with the integrating agent.

For each file, inspect base/ours/theirs and affected owners/tests; retain deck
contracts unless upstream demonstrably replaces the same observable behavior.
Adopt upstream refactors and reseat fork behavior on their new owners. Append
its ledger row before staging:

| Path | Resolution | Fork behavior kept | Upstream change taken | Why |
| --- | --- | --- | --- | --- |

Inspect automatically merged fork integration points too. Preserve the NeoPi
pin/SDK contract, streaming sessions, canvas/card properties, approvals,
bridges, and installed-runtime identity. Treat a NeoPi pin update as an
explicit compatibility change, not an incidental conflict resolution.
For lockfiles, start from upstream and regenerate only after auditing new
dependencies; never execute unaudited installers.

## 4. Commit and verify in isolation

Complete the merge with a signed commit and verify it:

```sh
git commit -S/home/shayna/.ssh/id_ed25519_github_signing_agents.pub -F <message-file>
git verify-commit HEAD
```

Use a Conventional Commit headline of at most 72 characters, prose describing
what/why/verification, and actual executing identity in `Model:` and
`Co-authored-by:` trailers. Post-merge fixes are separate signed logical commits.

Match `.github/workflows/ci.yml`:

```sh
bun install --frozen-lockfile
bun run typecheck && bun test
bun --cwd apps/web run build
```

Run focused verification for conflicted boundaries and exercise changed runtime
behavior using a separate service instance/port and temporary state. Follow
`docs/install.md` for isolated setup; do not touch `~/.npi-deck`, the live
snapshot `~/.local/share/npi-deck`, or the live `npi-deck.service`. Never stop,
restart, reload, or reprovision that service. Do not mutate the live desktop,
windows, workspaces, tmux, desktop entries, or XDG configuration. Auto-open and
other non-browser GUI commands must use `timeout` + `xvfb-run -a <cmd>` with
private HOME/XDG state and no inherited live D-Bus or desktop/session variables.
Direct Chromium/Electron launches must use only
`bun scripts/browser-smoke.ts --home <private-tmp-dir> --timeout <seconds> -- <absolute-browser> --user-data-dir=<private-profile>`.
The wrapper already invokes `timeout` + `xvfb-run -a` with mandatory
`--password-store=basic`; it does not inherit `DBUS_SESSION_BUS_ADDRESS`,
`XDG_CURRENT_DESKTOP`, `XDG_SESSION_DESKTOP`, `DESKTOP_SESSION`, or live display,
Wayland and credential variables. HOME and XDG paths are private. Follow the
invocation and actual-child argv/environment checks in `CONTRIBUTING.md`.
Never use display `:0` or Xephyr. Terminate the entire process tree, including
detached crash handlers and Xvfb, and verify termination with `pgrep` matching
the private profile, debugging port and Xvfb display. If Xvfb cannot perform a
check, report the limitation without a fallback.

Record exact commands, pass/failure evidence, build and smoke results, and
unavailable checks separately in the ledger. A failure is baseline only with
evidence from the unmodified base or upstream tag. Source inspection and tests
alone do not prove the changed runtime path.

## 5. Publish and realign safely

Push `sync/<date>` and open a PR into `nightly` using the PR template and identity
block. Summarize commits/tag, recovery ref, ledger/conflicts, retained or
replaced contracts, audited dependencies, checks/build/smoke proof, and any
baseline defects. Merge with a merge commit only when workspace gates pass and
the assignment authorizes the integrating agent to merge.

After merging, fetch and confirm the intended tree is in `origin/nightly`.
Only fast-forward a clean local integration checkout when its tip is an
ancestor; otherwise preserve local-ahead commits and recovery refs before any
realignment. Do not alter someone else's checkout or discard WIP. Promotion
does not authorize live deployment; the Captain controls the live install.
