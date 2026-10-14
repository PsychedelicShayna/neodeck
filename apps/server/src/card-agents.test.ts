import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Task } from "@npi-deck/protocol";
import { loadBackend, resolveBackendSelection, sdk } from "./backend/runtime.ts";
import { CardAgentRunner } from "./card-agents.ts";
import { cleanupCardWorkspace, readonlyCardCommand } from "./card-workspace.ts";
import { closeDb, openDb } from "./db/index.ts";
import { getTask, listTasks } from "./db/tasks.ts";
import { saveCardRun, unfinishedCardRuns } from "./db/card-runs.ts";
import { buildTasksRouter } from "./routes-tasks.ts";
import type { Config } from "./config.ts";
import { spawnOwned, spawnOwnedSync, terminateOwned } from "./owned-process.ts";
import { KbService } from "./kb-service.ts";
import { buildKbRouter } from "./routes-kb.ts";

const fixtureRoot = process.env.NPI_DECK_CARD_TEST_ROOT;
if (!fixtureRoot) {
 test("card assignment executes a real isolated SDK worker, enforces readonly admission, queues and cleans only owned worktrees", () => {
  const selection = resolveBackendSelection(); if (!selection) throw new Error("card tests require a configured NeoPi backend");
  const root = mkdtempSync(path.join(tmpdir(), "deck-card-agent-test-"));
  try {
   const home = path.join(root, "home"); mkdirSync(home);
   const env: Record<string, string> = {};
   for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/(_API_KEY|_TOKEN|_SECRET)$/.test(key) && !/^(PI_|OMP_|NPI_DECK_|DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|XDG_)/.test(key)) env[key] = value;
   Object.assign(env, { HOME: home, USERPROFILE: home, TMPDIR: root, TMP: root, TEMP: root, PI_CODING_AGENT_DIR: path.join(root, "agent"), NPI_DECK_HOME: path.join(root, "deck"), NPI_DECK_DB_PATH: path.join(root, "deck.db"), NPI_DECK_BACKEND: selection.path, NPI_DECK_CARD_TEST_ROOT: root,
    XDG_CONFIG_HOME: path.join(home, "config"), XDG_CACHE_HOME: path.join(home, "cache"), XDG_DATA_HOME: path.join(home, "data"), XDG_STATE_HOME: path.join(home, "state"), XDG_RUNTIME_DIR: path.join(home, "run") });
   const child = spawnOwnedSync([process.execPath, "test", import.meta.path], { cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 300_000 }, { replaceEnv: true });
   if (child.exitCode !== 0) console.error(`${child.stdout.toString()}${child.stderr.toString()}`);
   expect(child.exitCode).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
 }, 310_000);
} else {
 const project = path.join(fixtureRoot, "project"); const linked = path.join(fixtureRoot, "linked"); const agentDir = process.env.PI_CODING_AGENT_DIR!;
 mkdirSync(project); mkdirSync(agentDir, { recursive: true });
 function git(...args: string[]): string {
  const result = spawnOwnedSync(["git", ...args], { cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { GIT_TERMINAL_PROMPT: "0" } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString()); return result.stdout.toString().trim();
 }
 git("init"); writeFileSync(path.join(project, "source.txt"), "Original fixture source\n"); git("add", "."); git("-c", "user.name=Card Fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"); git("worktree", "add", "--detach", linked, "HEAD");
 const linkedSource = readFileSync(path.join(linked, "source.txt"));
 const requests: Array<Record<string, any>> = []; const denied = new Map<string, string>(); const observedWrites = new Map<string, string>(); let held = false;
 const tokenGates = new Map<string, { reached: boolean; fail: boolean; release: () => void; promise: Promise<void> }>();
 function tokenGate(title: string) {
  let release!: () => void;
  const gate = { reached: false, fail: false, release: () => release(), promise: new Promise<void>(resolve => { release = resolve; }) };
  tokenGates.set(title, gate); return gate;
 }
 const forbiddenNames = ["write", "edit", "bash", "eval", "task", "read", "grep", "glob", "pi_read", "pi_edit", "pi_grep", "kb_write"];
 const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const payload = await request.json() as Record<string, any>; requests.push(payload);
  const prompt = JSON.stringify(payload.messages.find((message: any) => message.role === "user")?.content);
  const results = payload.messages.filter((message: any) => message.role === "tool");
  for (const result of results) denied.set(result.tool_call_id, JSON.stringify(result.content));
  const gate = [...tokenGates.entries()].find(([title]) => prompt.includes(title))?.[1];
  if (gate && results.some((result: any) => result.tool_call_id === "call_kb_read")) {
   gate.reached = true;
   await gate.promise;
   if (gate.fail) return new Response(JSON.stringify({ error: { message: "Intentional lifecycle fixture provider failure", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
  }
  if (results.some((result: any) => result.tool_call_id === "call_write") && prompt.includes("WRITE")) {
   const task = listTasks().find(task => task.run?.status === "running" && prompt.includes(task.title));
   if (task?.run?.cwd && existsSync(path.join(task.run.cwd, "result.txt"))) observedWrites.set(task.id, readFileSync(path.join(task.run.cwd, "result.txt"), "utf8"));
  }
  if (prompt.includes("HOLD")) { held = true; await Bun.sleep(1500); }
  let tools: Array<{ name: string; args: unknown }> = [];
  if (gate && !results.length) tools = [{ name: "kb_read", args: { operation: "open", path: "lifecycle.md" } }];
  if (prompt.includes("WRITE") && !results.length) tools = [{ name: "write", args: { path: "result.txt", content: "Actual agent-created result" } }];
  if (prompt.includes("DENIAL") && !results.length) {
   tools = forbiddenNames.map(name => ({ name, args: name === "write" ? { path: "forbidden.txt", content: "forbidden" } : name === "bash" ? { command: "touch forbidden.txt" } : name === "eval" ? { language: "js", code: "await Bun.write('forbidden.txt','forbidden')" } : name.includes("edit") ? { path: "source.txt", oldText: "Original fixture source", newText: "changed" } : name.includes("read") ? { path: "source.txt" } : name.includes("grep") ? { path: ".", pattern: "Original" } : name === "glob" ? { pattern: "*" } : name === "kb_write" ? { uri: "kb://system/forbidden.md", content: "forbidden" } : { context: "private fixture", tasks: [{ task: "touch forbidden.txt" }] } }));
   tools.push({ name: "card_read", args: { path: "source.txt" } });
  }
  const delta = tools.length ? { role: "assistant", tool_calls: tools.map((tool, index) => ({ index, id: `call_${tool.name}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) } : { role: "assistant", content: "Fixture card completed with a recorded outcome." };
  const chunks = [{ id: "fixture", object: "chat.completion.chunk", model: "card", choices: [{ index: 0, delta, finish_reason: null }] }, { id: "fixture", object: "chat.completion.chunk", model: "card", choices: [{ index: 0, delta: {}, finish_reason: tools.length ? "tool_calls" : "stop" }] }];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
 } });
 writeFileSync(path.join(agentDir, "models.yml"), `providers:\n  fixture:\n    baseUrl: http://127.0.0.1:${provider.port}/v1\n    api: openai-completions\n    apiKey: fixture-only\n    models:\n      - id: card\n        name: Card Fixture\n        reasoning: false\n        input: [text]\n        contextWindow: 32000\n        maxTokens: 1000\n`);
 writeFileSync(path.join(agentDir, "config.yml"), "extensions:\n  enabled: false\n");
 await loadBackend(resolveBackendSelection()!);
 if (!sdk().getAgentDir().startsWith(fixtureRoot + path.sep)) throw new Error("refusing non-private fixture agent dir");
 openDb({ path: path.join(fixtureRoot, "deck.db") });
 const config: Config = { host: "127.0.0.1", port: 0, defaultCwd: project, extraWorkspaces: [], devMode: true, idleTimeoutMs: 0, dbPath: path.join(fixtureRoot, "deck.db"), uploadsRoot: path.join(fixtureRoot, "uploads"), cardAgentConcurrency: 2, cardAgentModel: "fixture/card" };
 const runner = new CardAgentRunner(config);
 let capabilityRunner = runner;
 const vault = path.join(fixtureRoot, "vault"); mkdirSync(vault); writeFileSync(path.join(vault, "lifecycle.md"), "# Explicit lifecycle read\nPrivate lifecycle fixture content\n");
 const kb = new KbService({ root: vault });
 const observations: Array<{ token: string; agentId: string; readOnly: boolean; projectCwd: string | null; status: number }> = [];
 const app = buildTasksRouter(runner);
 app.route("/api", buildKbRouter(kb, { resolveAgent: token => capabilityRunner.resolveToken(token) }));
 const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const token = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
  const identity = token ? capabilityRunner.resolveToken(token) : undefined;
  const response = await app.fetch(request);
  if (token && identity && new URL(request.url).pathname === "/api/kb/agent/read") observations.push({ token, ...identity, status: response.status });
  return response;
 } });
 const endpoint = `http://127.0.0.1:${server.port}`; runner.setApiOrigin(endpoint);
 const post = async (route: string, body: unknown = {}): Promise<Response> => fetch(endpoint + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
 const create = async (title: string, properties?: Record<string, unknown>, cwd?: string): Promise<Task> => { const response = await post("/tasks", { title, properties, cwd }); expect(response.status).toBe(201); return response.json() as Promise<Task>; };
 async function waitFor<T>(read: () => T | undefined | false, message: string): Promise<T> {
  const until = Date.now() + 40_000; while (Date.now() < until) { const value = read(); if (value) return value; await Bun.sleep(25); } throw new Error(`Timeout: ${message}; ${JSON.stringify(requests.at(-1)?.messages?.at(-1))}`);
 }
 const finish = (task: Task) => waitFor(() => { const current = getTask(task.id)!; return current.run && !["queued", "running"].includes(current.run.status) ? current : undefined; }, `card ${task.id} completion`);
 afterAll(async () => { for (const gate of tokenGates.values()) gate.release(); await runner.dispose(); if (capabilityRunner !== runner) await capabilityRunner.dispose(); server.stop(true); provider.stop(true); closeDb(); git("worktree", "remove", "--force", linked); });

 test("assignment auto-executes in a fresh worktree, reports outcome and removes its owned worktree", async () => {
  const task = await create("WRITE"); expect((await post(`/tasks/${task.id}/assign`)).status).toBe(202);
  const complete = await finish(task); expect(complete.run?.status).toBe("completed"); expect(complete.run?.outcome).toBe("Fixture card completed with a recorded outcome."); expect(complete.stateId).toBe("s_done");
  expect(observedWrites.get(task.id)).toBe("Actual agent-created result");
  expect(complete.cwd).toBeUndefined(); expect(complete.run?.cwd).not.toBe(project); expect(existsSync(complete.run!.cwd!)).toBe(false); expect(existsSync(path.join(project, "result.txt"))).toBe(false); expect(unfinishedCardRuns()).toEqual([]);
 }, 50_000);

 test("linked worktree runs there and survives completion; readonly SDK rejects actual file/exec/subagent calls", async () => {
  const writable = await create("WRITE linked", { worktree: linked }); await post(`/tasks/${writable.id}/assign`); const complete = await finish(writable);
  expect(complete.run?.error).toBeUndefined(); expect(complete.run?.status).toBe("completed"); expect(complete.run?.cwd).toBe(realpathSync(linked)); expect(complete.run?.ownedWorktree).toBe(false); expect(readFileSync(path.join(linked, "result.txt"), "utf8")).toBe("Actual agent-created result");
  const readonly = await create("DENIAL", { "read-only": true, worktree: linked }); await post(`/tasks/${readonly.id}/assign`); const research = await finish(readonly);
  expect(research.run?.status).toBe("completed"); expect(existsSync(linked)).toBe(true); expect(existsSync(path.join(linked, "forbidden.txt"))).toBe(false); expect(readFileSync(path.join(linked, "source.txt"))).toEqual(linkedSource);
  for (const name of forbiddenNames.filter(name => /read|grep|glob/.test(name))) expect(denied.get(`call_${name}`)).not.toContain("Original fixture source");
  expect(denied.get("call_card_read")).toContain("Original fixture source");
 }, 80_000);

 test("portable SDK restriction rejects real prohibited tool calls without an OS sandbox", async () => {
  const proc = spawnOwned([process.execPath, fileURLToPath(new URL("./card-agent-worker.ts", import.meta.url))], { cwd: linked, env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" }, { replaceEnv: true });
  const timeout = setTimeout(() => { void terminateOwned(proc); }, 45_000);
  try {
   proc.stdin.write(JSON.stringify({ id: "portable-denial", cwd: linked, agentDir, prompt: "DENIAL portable", readOnly: true, model: "fixture/card", kbEndpoint: endpoint + "/kb", kbToken: "private-fixture-token" }));
   proc.stdin.end();
   const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
   if (exit !== 0) console.error(stderr);
   expect(exit).toBe(0);
   const ends = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(event => event.type === "tool_execution_end");
   for (const name of forbiddenNames) expect(ends.find(event => event.toolName === name)?.isError).toBe(true);
   const read = ends.find(event => event.toolName === "card_read");
   expect(read?.isError).toBe(false); expect(JSON.stringify(read.result)).toContain("Original fixture source");
   expect(existsSync(path.join(linked, "forbidden.txt"))).toBe(false); expect(readFileSync(path.join(linked, "source.txt"))).toEqual(linkedSource);
  } finally { clearTimeout(timeout); await terminateOwned(proc, 0); }
 }, 50_000);

 test("global N concurrency queues extra assignments, supports cancellation and never exceeds N", async () => {
  held = false; const cards = await Promise.all(Array.from({ length: 5 }, (_, index) => create(`HOLD ${index}`, { "read-only": true })));
  await Promise.all(cards.map(card => post(`/tasks/${card.id}/assign`)));
  await waitFor(() => held, "fixture provider entry"); expect(cards.filter(card => getTask(card.id)?.run?.status === "running")).toHaveLength(2); expect(cards.filter(card => getTask(card.id)?.run?.status === "queued")).toHaveLength(3);
  const cancelled = await post(`/tasks/${cards[4]!.id}/cancel`); expect((await cancelled.json() as { status: string }).status).toBe("cancelled");
  let peak = 0; while (cards.some(card => ["queued", "running"].includes(getTask(card.id)?.run?.status ?? ""))) { peak = Math.max(peak, cards.filter(card => getTask(card.id)?.run?.status === "running").length); expect(peak).toBeLessThanOrEqual(2); await Bun.sleep(25); }
  expect(peak).toBe(2); for (const card of cards.slice(0, 4)) expect(getTask(card.id)?.run?.status).toBe("completed");
  const running = await create("HOLD cancellation", { "read-only": true }); held = false; await post(`/tasks/${running.id}/assign`); await waitFor(() => held, "running cancellation entry"); await post(`/tasks/${running.id}/cancel`);
  expect(getTask(running.id)?.run?.status).toBe("cancelled"); expect(existsSync(getTask(running.id)!.run!.cwd!)).toBe(false); expect(unfinishedCardRuns()).toEqual([]);
 }, 80_000);

 test("native worker capabilities are fresh per run, isolated and revoked by completion, failure, cancellation, shutdown and recovery", async () => {
  const stale: string[] = [];
  const probe = (token: string) => fetch(endpoint + "/api/kb/agent/read", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ operation: "open", path: "lifecycle.md" }) });
  async function start(title: string, readOnly = false, owner = runner, task?: Task) {
   const gate = tokenGate(title);
   const card = task ?? await create(title, { worktree: linked, "read-only": readOnly }, project);
   const run = owner.assign(card.id);
   const observed = await waitFor(() => observations.find(entry => entry.agentId === run.id), `native bearer for ${title}`);
   await waitFor(() => gate.reached, `native KB result for ${title}`);
   expect(observed.status).toBe(200);
   expect(observed.agentId).toBe(run.id); expect(observed.readOnly).toBe(readOnly); expect(observed.projectCwd).toBe(project);
   expect(observed.token).not.toBe(run.id);
   expect(stale).not.toContain(observed.token);
   expect(denied.get("call_kb_read")).toContain("Private lifecycle fixture content");
   const live = await probe(observed.token); expect(live.status).toBe(200); expect(await live.text()).toContain("Private lifecycle fixture content");
   return { card, run, gate, token: observed.token };
  }
  try {
   const first = await start("TOKEN lifecycle completed");
   const second = await start("TOKEN lifecycle cancelled", true);
   expect(second.token).not.toBe(first.token);
   expect(runner.resolveToken(first.token)?.agentId).toBe(first.run.id);
   expect(runner.resolveToken(second.token)?.agentId).toBe(second.run.id);
   const cancelling = runner.cancel(second.card.id);
   // Check before awaiting teardown: abort, not worker exit or artifact cleanup, revokes authority.
   expect(runner.resolveToken(second.token)).toBeUndefined();
   expect((await probe(second.token)).status).toBe(401);
   expect((await probe(first.token)).status).toBe(200);
   await cancelling; expect(getTask(second.card.id)?.run?.status).toBe("cancelled");
   stale.push(second.token);
   first.gate.release(); expect((await finish(first.card)).run?.status).toBe("completed");
   expect((await probe(first.token)).status).toBe(401); stale.push(first.token);

   // Reassign the same card: identity and capability must both change, even with the same cwd.
   const repeated = await start(first.card.title, false, runner, first.card);
   expect(repeated.run.id).not.toBe(first.run.id);
   expect((await probe(first.token)).status).toBe(401);
   repeated.gate.fail = true; repeated.gate.release();
   const failed = await finish(repeated.card); expect(failed.run?.status).toBe("failed"); expect(failed.run?.error).toContain("Intentional lifecycle fixture provider failure");
   expect((await probe(repeated.token)).status).toBe(401); stale.push(repeated.token);

   const shutdownA = await start("TOKEN lifecycle shutdown A");
   const shutdownB = await start("TOKEN lifecycle shutdown B", true);
   expect(shutdownB.token).not.toBe(shutdownA.token);
   const disposing = runner.dispose();
   expect(runner.resolveToken(shutdownA.token)).toBeUndefined(); expect(runner.resolveToken(shutdownB.token)).toBeUndefined();
   expect((await probe(shutdownA.token)).status).toBe(401); expect((await probe(shutdownB.token)).status).toBe(401);
   await disposing;
   expect(getTask(shutdownA.card.id)?.run?.status).toBe("cancelled"); expect(getTask(shutdownB.card.id)?.run?.status).toBe("cancelled");
   stale.push(shutdownA.token, shutdownB.token);
   expect(() => runner.assign(shutdownA.card.id)).toThrow("shutting down");

   // New in-process authority plus recover() with no unfinished artifacts; no process crash is simulated.
   capabilityRunner = new CardAgentRunner(config); capabilityRunner.setApiOrigin(endpoint);
   for (const token of stale) expect((await probe(token)).status).toBe(401);
   await capabilityRunner.recover();
   for (const token of stale) expect((await probe(token)).status).toBe(401);
   const recovered = await start("TOKEN lifecycle recovered", false, capabilityRunner);
   for (const token of stale) expect((await probe(token)).status).toBe(401);
   recovered.gate.release(); expect((await finish(recovered.card)).run?.status).toBe("completed");
   expect((await probe(recovered.token)).status).toBe(401);
   expect(unfinishedCardRuns()).toEqual([]);
  } finally {
   for (const gate of tokenGates.values()) gate.release();
   await runner.dispose(); if (capabilityRunner !== runner) await capabilityRunner.dispose();
  }
 }, 120_000);

 test("recovery retries owned artifacts without deleting user-linked worktrees or changing terminal outcomes", async () => {
  const task = await create("recovery"); const runtime = mkdtempSync(path.join(tmpdir(), "deck-card-recovery-"));
  saveCardRun({ id: "recovery", taskId: task.id, status: "completed", assignedAt: "2026-10-13T00:00:00Z", ownedWorktree: false, cwd: linked, outcome: "already completed" }, { runtimePath: runtime });
  await runner.recover(); expect(existsSync(runtime)).toBe(false); expect(existsSync(linked)).toBe(true); expect(getTask(task.id)?.run?.status).toBe("completed"); expect(getTask(task.id)?.run?.outcome).toBe("already completed"); expect(unfinishedCardRuns()).toEqual([]);
 });

 test("Linux defense denies host/worktree writes independently of the SDK tool gate", async () => {
  if (process.platform !== "linux") return;
  const runtime = mkdtempSync(path.join(tmpdir(), "deck-card-os-denial-"));
  try {
   const command = readonlyCardCommand([process.execPath, "-e", `await Bun.write(${JSON.stringify(path.join(linked, "os-forbidden.txt"))}, 'forbidden')`], linked, runtime);
   const result = spawnOwnedSync(command, { cwd: linked, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); expect(result.exitCode).not.toBe(0); expect(existsSync(path.join(linked, "os-forbidden.txt"))).toBe(false);
  } finally { await cleanupCardWorkspace({ runtimePath: runtime }); }
 });
}
