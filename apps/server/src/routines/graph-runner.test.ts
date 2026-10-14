import { expect, test } from "bun:test";
import type { GraphEmission, GraphNode, GraphNodeType, GraphOutput, GraphPort, RoutineGraph } from "@npi-deck/protocol";
import { executeGraph, findGraphOutput, GraphNodeRegistry, GraphValidationError, readGraphPath, type GraphNodeImplementation } from "./graph-runner.ts";

function source(id = "source", eventType = "manual"): GraphNode { return { id, type: "event.source", config: { eventType } }; }
function node(id: string): GraphNode { return { id, type: id, config: {} }; }
function edge(id: string, from: string, to: string, output = "out", input = "in"): RoutineGraph["edges"][number] {
	return { id, from: { nodeId: from, port: output }, to: { nodeId: to, port: input } };
}
function register(registry: GraphNodeRegistry, type: string, execute: GraphNodeImplementation["execute"], inputs: GraphPort[] = [{ id: "in", type: "object" }], outputs: GraphPort[] = [{ id: "out", type: "object" }], kind: GraphNodeType["kind"] = "operation"): void {
	registry.register({ definition: { type, label: type, kind, inputs, outputs }, execute });
}
function single(registry: GraphNodeRegistry, execute: GraphNodeImplementation["execute"], outputs?: GraphPort[]): RoutineGraph {
	register(registry, "operation", execute, undefined, outputs);
	return { version: 2, nodes: [source(), node("operation")], edges: [edge("input", "source", "operation", "event")] };
}
const activation = () => ({ eventType: "manual", event: { message: "original", nested: { count: 3 } } });
function output(result: Awaited<ReturnType<typeof executeGraph>>, nodeId: string, port = "out"): GraphOutput {
	return result.outputs.find((item) => item.nodeId === nodeId && item.port === port)!;
}

test("scalar, array and object results keep their exact values and original recursive event", async () => {
	const registry = new GraphNodeRegistry();
	const event = activation();
	const array = [1, "truthy", false];
	const object = { exact: "object", nested: { original: true } };
	register(registry, "scalar", () => [{ port: "out", value: "truthy" }]);
	register(registry, "array", () => [{ port: "out", value: array }]);
	register(registry, "object", ({ inputs }) => {
		expect(readGraphPath(inputs[0]!.output, ["result", "value", 1])).toBe("truthy");
		expect(findGraphOutput(inputs[0]!.output, "source", "event")!.result).toBe(event.event);
		return [{ port: "out", value: object }];
	});
	const graph: RoutineGraph = { version: 2, nodes: [source(), node("scalar"), node("array"), node("object")], edges: [edge("a", "source", "scalar", "event"), edge("b", "scalar", "array"), edge("c", "array", "object")] };
	const result = await executeGraph(graph, event, registry);
	expect(result.status).toBe("success");
	expect(output(result, "scalar").result).toEqual({ value: "truthy" });
	expect(output(result, "array").result.value).toBe(array);
	expect(output(result, "object").result).toBe(object);
	expect(output(result, "object").inputs[0]).toBe(output(result, "array"));
	expect(findGraphOutput(output(result, "object"), "source")!.result).toBe(event.event);
	expect(readGraphPath(output(result, "object"), ["inputs", 0, "inputs", 0, "inputs", 0, "result", "nested", "count"])).toBe(3);
	expect(readGraphPath(output(result, "object"), ["result", "toString"])).toBeUndefined();
	expect(event.event).toEqual({ message: "original", nested: { count: 3 } });
});

test("distinct gate ports route a truthy string and literal true without truthiness coercion", async () => {
	const registry = new GraphNodeRegistry();
	register(registry, "gate", () => [{ port: "text", value: "yes" }, { port: "true", value: true }], undefined, [{ id: "text", type: "string" }, { id: "true", type: "boolean" }], "gate");
	register(registry, "text", ({ inputs }) => [{ port: "out", value: inputs[0]!.output.result.value! }], [{ id: "in", type: "string" }]);
	register(registry, "boolean", ({ inputs }) => [{ port: "out", value: inputs[0]!.output.result.value! }], [{ id: "in", type: "boolean" }]);
	const graph: RoutineGraph = { version: 2, nodes: [source(), node("gate"), node("text"), node("boolean")], edges: [edge("a", "source", "gate", "event"), edge("b", "gate", "text", "text"), edge("c", "gate", "boolean", "true")] };
	const result = await executeGraph(graph, activation(), registry);
	expect(result.status).toBe("success");
	expect(output(result, "text").result.value).toBe("yes");
	expect(output(result, "boolean").result.value).toBe(true);
});

test("two-input join retains original events in graph-edge order, not execution order", async () => {
	const registry = new GraphNodeRegistry();
	const left = { side: "left" }, right = { side: "right" };
	register(registry, "left-source", () => [{ port: "out", value: left }], [], undefined, "event");
	register(registry, "right-source", () => [{ port: "out", value: right }], [], undefined, "event");
	register(registry, "join", ({ inputs }) => {
		expect(inputs.map((input) => [input.port, input.edgeId])).toEqual([["right", "right-first"], ["left", "left-second"]]);
		return [{ port: "out", value: { joined: true } }];
	}, [{ id: "left", type: "object" }, { id: "right", type: "object" }]);
	const graph: RoutineGraph = { version: 2, nodes: [node("join"), { ...node("left-source"), config: { eventType: "manual" } }, { ...node("right-source"), config: { eventType: "manual" } }], edges: [edge("right-first", "right-source", "join", "out", "right"), edge("left-second", "left-source", "join", "out", "left")] };
	const result = await executeGraph(graph, activation(), registry);
	expect(result.nodeRuns.map((run) => run.nodeId)).toEqual(["left-source", "right-source", "join"]);
	expect(output(result, "join").inputs[0]).toBe(output(result, "right-source"));
	expect(output(result, "join").inputs[1]).toBe(output(result, "left-source"));
	expect(output(result, "join").inputs.map((input) => input.result)).toEqual([right, left]);
	expect(output(result, "join").inputs[0]!.result).toBe(right);
});

test("inactive required branch settles its join and descendants without invoking them", async () => {
	const registry = new GraphNodeRegistry();
	const invoked: string[] = [];
	register(registry, "gate", () => [{ port: "yes", value: 1 }], undefined, [{ id: "yes", type: "number" }, { id: "no", type: "number" }], "gate");
	register(registry, "join", () => { invoked.push("join"); return []; }, [{ id: "yes", type: "number" }, { id: "no", type: "number" }]);
	register(registry, "next", () => { invoked.push("next"); return []; });
	const graph: RoutineGraph = { version: 2, nodes: [source(), node("gate"), node("join"), node("next")], edges: [edge("a", "source", "gate", "event"), edge("yes", "gate", "join", "yes", "yes"), edge("no", "gate", "join", "no", "no"), edge("next", "join", "next")] };
	const result = await executeGraph(graph, activation(), registry);
	expect(result.status).toBe("success");
	expect(result.nodeRuns.map((run) => run.status)).toEqual(["success", "success", "skipped", "skipped"]);
	expect(invoked).toEqual([]);
	expect(result.nodeRuns[2]!.inputs[0]).toBe(output(result, "gate", "yes"));
});

test("optional inactive inputs do not block an active named input", async () => {
	const registry = new GraphNodeRegistry();
	register(registry, "gate", () => [{ port: "yes", value: 1 }], undefined, [{ id: "yes", type: "number" }, { id: "no", type: "number" }]);
	register(registry, "join", ({ inputs }) => [{ port: "out", value: { received: inputs.map((input) => input.port) } }], [{ id: "yes", type: "number" }, { id: "no", type: "number", required: false }]);
	const graph: RoutineGraph = { version: 2, nodes: [source(), node("gate"), node("join")], edges: [edge("a", "source", "gate", "event"), edge("yes", "gate", "join", "yes", "yes"), edge("no", "gate", "join", "no", "no")] };
	const result = await executeGraph(graph, activation(), registry);
	expect(output(result, "join").result).toEqual({ received: ["yes"] });
});

test("multiple emissions and multiple edges preserve input-edge then emission order", async () => {
	const registry = new GraphNodeRegistry();
	register(registry, "many", () => [{ port: "out", value: 2 }, { port: "out", value: 3 }], undefined, [{ id: "out", type: "number", multiple: true }]);
	register(registry, "join", ({ inputs }) => [{ port: "out", value: inputs.map((input) => input.output.result) }], [{ id: "in", type: "object", multiple: true }]);
	const graph: RoutineGraph = { version: 2, nodes: [source(), node("many"), node("join")], edges: [edge("a", "source", "many", "event"), edge("numbers", "many", "join"), edge("original", "source", "join", "event")] };
	const event = activation();
	const result = await executeGraph(graph, event, registry);
	const joined = output(result, "join");
	expect(joined.inputs.map((input) => input.nodeId)).toEqual(["many", "many", "source"]);
	expect(joined.inputs[0]!.result.value).toBe(2);
	expect(joined.inputs[1]!.result.value).toBe(3);
	expect(joined.inputs[2]!.result).toBe(event.event);
});

test("generic sources select matching event type and optionally one specific source", async () => {
	const registry = new GraphNodeRegistry();
	const graph: RoutineGraph = { version: 2, nodes: [source("one"), source("two"), source("webhook", "webhook")], edges: [] };
	const event = activation();
	const all = await executeGraph(graph, event, registry);
	expect(all.outputs.map((item) => item.nodeId)).toEqual(["one", "two"]);
	expect(all.nodeRuns[2]!.status).toBe("skipped");
	const selected = await executeGraph(graph, { ...event, sourceNodeId: "two" }, registry);
	expect(selected.outputs.map((item) => item.nodeId)).toEqual(["two"]);
	expect(selected.outputs[0]!.result).toBe(event.event);
	await expect(executeGraph(graph, { ...event, sourceNodeId: "absent" }, registry)).rejects.toBeInstanceOf(GraphValidationError);
});

test("invalid static graphs never invoke any handler", async () => {
	const registry = new GraphNodeRegistry();
	let invoked = false;
	const graph = single(registry, () => { invoked = true; return []; });
	register(registry, "tracked-source", () => { invoked = true; return [{ port: "event", value: { original: true } }]; }, [], [{ id: "event", type: "object" }], "event");
	graph.nodes[0] = { id: "source", type: "tracked-source", config: { eventType: "manual" } };
	graph.edges[0]!.from.port = "unknown";
	await expect(executeGraph(graph, activation(), registry)).rejects.toBeInstanceOf(GraphValidationError);
	expect(invoked).toBe(false);
});

test("config schemas reject invalid config and cannot poison registration", () => {
	const registry = new GraphNodeRegistry();
	const graph: RoutineGraph = { version: 2, nodes: [{ id: "source", type: "event.source", config: {} }], edges: [] };
	expect(registry.validate(graph).errors!.some((error) => error.path === "/nodes/0/config/eventType" && error.keyword === "required")).toBe(true);
	const implementation: GraphNodeImplementation = { definition: { type: "configured", label: "Configured", kind: "operation", inputs: [{ id: "in", type: "object" }], outputs: [], configSchema: { type: "no-such-type" } }, execute: () => [] };
	expect(() => registry.register(implementation)).toThrow();
	expect(registry.get("configured")).toBeUndefined();
	registry.register({ ...implementation, definition: { ...implementation.definition, configSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } }, additionalProperties: false } } });
	const valid: RoutineGraph = { version: 2, nodes: [source(), { id: "configured", type: "configured", config: { name: "actual" } }], edges: [edge("a", "source", "configured", "event")] };
	expect(registry.validate(valid)).toEqual({ valid: true });
	valid.nodes[1]!.config = {};
	expect(registry.validate(valid).errors!.some((error) => error.path === "/nodes/1/config" && error.keyword === "required")).toBe(true);
	expect(registry.get("configured")!.definition.type).toBe("configured");
	expect(() => registry.register({ ...implementation, definition: { ...implementation.definition, type: "async", configSchema: { $async: true, type: "object" } } })).toThrow("$async");
});

for (const [label, emission, ports, error] of [
	["unknown port", { port: "missing", value: 1 }, [{ id: "out", type: "number" }], "Unknown output port"],
	["wrong value type", { port: "out", value: "not a number" }, [{ id: "out", type: "number" }], "expected number"],
	["nonfinite value", { port: "out", value: Infinity }, [{ id: "out", type: "object" }], "non-JSON"],
	["undefined nested value", { port: "out", value: { missing: undefined } }, [{ id: "out", type: "object" }], "non-JSON"],
	["Date value", { port: "out", value: new Date(0) }, [{ id: "out", type: "object" }], "non-JSON"],
] as const) {
	test(`dynamic ${label} is a failed trace, not a successful run`, async () => {
		const registry = new GraphNodeRegistry();
		const graph = single(registry, () => [emission as unknown as GraphEmission], [...ports]);
		const result = await executeGraph(graph, activation(), registry);
		expect(result.status).toBe("failed");
		expect(result.nodeRuns[1]!.status).toBe("failed");
		expect(result.nodeRuns[1]!.error).toContain(error);
		expect(result.nodeRuns[1]!.outputs).toEqual([]);
	});
}

test("cyclic values and duplicate singular emissions fail before publishing any batch output", async () => {
	const cycle: Record<string, unknown> = {}; cycle.self = cycle;
	for (const values of [[{ port: "out", value: cycle }], [{ port: "out", value: 1 }, { port: "out", value: 2 }]]) {
		const registry = new GraphNodeRegistry();
		const graph = single(registry, () => values as GraphEmission[]);
		const result = await executeGraph(graph, activation(), registry);
		expect(result.status).toBe("failed");
		expect(result.nodeRuns[1]!.outputs).toEqual([]);
	}
});

test("handler errors are retained and remaining consumers settle without execution", async () => {
	const registry = new GraphNodeRegistry();
	const graph = single(registry, () => { throw new Error("handler exploded"); });
	let nextRan = false;
	register(registry, "next", () => { nextRan = true; return []; });
	graph.nodes.push(node("next")); graph.edges.push(edge("b", "operation", "next"));
	const records: string[] = [];
	const result = await executeGraph(graph, activation(), registry, { onNodeRun: (record) => { records.push(record.status); } });
	expect(result.status).toBe("failed");
	expect(result.error).toBe("handler exploded");
	expect(records).toEqual(["success", "failed", "skipped"]);
	expect(nextRan).toBe(false);
});

test("external abort propagates to the active handler and records cancellation", async () => {
	const registry = new GraphNodeRegistry(), controller = new AbortController();
	let observed = false;
	const graph = single(registry, ({ signal }) => new Promise((resolve) => {
		signal.addEventListener("abort", () => { observed = true; resolve([]); }, { once: true });
		queueMicrotask(() => controller.abort(new Error("requested cancellation")));
	}));
	const result = await executeGraph(graph, activation(), registry, { signal: controller.signal });
	expect(result.status).toBe("aborted");
	expect(result.abortReason).toBe("cancelled");
	expect(result.nodeRuns[1]!.status).toBe("aborted");
	expect(result.error).toBe("requested cancellation");
	expect(observed).toBe(true);
});

test("pre-aborted runs execute no handlers", async () => {
	const registry = new GraphNodeRegistry(), controller = new AbortController();
	let invoked = false;
	const graph = single(registry, () => { invoked = true; return []; });
	controller.abort("cancelled before start");
	const result = await executeGraph(graph, activation(), registry, { signal: controller.signal });
	expect(result.status).toBe("aborted");
	expect(result.usage!.stepsExecuted).toBe(0);
	expect(invoked).toBe(false);
});

test("step budget prevents executing the first handler beyond the cap", async () => {
	const registry = new GraphNodeRegistry();
	let invoked = false;
	const graph = single(registry, () => { invoked = true; return []; });
	graph.budget = { max_steps_executed: 1 };
	const result = await executeGraph(graph, activation(), registry);
	expect(result.status).toBe("aborted");
	expect(result.abortReason).toBe("budget");
	expect(result.error).toContain("max_steps_executed");
	expect(result.usage!.stepsExecuted).toBe(1);
	expect(invoked).toBe(false);
});

for (const [cap, usage] of [
	[{ max_llm_tokens_input: 2 }, { llmTokensIn: 3 }],
	[{ max_llm_tokens_output: 2 }, { llmTokensOut: 3 }],
	[{ max_llm_cost_usd: 0.001 }, { llmCostMicros: 1001 }],
] as const) {
	test(`explicit usage enforces ${Object.keys(cap)[0]} without losing reported totals`, async () => {
		const registry = new GraphNodeRegistry();
		const graph = single(registry, ({ recordUsage }) => { recordUsage(usage); return [{ port: "out", value: "must not publish" }]; });
		graph.budget = cap;
		const result = await executeGraph(graph, activation(), registry);
		expect(result.status).toBe("aborted");
		expect(result.abortReason).toBe("budget");
		expect(result.error).toContain(Object.keys(cap)[0]!);
		expect(result.usage).toMatchObject(usage);
		expect(result.nodeRuns[1]!.outputs).toEqual([]);
	});
}

test("usage increments accumulate and equality with token/cost caps is allowed", async () => {
	const registry = new GraphNodeRegistry();
	const graph = single(registry, ({ recordUsage }) => {
		recordUsage({ llmTokensIn: 1, llmTokensOut: 2, llmCostMicros: 10 });
		recordUsage({ llmTokensIn: 2, llmTokensOut: 3, llmCostMicros: 20 });
		return [{ port: "out", value: null }];
	});
	graph.budget = { max_llm_tokens_input: 3, max_llm_tokens_output: 5, max_llm_cost_usd: 0.00003 };
	const result = await executeGraph(graph, activation(), registry);
	expect(result.status).toBe("success");
	expect(result.usage).toEqual({ llmTokensIn: 3, llmTokensOut: 5, llmCostMicros: 30, stepsExecuted: 2 });
	expect(output(result, "operation").result).toEqual({ value: null });
});

test("run deadline aborts a waiting handler and signals it", async () => {
	const registry = new GraphNodeRegistry();
	let observed = false;
	const graph = single(registry, ({ signal }) => new Promise((resolve) => {
		signal.addEventListener("abort", () => { observed = true; resolve([]); }, { once: true });
	}));
	graph.budget = { max_duration_secs: 1 };
	const result = await executeGraph(graph, activation(), registry);
	expect(result.status).toBe("aborted");
	expect(result.abortReason).toBe("budget");
	expect(result.error).toContain("max_duration_secs");
	expect(result.nodeRuns[1]!.status).toBe("aborted");
	expect(observed).toBe(true);
});

test("trace persistence callback failures remain infrastructure errors", async () => {
	const registry = new GraphNodeRegistry();
	const graph = single(registry, () => [{ port: "out", value: 1 }]);
	await expect(executeGraph(graph, activation(), registry, { onNodeRun: () => { throw new Error("trace unavailable"); } })).rejects.toThrow("trace unavailable");
});

test("fan-out then join shares the same source envelope without mistaking it for a cycle", async () => {
	const registry = new GraphNodeRegistry();
	const event = activation();
	register(registry, "left", () => [{ port: "out", value: "left" }]);
	register(registry, "right", () => [{ port: "out", value: true }]);
	register(registry, "join", () => [{ port: "out", value: { joined: true } }], [{ id: "in", type: "object", multiple: true }]);
	const graph: RoutineGraph = { version: 2, nodes: [source(), node("left"), node("right"), node("join")], edges: [edge("left", "source", "left", "event"), edge("right", "source", "right", "event"), edge("join-right", "right", "join"), edge("join-left", "left", "join")] };
	const result = await executeGraph(graph, event, registry);
	const joined = output(result, "join");
	expect(result.status).toBe("success");
	expect(joined.inputs[0]!.inputs[0]).toBe(joined.inputs[1]!.inputs[0]);
	expect(joined.inputs[0]!.inputs[0]!.result).toBe(event.event);
	expect(JSON.parse(JSON.stringify(joined)).inputs[1].inputs[0].result).toEqual(event.event);
});

test("custom event sources with nonmatching event types are skipped without invoking handlers", async () => {
	const registry = new GraphNodeRegistry();
	const called: string[] = [];
	register(registry, "custom-event", ({ node }) => { called.push(node.id); return [{ port: "out", value: { fired: node.id } }]; }, [], undefined, "event");
	const graph: RoutineGraph = { version: 2, nodes: [{ id: "manual", type: "custom-event", config: { eventType: "manual" } }, { id: "webhook", type: "custom-event", config: { eventType: "webhook" } }], edges: [] };
	const result = await executeGraph(graph, activation(), registry);
	expect(called).toEqual(["manual"]);
	expect(result.nodeRuns.map((run) => run.status)).toEqual(["success", "skipped"]);
	expect(result.usage!.stepsExecuted).toBe(1);
});

test("handler failure preceding a queued cancellation remains failed with the handler's error", async () => {
	const registry = new GraphNodeRegistry(), controller = new AbortController();
	const graph = single(registry, () => {
		queueMicrotask(() => controller.abort("later cancellation"));
		throw new Error("first handler failure");
	});
	const result = await executeGraph(graph, activation(), registry, { signal: controller.signal });
	expect(result.status).toBe("failed");
	expect(result.error).toBe("first handler failure");
	expect(result.nodeRuns[1]!.status).toBe("failed");
	expect(result.abortReason).toBeUndefined();
});

test("a later external cancellation cannot overwrite a budget abort", async () => {
	const registry = new GraphNodeRegistry(), controller = new AbortController();
	const graph = single(registry, ({ recordUsage }) => {
		try { recordUsage({ llmTokensIn: 2 }); }
		finally { controller.abort("later cancellation"); }
		return [];
	});
	graph.budget = { max_llm_tokens_input: 1 };
	const result = await executeGraph(graph, activation(), registry, { signal: controller.signal });
	expect(result.status).toBe("aborted");
	expect(result.abortReason).toBe("budget");
	expect(result.error).toContain("max_llm_tokens_input");
});
