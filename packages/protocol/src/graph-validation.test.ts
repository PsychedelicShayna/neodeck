import { expect, test } from "bun:test";
import type { GraphNodeType, RoutineGraph } from "./graph";
import { isGraphValue, validateRoutineGraph } from "./graph-validation";

const catalogue: GraphNodeType[] = [
	{ type: "event.source", label: "Source", kind: "event", inputs: [], outputs: [{ id: "event", type: "object" }] },
	{ type: "operation", label: "Operation", kind: "operation", inputs: [{ id: "in", type: "object" }], outputs: [{ id: "out", type: "string" }] },
	{ type: "number", label: "Number", kind: "operation", inputs: [{ id: "in", type: "number" }], outputs: [{ id: "out", type: "number" }] },
];
function graph(): RoutineGraph {
	return { version: 2, nodes: [{ id: "source", type: "event.source", config: { eventType: "manual" } }, { id: "operation", type: "operation", config: {} }], edges: [{ id: "edge", from: { nodeId: "source", port: "event" }, to: { nodeId: "operation", port: "in" } }] };
}

test("object is the universal receiving type; typed outputs still connect to object inputs", () => {
	const value = graph();
	value.nodes.push({ id: "next", type: "operation", config: {} });
	value.edges.push({ id: "typed", from: { nodeId: "operation", port: "out" }, to: { nodeId: "next", port: "in" } });
	expect(validateRoutineGraph(value, catalogue)).toEqual({ valid: true });
});

for (const [label, mutate, keyword] of [
	["version", (value: RoutineGraph) => { (value as { version: number }).version = 1; }, "const"],
	["duplicate node", (value: RoutineGraph) => { value.nodes.push(value.nodes[1]!); }, "unique"],
	["duplicate edge", (value: RoutineGraph) => { value.edges.push(value.edges[0]!); }, "unique"],
	["unregistered type", (value: RoutineGraph) => { value.nodes[1]!.type = "absent"; }, "registeredType"],
	["missing node", (value: RoutineGraph) => { value.edges[0]!.from.nodeId = "absent"; }, "crossRef"],
	["wrong endpoint direction", (value: RoutineGraph) => { value.edges[0]!.from.port = "in"; }, "direction"],
	["missing required input", (value: RoutineGraph) => { value.edges = []; }, "requiredInput"],
	["singular input with two edges", (value: RoutineGraph) => { value.edges.push({ ...value.edges[0]!, id: "second" }); }, "multiple"],
	["object output to narrow input", (value: RoutineGraph) => { value.nodes[1]!.type = "number"; }, "portType"],
	["event receiving input", (value: RoutineGraph) => { value.edges[0]!.to.nodeId = "source"; value.edges[0]!.to.port = "event"; }, "direction"],
	["cycle", (value: RoutineGraph) => { value.edges.push({ id: "cycle", from: { nodeId: "operation", port: "out" }, to: { nodeId: "operation", port: "in" } }); }, "cycle"],
	["unreachable node", (value: RoutineGraph) => { value.nodes.push({ id: "isolated", type: "operation", config: {} }); }, "reachability"],
	["layout missing node", (value: RoutineGraph) => { value.layout = { nodes: { missing: { x: 0, y: 1 } } }; }, "crossRef"],
	["negative token cap", (value: RoutineGraph) => { value.budget = { max_llm_tokens_input: -1 }; }, "minimum"],
	["fractional step cap", (value: RoutineGraph) => { value.budget = { max_steps_executed: 1.5 }; }, "minimum"],
	["invalid timezone", (value: RoutineGraph) => { value.timezone = "No/SuchZone"; }, "format"],
] as const) {
	test(`rejects ${label}`, () => {
		const value = graph(); mutate(value);
		const result = validateRoutineGraph(value, catalogue);
		expect(result.valid).toBe(false);
		expect(result.errors!.some((error) => error.keyword === keyword)).toBe(true);
	});
}

test("port IDs must be unique within their input/output direction", () => {
	const bad = [...catalogue, { type: "duplicate", label: "Duplicate", kind: "operation" as const, inputs: [{ id: "in", type: "object" as const }, { id: "in", type: "object" as const }], outputs: [] }];
	const result = validateRoutineGraph(graph(), bad);
	expect(result.valid).toBe(false);
	expect(result.errors!.some((error) => error.path.endsWith("/inputs/1/id") && error.keyword === "unique")).toBe(true);
});

test("multiple-emission output requires multiple input", () => {
	const types = catalogue.map((definition) => definition.type === "event.source" ? { ...definition, outputs: [{ id: "event", type: "object" as const, multiple: true }] } : definition);
	expect(validateRoutineGraph(graph(), types).errors!.some((error) => error.keyword === "multiple")).toBe(true);
	const accepting = types.map((definition) => definition.type === "operation" ? { ...definition, inputs: [{ id: "in", type: "object" as const, multiple: true }] } : definition);
	expect(validateRoutineGraph(graph(), accepting)).toEqual({ valid: true });
});

test("optional input does not need a connection when another port makes the node reachable", () => {
	const types = catalogue.map((definition) => definition.type === "operation" ? { ...definition, inputs: [...definition.inputs, { id: "optional", type: "number" as const, required: false }] } : definition);
	expect(validateRoutineGraph(graph(), types)).toEqual({ valid: true });
});

test("malformed JSON shapes fail cleanly rather than reaching reference validation", () => {
	for (const value of [null, [], { version: 2, nodes: null, edges: [] }, { version: 2, nodes: [null], edges: [false] }, { ...graph(), nodes: [{ id: "source", type: "event.source", config: [] }] }]) {
		expect(validateRoutineGraph(value, catalogue).valid).toBe(false);
	}
	expect(validateRoutineGraph(graph(), [null as unknown as GraphNodeType]).valid).toBe(false);
});

test("JSON guard accepts shared immutable references but rejects serialization-loss values", () => {
	const shared = Object.freeze({ retained: [1, "x", false, null] });
	expect(isGraphValue({ first: shared, second: shared })).toBe(true);
	const cycle: Record<string, unknown> = {}; cycle.self = cycle;
	const sparse = new Array(2); sparse[1] = 1;
	const hidden = Object.defineProperty({}, "hidden", { value: 1, enumerable: false });
	const accessor = Object.defineProperty({}, "value", { get: () => { throw new Error("must not invoke getter"); }, enumerable: true });
	const symbol = { [Symbol("hidden")]: 1 };
	for (const invalid of [undefined, NaN, Infinity, 1n, () => 1, new Date(0), new Map(), cycle, sparse, hidden, accessor, symbol, { dropped: undefined }]) expect(isGraphValue(invalid)).toBe(false);
});
