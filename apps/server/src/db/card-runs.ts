import type { CardRun } from "@npi-deck/protocol";
import { afterCommit, getDb } from "./index.ts";
import { broadcastBus } from "../broadcast-bus.ts";

export interface CardRunOwnership { repository?: string; ownedWorktreePath?: string; runtimePath?: string }
function notify(): void { broadcastBus.broadcast({ type: "tasks_changed" }); }
export function saveCardRun(run: CardRun, ownership?: CardRunOwnership): void {
	getDb().query("INSERT INTO card_runs (id, task_id, payload, repository, owned_worktree_path, runtime_path) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, repository=CASE WHEN ? THEN excluded.repository ELSE card_runs.repository END, owned_worktree_path=CASE WHEN ? THEN excluded.owned_worktree_path ELSE card_runs.owned_worktree_path END, runtime_path=CASE WHEN ? THEN excluded.runtime_path ELSE card_runs.runtime_path END")
		.run(run.id, run.taskId, JSON.stringify(run), ownership?.repository ?? null, ownership?.ownedWorktreePath ?? null, ownership?.runtimePath ?? null, ownership === undefined ? 0 : 1, ownership === undefined ? 0 : 1, ownership === undefined ? 0 : 1);
	afterCommit(notify);
}
export function latestCardRun(taskId: string): CardRun | undefined {
	const row = getDb().query<{ payload: string }, [string]>("SELECT payload FROM card_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1").get(taskId);
	return row ? JSON.parse(row.payload) as CardRun : undefined;
}
export function unfinishedCardRuns(): Array<{ run: CardRun; ownership: CardRunOwnership }> {
	return getDb().query<{ payload: string; repository: string | null; owned_worktree_path: string | null; runtime_path: string | null }, []>("SELECT payload,repository,owned_worktree_path,runtime_path FROM card_runs ORDER BY rowid").all()
		.map(row => ({ run: JSON.parse(row.payload) as CardRun, ownership: { repository: row.repository ?? undefined, ownedWorktreePath: row.owned_worktree_path ?? undefined, runtimePath: row.runtime_path ?? undefined } }))
		.filter(row => row.run.status === "queued" || row.run.status === "running" || row.ownership.ownedWorktreePath || row.ownership.runtimePath);
}
