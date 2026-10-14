import type { CardRun, Task } from "@npi-deck/protocol";
import { mkdtempSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import { getTask, getState, moveTask } from "./db/tasks.ts";
import { saveCardRun, unfinishedCardRuns, type CardRunOwnership } from "./db/card-runs.ts";
import { cardExecutionProperties } from "./card-properties.ts";
import { cardGit, cleanupCardWorkspace, readonlyCardCommand, snapshotCardAgentState, validateLinkedWorktree } from "./card-workspace.ts";
import { spawnOwned, terminateOwned } from "./owned-process.ts";
import { sdk, activeBackend } from "./backend/runtime.ts";
import { getDeckModelRegistry } from "./auth-singleton.ts";
import { DEFAULT_MODEL_CANDIDATES, firstAuthenticatedModel } from "./deck-model-defaults.ts";
import { AgentJsonStream } from "./routines/steps/agent.ts";
import { resolveBunExecutable } from "./runtime-bun.ts";
import { broadcastBus } from "./broadcast-bus.ts";
import { workRegistry } from "./work-registry.ts";

const WORKER_URL = new URL(import.meta.url.endsWith(".ts") ? "./card-agent-worker.ts" : "./card-agent-worker.js", import.meta.url);

interface Assignment {
	run: CardRun;
	task: Task;
	properties: ReturnType<typeof cardExecutionProperties>;
	ownership: CardRunOwnership;
	controller: AbortController;
	release: () => void;
	token: string;
	completion?: Promise<void>;
	completedByMove?: boolean;
}

export class CardAgentRunner {
	private readonly assignments = new Map<string, Assignment>();
	private readonly queue: Assignment[] = [];
	private active = 0;
	private closing = false;
	private readonly unsubscribe: () => void;
	private kbEndpoint?: string;
	constructor(private readonly config: Config) {
		this.checkLimit();
		this.unsubscribe = broadcastBus.subscribe(frame => {
			if (frame.type !== "tasks_changed") return;
			for (const assignment of this.assignments.values()) {
				const task = getTask(assignment.run.taskId);
				if (!task || task.archivedAt) void this.cancel(assignment.run.taskId);
				else if (assignment.run.status === "running" && task.stateId === this.doneState()) {
					assignment.completedByMove = true;
					assignment.controller.abort();
				}
			}
		});
	}
	setApiOrigin(origin: string): void { this.kbEndpoint = `${origin}/api/kb/agent`; }
	private doneState(): string { return this.config.cardAgentDoneState ?? "s_done"; }
	private checkLimit(): number {
		const limit = this.config.cardAgentConcurrency ?? 12;
		if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("cardAgentConcurrency must be a positive safe integer");
		return limit;
	}
	capacityChanged(): void { this.checkLimit(); this.drain(); }
	resolveToken(token: string): { agentId: string; projectCwd: string | null; readOnly: boolean } | undefined {
		for (const entry of this.assignments.values()) {
			if (entry.run.status === "running" && !entry.controller.signal.aborted && entry.token === token) {
				return { agentId: entry.run.id, projectCwd: entry.task.cwd ?? null, readOnly: entry.properties.readOnly };
			}
		}
		return undefined;
	}
	/** Recover owned artifacts, but never replay a possibly already-executed card after a crash. */
	async recover(): Promise<void> {
		for (const entry of unfinishedCardRuns()) {
			const interrupted = entry.run.status === "queued" || entry.run.status === "running";
			let error = interrupted ? "Card run interrupted by server shutdown" : entry.run.error;
			let ownership = entry.ownership;
			try { await cleanupCardWorkspace(ownership); ownership = {}; }
			catch (cleanupError) { error = `${error ?? ""}; cleanup failed: ${String(cleanupError)}`; }
			saveCardRun({
				...entry.run, ...(interrupted ? { status: "cancelled" as const, finishedAt: new Date().toISOString(), outcome: "Interrupted" } : {}), ...(error ? { error } : {}),
			}, ownership);
		}
	}
	assign(taskId: string): CardRun {
		if (this.closing) throw new Error("Card runner is shutting down");
		const current = this.assignments.get(taskId);
		if (current) return { ...current.run };
		const task = getTask(taskId);
		if (!task) throw new Error("Task not found");
		if (task.archivedAt) throw new Error("Cannot assign an archived card");
		const properties = cardExecutionProperties(task.body);
		for (const state of [this.config.cardAgentActiveState ?? "s_active", this.doneState(), this.config.cardAgentFailureState ?? "s_blocked"]) {
			if (!getState(state)) throw new Error(`Card agent column is not configured: ${state}`);
		}
		const run: CardRun = {
			id: `card-${crypto.randomUUID()}`, taskId, status: "queued", assignedAt: new Date().toISOString(), ownedWorktree: !properties.worktree,
			model: properties.model ?? (properties.role ? undefined : this.config.cardAgentModel),
			role: properties.role ?? (properties.model ? undefined : this.config.cardAgentRole),
		};
		const release = workRegistry.admit("card", run.id);
		const assignment: Assignment = { run, task, properties, ownership: {}, controller: new AbortController(), token: crypto.randomUUID(), release };
		try { saveCardRun(run); }
		catch (error) { release(); throw error; }
		this.assignments.set(taskId, assignment);
		this.queue.push(assignment);
		queueMicrotask(() => this.drain());
		return { ...run };
	}
	private drain(): void {
		if (this.closing) return;
		while (this.active < this.checkLimit() && this.queue.length) {
			const assignment = this.queue.shift()!;
			if (assignment.controller.signal.aborted) continue;
			this.active++;
			assignment.completion = Promise.resolve().then(() => this.execute(assignment)).finally(() => {
				this.active--;
				this.assignments.delete(assignment.run.taskId);
				assignment.release();
				this.drain();
			});
		}
	}
	async cancel(taskId: string): Promise<CardRun | undefined> {
		const assignment = this.assignments.get(taskId);
		if (!assignment) return getTask(taskId)?.run;
		assignment.controller.abort();
		if (assignment.completion) await assignment.completion;
		else {
			const index = this.queue.indexOf(assignment);
			if (index >= 0) this.queue.splice(index, 1);
			assignment.run = { ...assignment.run, status: "cancelled", finishedAt: new Date().toISOString(), outcome: "Cancelled before execution" };
			this.assignments.delete(taskId);
			assignment.release();
			saveCardRun(assignment.run);
		}
		return { ...assignment.run };
	}
	closeAdmissions(): void { this.closing = true; }
	async dispose(): Promise<void> {
		this.closeAdmissions();
		this.unsubscribe();
		await Promise.all([...this.assignments.keys()].map(taskId => this.cancel(taskId)));
	}
	private async execute(assignment: Assignment): Promise<void> {
		const { task, properties, controller } = assignment;
		const signal = controller.signal;
		let run = assignment.run;
		let status: CardRun["status"] = "failed";
		let outcome: string | undefined;
		let error: string | undefined;
		try {
			if (!activeBackend()) throw new Error("No NeoPi backend configured");
			moveTask(task.id, this.config.cardAgentActiveState ?? "s_active", 0);
			run.status = "running";
			run.startedAt = new Date().toISOString();
			const runtime = mkdtempSync(path.join(os.tmpdir(), "npi-deck-card-runtime-"));
			assignment.ownership.runtimePath = runtime;
			saveCardRun(run, assignment.ownership);
			let cwd: string;
			if (properties.worktree) cwd = await validateLinkedWorktree(properties.worktree, signal);
			else {
				const source = task.cwd ?? this.config.defaultCwd;
				const repository = await cardGit(source, ["rev-parse", "--show-toplevel"], signal);
				const parent = mkdtempSync(path.join(os.tmpdir(), "npi-deck-card-worktree-"));
				cwd = path.join(parent, "worktree");
				assignment.ownership.repository = repository;
				assignment.ownership.ownedWorktreePath = cwd;
				// Reserved by this run, durably recorded before git touches the path.
				run.cwd = cwd;
				saveCardRun(run, assignment.ownership);
				await cardGit(repository, ["worktree", "add", "--detach", cwd, "HEAD"], signal);
			}
			run.cwd = cwd;
			const home = path.join(runtime, "home");
			mkdirSync(home, { recursive: true, mode: 0o700 });
			const agentDir = properties.readOnly ? path.join(runtime, "agent") : sdk().getAgentDir();
			if (properties.readOnly) snapshotCardAgentState(sdk().getAgentDir(), agentDir);
			if (!run.model && !run.role) {
				const model = firstAuthenticatedModel(await getDeckModelRegistry(), DEFAULT_MODEL_CANDIDATES);
				if (!model) throw new Error("No deck default Opus 5.5 model credentials configured; configure a card model or role");
				run.model = `${model.provider}/${model.id}:medium`;
			}
			if (signal.aborted) throw new Error("cancelled");
			saveCardRun(run, assignment.ownership);
			const prompt = `# T-${task.displayId}: ${task.title}\n\n${task.body}\n\nWork this card to completion and report the outcome. ${properties.readOnly ? "This is a mechanically read-only research run; file mutation and code execution tools are unavailable." : "Work only in this card worktree."} Knowledge is available through kb_read only when explicitly requested, never as automatic context.`;
			const command = [resolveBunExecutable(), fileURLToPath(WORKER_URL)];
			const env = { ...process.env, HOME: home, TMPDIR: runtime, NPI_DECK_BACKEND: activeBackend()!.selection.path, PI_CODING_AGENT_DIR: agentDir,
				XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"), XDG_DATA_HOME: path.join(home, "data"), XDG_STATE_HOME: path.join(home, "state"), XDG_RUNTIME_DIR: path.join(home, "run") };
			for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "NPI_DECK_TOKEN", "NPI_DECK_AUTH_TOKEN", "XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "NPI_DECK_KB_TOKEN"]) delete env[key as keyof typeof env];
			const proc = spawnOwned(properties.readOnly ? readonlyCardCommand(command, cwd, runtime) : command, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" }, { replaceEnv: true });
			const abort = () => { void terminateOwned(proc); };
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			const stream = new AgentJsonStream();
			try {
				proc.stdin.write(JSON.stringify({ id: run.id, cwd, agentDir, prompt, readOnly: properties.readOnly, model: run.model, role: run.role, kbEndpoint: this.kbEndpoint, kbToken: assignment.token }));
				proc.stdin.end();
				let stderr = "";
				const collect = async () => {
					for await (const bytes of proc.stdout) stream.feed(bytes);
					stream.finish();
				};
				const collectError = async () => {
					const decoder = new TextDecoder();
					for await (const bytes of proc.stderr) if (stderr.length < 8192) stderr += decoder.decode(bytes).slice(0, 8192 - stderr.length);
				};
				const [exit] = await Promise.all([proc.exited, collect(), collectError()]);
				const result = stream.result();
				if (assignment.completedByMove) { status = "completed"; outcome = result.answer ?? "Card moved to the configured completion column"; }
				else if (signal.aborted) { status = "cancelled"; outcome = "Cancelled"; }
				else if (exit !== 0 || result.error || result.answer === undefined) throw new Error(result.error ?? `NeoPi worker exit ${exit}: ${stderr}`);
				else { status = "completed"; outcome = result.answer; }
			} finally {
				signal.removeEventListener("abort", abort);
				await terminateOwned(proc, 0);
			}
		} catch (failure) {
			status = signal.aborted ? (assignment.completedByMove ? "completed" : "cancelled") : "failed";
			error = String(failure);
			outcome ??= status === "cancelled" ? "Cancelled" : "Run failed";
		} finally {
			try { await cleanupCardWorkspace(assignment.ownership); assignment.ownership = {}; }
			catch (cleanupError) { status = "failed"; error = `${error ?? ""}; cleanup failed: ${String(cleanupError)}`; }
			run = assignment.run = { ...run, status, finishedAt: new Date().toISOString(), outcome, ...(error ? { error } : {}) };
			const current = getTask(task.id);
			if (current && !current.archivedAt) moveTask(task.id, status === "completed" ? this.doneState() : this.config.cardAgentFailureState ?? "s_blocked", 0);
			saveCardRun(run, assignment.ownership);
		}
	}
}
