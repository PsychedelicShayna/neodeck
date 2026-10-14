import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GraphNodeType, GraphOutput, GraphRunRecord, Routine, RoutineGraph, RoutineRun, RoutineSpec } from "@npi-deck/protocol";
import { closeDb, getDb, openDb } from "../db/index.ts";
import { createGraphRoutine, createRoutine, createV1Routine, getGraphRun, getRoutine, listRuns, updateGraphRoutine } from "../db/routines.ts";
import { listStepRuns } from "../db/routine-step-runs.ts";
import { initializeOwnedGeneration, stopOwnedProcesses } from "../owned-process.ts";
import { buildRoutinesRouter } from "../routes-routines.ts";
import { RoutinesRunner } from "../routines-runner.ts";
import { findGraphOutput, readGraphPath } from "./graph-runner.ts";

let home = "";
let runner: RoutinesRunner | undefined;
let oldHome: string | undefined;
let oldDb: string | undefined;
function setup(): RoutinesRunner {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "neodeck-graph-persistence-"));
	oldHome = process.env.NPI_DECK_HOME;
	oldDb = process.env.NPI_DECK_DB_PATH;
	process.env.NPI_DECK_HOME = home;
	process.env.NPI_DECK_DB_PATH = path.join(home, "deck.db");
	openDb({ path: process.env.NPI_DECK_DB_PATH });
	initializeOwnedGeneration();
	runner = new RoutinesRunner();
	return runner;
}
afterEach(async () => {
	await runner?.dispose();
	await stopOwnedProcesses();
	closeDb();
	if (oldHome === undefined) delete process.env.NPI_DECK_HOME; else process.env.NPI_DECK_HOME = oldHome;
	if (oldDb === undefined) delete process.env.NPI_DECK_DB_PATH; else process.env.NPI_DECK_DB_PATH = oldDb;
	if (home) fs.rmSync(home, { recursive: true, force: true });
	home = "";
	runner = undefined;
});
function graph(eventType = "manual"): RoutineGraph {
	return { version: 2, nodes: [{ id: "source", type: "event.source", config: { eventType } }], edges: [] };
}
function definition(type: string, outputType: "object" | "string" | "number" = "object", multiple = false): GraphNodeType {
	return { type, label: type, kind: "operation", inputs: [{ id: "in", type: "object", multiple }], outputs: [{ id: "out", type: outputType }] };
}
function connect(spec: RoutineGraph, id: string, from: string, to: string, fromPort = "out", toPort = "in"): void {
	spec.edges.push({ id, from: { nodeId: from, port: fromPort }, to: { nodeId: to, port: toPort } });
}
function request(body: unknown, method = "POST"): RequestInit {
	return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

test("native save/load and metadata updates keep JSON as the only source and reject legacy authoring", async () => {
	const run = setup();
	const api = buildRoutinesRouter(run);
	const source = graph();
	source.layout = { nodes: { source: { x: 12, y: 34 } } };
	for (const legacy of [{ specYaml: "version: 1" }, { cron: "* * * * *" }, { actionKind: "bash" }, { actionBody: "echo wrong" }, { actionCwd: home }]) {
		expect((await api.request("/routines", request({ name: "mixed", graph: source, ...legacy }))).status).toBe(400);
	}
	const response = await api.request("/routines", request({ name: "native", graph: source }));
	expect(response.status).toBe(201);
	const saved = await response.json() as Routine;
	expect(saved.specVersion).toBe(2);
	expect(getRoutine(saved.id)?.graph).toEqual(source);
	const row = getDb().query<{ graph_json: string; spec_yaml: string | null }, [string]>(
		"SELECT graph_json, spec_yaml FROM routines WHERE id = ?",
	).get(saved.id)!;
	expect(JSON.parse(row.graph_json)).toEqual(source);
	expect(row.spec_yaml).toBeNull();
	closeDb();
	openDb({ path: path.join(home, "deck.db") });
	expect(getRoutine(saved.id)?.graph).toEqual(source);
	for (const patch of [{ specYaml: "version: 1" }, { cron: "* * * * *" }, { actionKind: "bash" }, { actionBody: "echo wrong" }, { actionCwd: home }]) {
		expect((await api.request(`/routines/${saved.id}`, request(patch, "PATCH"))).status).toBe(400);
		expect(getRoutine(saved.id)?.graph).toEqual(source);
	}
	const patch = await api.request(`/routines/${saved.id}`, request({ name: "renamed", description: "still native", enabled: false }, "PATCH"));
	expect(patch.status).toBe(200);
	expect(getRoutine(saved.id)).toMatchObject({ name: "renamed", enabled: false, graph: source });
	const changed = graph("inbox");
	expect((await api.request(`/routines/${saved.id}`, request({ graph: changed }, "PATCH"))).status).toBe(200);
	expect((await (await api.request(`/routines/${saved.id}`)).json() as Routine).graph).toEqual(changed);
});

test("registered config schema, native API manual execution and catalogue share the same real registry", async () => {
	const run = setup();
	const multiply: GraphNodeType = {
		...definition("multiply", "number"),
		configSchema: {
			type: "object", properties: { factor: { type: "number" } },
			required: ["factor"], additionalProperties: false,
		},
	};
	run.graphRegistry.register({ definition: multiply, execute: ({ node, inputs }) => [{
		port: "out", value: (inputs[0]!.output.result.count as number) * (node.config.factor as number),
	}] });
	const api = buildRoutinesRouter(run);
	const native = graph();
	native.nodes.push({ id: "multiply", type: "multiply", config: { factor: 3 } });
	connect(native, "multiply-edge", "source", "multiply", "event");
	const invalid = structuredClone(native);
	invalid.nodes[1]!.config.factor = "not numeric";
	expect((await api.request("/routines", request({ name: "invalid config", graph: invalid }))).status).toBe(400);
	const saved = await (await api.request("/routines", request({ name: "multiply", graph: native, enabled: false }))).json() as Routine;
	const catalogue = await (await api.request("/routine-node-types")).json() as { nodeTypes: GraphNodeType[] };
	expect(catalogue.nodeTypes.find((type) => type.type === "multiply")).toEqual(multiply);
	await run.fireGraphEvent(saved.id, { eventType: "manual", event: { count: 99 } });
	expect(listRuns(saved.id)).toEqual([]);
	const response = await api.request(`/routines/${saved.id}/run`, request({ count: 7 }));
	expect(response.status).toBe(202);
	const deadline = Date.now() + 3000;
	let trace: GraphRunRecord | undefined;
	while (!trace && Date.now() < deadline) {
		await Bun.sleep(10);
		const record = listRuns(saved.id)[0];
		if (record) trace = getGraphRun(record.id);
	}
	expect(trace).toMatchObject({ status: "success", activation: { eventType: "manual", event: { count: 7 } } });
	const result = trace?.nodeRuns.find((node) => node.nodeId === "multiply")?.outputs[0];
	expect(result).toMatchObject({ result: { value: 21 }, inputs: [{ result: { count: 7 } }] });
	expect(listRuns(saved.id)[0]?.trigger).toBe("manual");
});

test("invalid typed edges fail before save, update or dispatch even if the stored graph is corrupted", async () => {
	const run = setup();
	let calls = 0;
	run.graphRegistry.register({ definition: definition("text", "string"), execute: () => { calls++; return [{ port: "out", value: "truthy" }]; } });
	run.graphRegistry.register({ definition: { ...definition("number"), inputs: [{ id: "in", type: "number" }] }, execute: () => { calls++; return [{ port: "out", value: 1 }]; } });
	const invalid = graph();
	invalid.nodes.push({ id: "text", type: "text", config: {} }, { id: "number", type: "number", config: {} });
	connect(invalid, "source-text", "source", "text", "event");
	connect(invalid, "text-number", "text", "number");
	const api = buildRoutinesRouter(run);
	expect((await api.request("/routine-graphs/validate", request(invalid))).status).toBe(400);
	expect((await api.request("/routines", request({ name: "invalid", graph: invalid }))).status).toBe(400);
	expect(() => createGraphRoutine({ name: "invalid", graph: invalid }, run.graphRegistry)).toThrow("invalid graph");
	const valid = createGraphRoutine({ name: "valid", graph: graph() }, run.graphRegistry);
	expect((await api.request(`/routines/${valid.id}`, request({ graph: invalid }, "PATCH"))).status).toBe(400);
	expect(() => updateGraphRoutine(valid.id, { graph: invalid }, run.graphRegistry)).toThrow("invalid graph");
	expect(getRoutine(valid.id)?.graph).toEqual(graph());
	getDb().query("UPDATE routines SET graph_json = ? WHERE id = ?").run(JSON.stringify(invalid), valid.id);
	expect((await api.request(`/routines/${valid.id}/run`, request({}))).status).toBe(400);
	await expect(run.fire(valid.id)).rejects.toThrow("invalid graph");
	expect(listRuns(valid.id)).toEqual([]);
	expect(calls).toBe(0);
});

test("actual native run preserves truthy scalar, object and ordered recursive provenance after later edits", async () => {
	const run = setup();
	const event = { original: { nested: [1, "not true", false] }, text: "original event" };
	const object = { exact: { value: 7 } };
	const seen: GraphOutput[] = [];
	run.graphRegistry.register({ definition: definition("text", "string"), execute: ({ inputs }) => {
		expect(inputs[0]!.output.result).toBe(event);
		return [{ port: "out", value: "truthy-not-boolean" }];
	} });
	run.graphRegistry.register({ definition: definition("numeric", "number"), execute: () => [{ port: "out", value: 1 }] });
	run.graphRegistry.register({ definition: definition("object"), execute: () => [{ port: "out", value: object }] });
	run.graphRegistry.register({ definition: definition("join", "object", true), execute: ({ inputs }) => {
		seen.push(...inputs.map((input) => input.output));
		expect(inputs.map((input) => input.output.nodeId)).toEqual(["number", "text", "object"]);
		expect(inputs[2]!.output.result).toBe(object);
		expect(readGraphPath(inputs[1]!.output, ["result", "value"])).toBe("truthy-not-boolean");
		expect(findGraphOutput(inputs[1]!.output, "source")?.result).toBe(event);
		return [{ port: "out", value: { values: inputs.map((input) => input.output.result) } }];
	} });
	const native = graph("inbox");
	native.nodes.push({ id: "text", type: "text", config: {} }, { id: "number", type: "numeric", config: {} }, { id: "object", type: "object", config: {} }, { id: "join", type: "join", config: {} });
	for (const node of ["text", "number", "object"]) connect(native, `source-${node}`, "source", node, "event");
	for (const node of ["number", "text", "object"]) connect(native, `${node}-join`, node, "join");
	const saved = createGraphRoutine({ name: "provenance", graph: native }, run.graphRegistry);
	await run.fireGraphEvent(saved.id, { eventType: "inbox", event });
	const record = listRuns(saved.id)[0]!;
	const trace = getGraphRun(record.id)!;
	expect(trace.status).toBe("success");
	expect(record.exitCode).toBe(0);
	expect(trace.activation.event).toEqual(event);
	const join = trace.nodeRuns.find((node) => node.nodeId === "join")!;
	expect(join.outputs[0]!.inputs).toEqual(seen);
	expect(join.inputs.map((input) => input.result)).toEqual([{ value: 1 }, { value: "truthy-not-boolean" }, object]);
	expect(findGraphOutput(join.outputs[0]!, "source")?.result).toEqual(event);
	expect(readGraphPath(join.outputs[0]!, ["inputs", 1, "inputs", 0, "result", "original", "nested", 1])).toBe("not true");
	const changed = graph("different");
	updateGraphRoutine(saved.id, { graph: changed }, run.graphRegistry);
	const api = buildRoutinesRouter(run);
	const response = await api.request(`/routines/${saved.id}/runs/${record.id}/graph`);
	expect(response.status).toBe(200);
	expect((await response.json() as GraphRunRecord).graph).toEqual(native);
	expect(getRoutine(saved.id)?.graph).toEqual(changed);
	expect((await api.request(`/routines/other/runs/${record.id}/graph`)).status).toBe(404);
	const listing = await (await api.request(`/routines/${saved.id}/runs`)).json() as { runs: RoutineRun[] };
	expect(listing.runs[0]).not.toHaveProperty("graph");
	expect(listing.runs[0]).not.toHaveProperty("nodeRuns");
});

test("native failures and usage-budget aborts finalize traces and existing run aggregates", async () => {
	const run = setup();
	run.graphRegistry.register({ definition: definition("fail"), execute: () => { throw new Error("real handler failure"); } });
	const failed = graph();
	failed.nodes.push({ id: "fail", type: "fail", config: {} });
	connect(failed, "fail-edge", "source", "fail", "event");
	const saved = createGraphRoutine({ name: "failed", graph: failed }, run.graphRegistry);
	await run.fire(saved.id, "manual", { original: "failure event" });
	const failureRun = listRuns(saved.id)[0]!;
	expect(getGraphRun(failureRun.id)).toMatchObject({ status: "failed", graph: failed });
	expect(getGraphRun(failureRun.id)?.nodeRuns.find((node) => node.nodeId === "fail")).toMatchObject({ status: "failed", inputs: [{ result: { original: "failure event" } }] });
	expect(failureRun).toMatchObject({ exitCode: 1, stepCountFailed: 1 });
	run.graphRegistry.register({ definition: definition("usage"), execute: ({ recordUsage }) => {
		recordUsage({ llmTokensIn: 4, llmTokensOut: 2, llmCostMicros: 7 });
		return [{ port: "out", value: "used tokens" }];
	} });
	const budget = graph();
	budget.budget = { max_llm_tokens_input: 3 };
	budget.nodes.push({ id: "usage", type: "usage", config: {} });
	connect(budget, "usage-edge", "source", "usage", "event");
	const capped = createGraphRoutine({ name: "budget", graph: budget }, run.graphRegistry);
	await run.fire(capped.id);
	const aborted = listRuns(capped.id)[0]!;
	expect(aborted).toMatchObject({ abortReason: "budget", totalLlmTokens: 6, totalLlmCostMicros: 7 });
	expect(getGraphRun(aborted.id)).toMatchObject({ status: "aborted", abortReason: "budget" });
});

test("queued native runs execute their admission snapshot and release concurrency/work lifecycle", async () => {
	const run = setup();
	const entered = deferred();
	const release = deferred();
	const executed: string[] = [];
	run.graphRegistry.register({ definition: definition("wait"), execute: async ({ inputs, node }) => {
		executed.push(node.config.label as string);
		if (inputs[0]!.output.result.invocation === "first") { entered.resolve(); await release.promise; }
		return [{ port: "out", value: node.config.label }];
	} });
	const native = graph();
	native.concurrency = "queue";
	native.nodes.push({ id: "wait", type: "wait", config: { label: "original" } });
	connect(native, "wait-edge", "source", "wait", "event");
	const saved = createGraphRoutine({ name: "queue", graph: native }, run.graphRegistry);
	const first = run.fire(saved.id, "manual", { invocation: "first" });
	await entered.promise;
	const second = run.fire(saved.id, "manual", { invocation: "second" });
	expect(run.workSnapshot.map((work) => work.routineId)).toEqual([saved.id, saved.id]);
	const changed = structuredClone(native);
	changed.nodes[1]!.config.label = "edited";
	updateGraphRoutine(saved.id, { graph: changed }, run.graphRegistry);
	release.resolve();
	await Promise.all([first, second]);
	expect(executed).toEqual(["original", "original"]);
	for (const record of listRuns(saved.id)) expect(getGraphRun(record.id)?.graph).toEqual(native);
	expect(run.workSnapshot).toEqual([]);
	expect(run.concurrency.snapshot().filter((entry) => entry.active || entry.queued)).toEqual([]);
});

test("dispose aborts a native handler and concurrency-skipped runs retain a trace", async () => {
	const run = setup();
	const entered = deferred();
	run.graphRegistry.register({ definition: definition("wait"), execute: async ({ signal }) => {
		entered.resolve();
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
		return [{ port: "out", value: "aborted work" }];
	} });
	const native = graph();
	native.nodes.push({ id: "wait", type: "wait", config: {} });
	connect(native, "wait-edge", "source", "wait", "event");
	const saved = createGraphRoutine({ name: "abort", graph: native }, run.graphRegistry);
	const first = run.fire(saved.id);
	await entered.promise;
	await run.fire(saved.id);
	await run.dispose();
	await first;
	const records = listRuns(saved.id);
	expect(records.map((record) => record.abortReason).sort()).toEqual(["cancelled", "concurrency_skipped"]);
	for (const record of records) expect(getGraphRun(record.id)).toMatchObject({ status: "aborted", graph: native });
	expect(run.busy).toBe(false);
});

test("manual activation records unmatched event sources and their consumers as skipped without inventing outputs", async () => {
	const run = setup();
	let executions = 0;
	run.graphRegistry.register({ definition: definition("consumer"), execute: () => {
		executions++;
		return [{ port: "out", value: "must not run" }];
	} });
	const native = graph("inbox");
	native.nodes.push({ id: "consumer", type: "consumer", config: {} });
	connect(native, "event-edge", "source", "consumer", "event");
	const saved = createGraphRoutine({ name: "unmatched", graph: native }, run.graphRegistry);
	await run.fire(saved.id, "manual", { value: "not an inbox activation" });
	const trace = getGraphRun(listRuns(saved.id)[0]!.id)!;
	expect(trace.activation.eventType).toBe("manual");
	expect(trace.nodeRuns.map((node) => ({ id: node.nodeId, status: node.status, outputs: node.outputs })))
		.toEqual([{ id: "source", status: "skipped", outputs: [] }, { id: "consumer", status: "skipped", outputs: [] }]);
	expect(trace.outputs).toEqual([]);
	expect(executions).toBe(0);
});

test("native cron activates its configured source and never falls back to the legacy cron mirror", async () => {
	const run = setup();
	const manual = createGraphRoutine({ name: "no native cron", graph: graph() }, run.graphRegistry);
	getDb().query("UPDATE routines SET cron = ? WHERE id = ?").run("* * * * * *", manual.id);
	run.schedule(getRoutine(manual.id)!);
	expect(getRoutine(manual.id)?.nextRunAt).toBeUndefined();

	const native = graph("tick");
	native.nodes[0]!.config.cron = "* * * * * *";
	native.nodes.push({ id: "manual-only", type: "event.source", config: { eventType: "manual" } });
	const saved = createGraphRoutine({ name: "native clock", graph: native }, run.graphRegistry);
	run.schedule(saved);
	const deadline = Date.now() + 3000;
	let trace: GraphRunRecord | undefined;
	while (!trace && Date.now() < deadline) {
		await Bun.sleep(20);
		const record = listRuns(saved.id)[0];
		if (record) trace = getGraphRun(record.id);
	}
	run.unschedule(saved.id);
	expect(trace).toMatchObject({
		status: "success",
		activation: { eventType: "tick", sourceNodeId: "source" },
	});
	expect(trace?.nodeRuns.find((node) => node.nodeId === "source")?.outputs[0]?.result)
		.toEqual(trace?.activation.event);
	expect(trace?.nodeRuns.find((node) => node.nodeId === "manual-only")?.status).toBe("skipped");
	expect(listRuns(saved.id)[0]?.trigger).toBe("cron");
	expect(listRuns(manual.id)).toEqual([]);
});

test("legacy V0 and V1 still execute their own stored source without graph traces", async () => {
	const run = setup();
	const legacy = createRoutine({ name: "legacy", cron: "0 0 1 1 *", actionKind: "bash", actionBody: "printf legacy-output", actionCwd: home });
	const spec: RoutineSpec = { name: "pipeline", trigger: [{ manual: {} }], steps: [{ id: "print", type: "run", command: "printf pipeline-output" }] };
	const yaml = JSON.stringify(spec);
	const pipeline = createV1Routine({ name: spec.name, spec, specYaml: yaml });
	const api = buildRoutinesRouter(run);
	for (const saved of [legacy, pipeline]) expect((await api.request(`/routines/${saved.id}`, request({ graph: graph() }, "PATCH"))).status).toBe(400);
	await run.fire(legacy.id);
	await run.fire(pipeline.id);
	const legacyRun = listRuns(legacy.id)[0]!;
	const pipelineRun = listRuns(pipeline.id)[0]!;
	expect(legacyRun).toMatchObject({ exitCode: 0, stdoutExcerpt: "legacy-output" });
	expect(pipelineRun.exitCode).toBe(0);
	expect(listStepRuns(pipelineRun.id)[0]).toMatchObject({ status: "success", stdoutExcerpt: "pipeline-output" });
	expect(getRoutine(pipeline.id)?.specYaml).toBe(yaml);
	expect(getGraphRun(legacyRun.id)).toBeUndefined();
	expect(getGraphRun(pipelineRun.id)).toBeUndefined();
});
