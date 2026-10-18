# Issue tracker: GitHub

Issues and specs live in `PsychedelicShayna/neodeck`. Use `gh` and pass
`--repo PsychedelicShayna/neodeck` on every issue, PR, and label operation:
fork discovery may otherwise resolve to `Shreyans13/omp-deck`.

## Conventions

- Create: `gh issue create --repo PsychedelicShayna/neodeck --title "..." --body-file <path>`.
- Read: `gh issue view <number> --repo PsychedelicShayna/neodeck --comments`, including labels.
- List: `gh issue list --repo PsychedelicShayna/neodeck --state <state> --json number,title,body,labels,comments` with task-specific filters.
- Apply or remove existing labels: `gh issue edit <number> --repo PsychedelicShayna/neodeck --add-label "..."` or `--remove-label "..."`.
- Issues stay open until the fix is promoted to the default branch; label `ready-for-human` after the nightly merge. Close after promotion (`Fixes #<n>`), when verified duplicate, or when the owner ordered it. Explain why in the closing comment. The Issue Funnel's narrower publication authority is defined in `docs/agents/issue-funnel.md`.
- Posting follows workspace policy. Every GitHub comment and PR body, including Codex trigger comments, opens with `> [!NOTE]` and `> <actual Model Name> on behalf of PsychedelicShayna`. Follow `docs/agents/pr-review-bots.md` for scoped review requests.
- Use existing labels only; creating or changing label definitions requires a Captain decision.

## Pull requests as a triage surface

**PRs as a request surface: no.** GitHub shares one number space across issues
and PRs; resolve an ambiguous number before acting.

## Skill meanings

- "Publish to the issue tracker" means create a GitHub issue.
- "Fetch the relevant ticket" means read the issue, comments, and labels.

## Dual taxonomy

House labels and readiness are orthogonal layers, not replacements. Keep both.

| Layer | Labels | Rule |
| --- | --- | --- |
| Type | `bug`, `enhancement`, `documentation`, `question` | At least one appropriate type |
| Effort | `effort: tiny`, `effort: small`, `effort: medium`, `effort: large`, `effort: very large` | Exactly one |
| Priority | `priority: p0` … `priority: p3` | Exactly one once triaged |
| Readiness | `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` | Meanings in `docs/agents/triage-labels.md` |

`entangled` applies only to true alternative clusters: shipping one supersedes
the others. `neopi-upstream` marks a dependency on a NeoPi issue. The publication
contract is `docs/agents/issue-funnel.md`.

### Priority

| Label | Meaning |
| --- | --- |
| `priority: p0` | Blocks current work or handles an active incident |
| `priority: p1` | High value or prerequisite for several issues |
| `priority: p2` | Useful planned work |
| `priority: p3` | Backlog or opportunistic work |

## Effort and legacy sizing migration

Estimate for a competent AI agent with tools and subagents, not a human.
`effort:*` replaces `difficulty:*` and `frame:*` as the house sizing taxonomy.
New titles describe the work without the legacy difficulty-float prefix.

| Legacy agent-time frame | Effort mapping |
| --- | --- |
| `frame: hours` | `effort: tiny` or `effort: small`, according to scope and uncertainty |
| `frame: days` | `effort: medium` |
| `frame: weeks` | `effort: large` |
| `frame: months`, `frame: years` | `effort: very large` |

Difficulty `0.000–0.250` maps to tiny/small according to the frame. For larger
difficulty buckets, use the frame mapping as the starting point and judge
complexity, uncertainty, regression risk, and cross-repo coordination; a
complexity float is not a duration. Large and very-large issues are candidates
for splitting into independently deliverable tickets.

All eight existing difficulty buckets (`0.000-0.125` through `0.875-1.000`)
and all five frame labels remain unchanged in GitHub. Mars relabels open issues
first. Keep their legacy labels during that migration; deleting or editing
label definitions is a later Captain decision, not part of this docs change.

## Upstream requests (NeoPi)

NPI deck consumes NeoPi (`PsychedelicShayna/neopi`) in-process. When the deck
needs a new SDK export, RPC field, memory API, or event shape, the deck lead
files a NeoPi issue and the NeoPi-side agent implements it there.

- That issue is the contract: exact field names, capabilities, types, and events.
- Amend the contract by commenting on the NeoPi issue before merging a change to it.
- The consuming deck issue carries `neopi-upstream` and links the NeoPi issue.
- Unresolved disagreements go to the operator. Cross-project ADRs and product decisions remain owned by their project.

## Wayfinding operations

`/wayfinder` uses an issue labelled `wayfinder:map`, with child issues linked
as native sub-issues (or a task list plus `Part of #<map>` when unavailable).
Children use the existing `wayfinder:research`, `wayfinder:prototype`,
`wayfinder:grilling`, or `wayfinder:task` label in addition to house labels.

Dependencies use GitHub's native issue dependencies: POST
`repos/PsychedelicShayna/neodeck/issues/<child>/dependencies/blocked_by` with
`issue_id=<blocker database id>` (not the issue number or node ID). If native
dependencies are unavailable, use `Blocked by: #<n>` in the body. An issue is
unblocked when all blockers are closed. Claim the first unassigned, unblocked
child in map order with `gh issue edit <n> --repo PsychedelicShayna/neodeck --add-assignee @me`.
Resolve with an answer comment, close only when authorized, and append the
answer link to the map's Decisions-so-far.
