import type { GraphNode, GraphNodeType, GraphObject, GraphValue, RoutineGraph } from "./graph";
import type { ValidationError, ValidationResult } from "./validate";

/** Reject values JSON would drop, coerce, invoke, or fail to serialize; shared objects are fine. */
export function isGraphValue(value: unknown): value is GraphValue {
	const ancestors = new Set<object>();
	const stack: { value: unknown; leave?: boolean }[] = [{ value }];
	try {
		while (stack.length) {
			const entry = stack.pop()!;
			const current = entry.value;
			if (entry.leave) { ancestors.delete(current as object); continue; }
			if (current === null || typeof current === "string" || typeof current === "boolean") continue;
			if (typeof current === "number") { if (!Number.isFinite(current)) return false; continue; }
			if (typeof current !== "object" || ancestors.has(current)) return false;
			const array = Array.isArray(current);
			if (array && Object.getPrototypeOf(current) !== Array.prototype) return false;
			if (!array && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) return false;
			const keys = Reflect.ownKeys(current);
			if (array && keys.length !== current.length + 1) return false;
			ancestors.add(current);
			stack.push({ value: current, leave: true });
			for (const key of keys) {
				if (array && key === "length") continue;
				if (typeof key !== "string") return false;
				if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length)) return false;
				const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
				if (!descriptor.enumerable || !("value" in descriptor)) return false;
				stack.push({ value: descriptor.value });
			}
		}
		return true;
	} catch { return false; }
}

function object(value: unknown): value is GraphObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function id(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
const VALUE_TYPES = new Set(["object", "array", "string", "number", "boolean", "null"]);

/** Pure structural/type validation. Config JSON Schemas are enforced by the server registry. */
export function validateRoutineGraph(graph: unknown, nodeTypes: readonly GraphNodeType[]): ValidationResult {
	const errors: ValidationError[] = [];
	const fail = (path: string, keyword: string, message: string) => errors.push({ path, keyword, message, params: {} });
	if (!isGraphValue(graph) || !object(graph)) {
		fail("/", "type", "graph must be a finite, acyclic JSON object");
		return { valid: false, errors };
	}
	const fields = (value: GraphObject, allowed: readonly string[], path: string) => {
		for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}/${key}`, "additionalProperties", "unknown property");
	};
	fields(graph, ["version", "nodes", "edges", "concurrency", "budget", "timezone", "tags", "layout"], "");
	if (graph.version !== 2) fail("/version", "const", "graph version must be 2");
	if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) fail("/nodes", "type", "nodes must be a nonempty array");
	if (!Array.isArray(graph.edges)) fail("/edges", "type", "edges must be an array");
	if (graph.concurrency !== undefined && !["skip", "queue", "cancel-previous", "parallel"].includes(graph.concurrency as string)) fail("/concurrency", "enum", "invalid concurrency policy");
	if (graph.timezone !== undefined) {
		try {
			if (!id(graph.timezone)) throw new Error();
			new Intl.DateTimeFormat("en", { timeZone: graph.timezone });
		} catch { fail("/timezone", "format", "timezone must be an IANA timezone"); }
	}
	if (graph.tags !== undefined && (!Array.isArray(graph.tags) || graph.tags.some((tag) => !id(tag)) || new Set(graph.tags).size !== graph.tags.length)) fail("/tags", "type", "tags must be unique nonempty strings");
	if (graph.budget !== undefined) {
		if (!object(graph.budget)) fail("/budget", "type", "budget must be an object");
		else {
			fields(graph.budget, ["max_duration_secs", "max_llm_cost_usd", "max_llm_tokens_input", "max_llm_tokens_output", "max_steps_executed"], "/budget");
			for (const [key, value] of Object.entries(graph.budget)) {
				const integer = key !== "max_duration_secs" && key !== "max_llm_cost_usd";
				const min = key === "max_duration_secs" || key === "max_steps_executed" ? 1 : 0;
				if (typeof value !== "number" || value < min || (integer && !Number.isInteger(value))) fail(`/budget/${key}`, "minimum", `budget cap must be ${integer ? "an integer" : "a number"} >= ${min}`);
			}
		}
	}
	const types = new Map<string, GraphNodeType>();
	for (const [index, definition] of nodeTypes.entries()) {
		const path = `/nodeTypes/${index}`;
		if (!isGraphValue(definition) || !object(definition) || !id(definition.type) || !id(definition.label) || !["event", "gate", "operation", "action"].includes(definition.kind) || !Array.isArray(definition.inputs) || !Array.isArray(definition.outputs)) {
			fail(path, "type", "invalid node type definition"); continue;
		}
		if (types.has(definition.type)) fail(`${path}/type`, "unique", "duplicate node type");
		types.set(definition.type, definition);
		if (definition.kind === "event" && definition.inputs.length) fail(`${path}/inputs`, "direction", "event sources cannot have input ports");
		if (definition.configSchema !== undefined && !object(definition.configSchema)) fail(`${path}/configSchema`, "type", "config schema must be a JSON object");
		for (const direction of ["inputs", "outputs"] as const) {
			const ports = new Set<string>();
			for (const [portIndex, port] of definition[direction].entries()) {
				if (!object(port) || !id(port.id) || !VALUE_TYPES.has(port.type) || (port.label !== undefined && typeof port.label !== "string") || (port.required !== undefined && typeof port.required !== "boolean") || (port.multiple !== undefined && typeof port.multiple !== "boolean")) fail(`${path}/${direction}/${portIndex}`, "type", "invalid port definition");
				else if (ports.has(port.id)) fail(`${path}/${direction}/${portIndex}/id`, "unique", "duplicate port ID within direction");
				else ports.add(port.id);
			}
		}
	}
	if (errors.some((error) => error.path.startsWith("/nodeTypes/"))) return { valid: false, errors };
	if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return { valid: false, errors };
	const nodes = new Map<string, GraphNode>();
	for (const [index, node] of graph.nodes.entries()) {
		const path = `/nodes/${index}`;
		if (!object(node) || !id(node.id) || !id(node.type) || !object(node.config)) { fail(path, "type", "node requires nonempty id/type and object config"); continue; }
		fields(node, ["id", "type", "config"], path);
		if (nodes.has(node.id)) fail(`${path}/id`, "unique", "duplicate node ID");
		nodes.set(node.id, node as unknown as GraphNode);
		if (!types.has(node.type)) fail(`${path}/type`, "registeredType", `unregistered node type: ${node.type}`);
		if (types.get(node.type)?.kind === "event" && !id(node.config.eventType)) fail(`${path}/config/eventType`, "required", "event sources require a nonempty eventType");
	}
	const edgeIds = new Set<string>();
	const incoming = new Map<string, Map<string, number>>();
	const outgoing = new Map<string, string[]>();
	const indegree = new Map([...nodes.keys()].map((key) => [key, 0]));
	for (const [index, edge] of graph.edges.entries()) {
		const path = `/edges/${index}`;
		if (!object(edge) || !id(edge.id) || !object(edge.from) || !object(edge.to) || !id(edge.from.nodeId) || !id(edge.to.nodeId) || !id(edge.from.port) || !id(edge.to.port)) { fail(path, "type", "edge requires id and named from/to endpoints"); continue; }
		fields(edge, ["id", "from", "to"], path);
		fields(edge.from, ["nodeId", "port"], `${path}/from`);
		fields(edge.to, ["nodeId", "port"], `${path}/to`);
		if (edgeIds.has(edge.id)) fail(`${path}/id`, "unique", "duplicate edge ID");
		edgeIds.add(edge.id);
		const from = nodes.get(edge.from.nodeId), to = nodes.get(edge.to.nodeId);
		if (!from || !to) { fail(path, "crossRef", "edge references a missing node"); continue; }
		const source = types.get(from.type), target = types.get(to.type);
		const fromPort = edge.from.port, toPort = edge.to.port;
		const output = source?.outputs.find((port) => port.id === fromPort);
		const input = target?.inputs.find((port) => port.id === toPort);
		if (!output) fail(`${path}/from/port`, "direction", "endpoint must name an output port");
		if (!input) fail(`${path}/to/port`, "direction", "endpoint must name an input port");
		if (target?.kind === "event") fail(`${path}/to`, "direction", "event sources cannot receive edges");
		if (input && output && input.type !== "object" && input.type !== output.type) fail(path, "portType", `cannot connect ${output.type} output to ${input.type} input`);
		if (input && output?.multiple && !input.multiple) fail(path, "multiple", "multiple-emission output requires a multiple input");
		const counts = incoming.get(to.id) ?? new Map<string, number>();
		counts.set(edge.to.port, (counts.get(edge.to.port) ?? 0) + 1); incoming.set(to.id, counts);
		if (input && !input.multiple && counts.get(input.id)! > 1) fail(`${path}/to`, "multiple", "input port accepts only one connection");
		const targets = outgoing.get(from.id) ?? []; targets.push(to.id); outgoing.set(from.id, targets);
		indegree.set(to.id, indegree.get(to.id)! + 1);
	}
	for (const [index, node] of graph.nodes.entries()) {
		if (!object(node) || !id(node.id) || !id(node.type)) continue;
		const definition = types.get(node.type);
		for (const port of definition?.inputs ?? []) if (port.required !== false && !(incoming.get(node.id)?.get(port.id))) fail(`/nodes/${index}`, "requiredInput", `required input ${port.id} has no connection`);
	}
	const queue = [...nodes.keys()].filter((key) => indegree.get(key) === 0);
	let visited = 0;
	for (let index = 0; index < queue.length; index++) {
		const key = queue[index]!; visited++;
		for (const target of outgoing.get(key) ?? []) { indegree.set(target, indegree.get(target)! - 1); if (indegree.get(target) === 0) queue.push(target); }
	}
	if (visited !== nodes.size) fail("/edges", "cycle", "graph dependencies must be acyclic; iteration uses explicit bounded nodes/subgraphs");
	const reachable = new Set([...nodes.values()].filter((node) => types.get(node.type)?.kind === "event").map((node) => node.id));
	const sources = [...reachable];
	if (!sources.length) fail("/nodes", "eventSource", "graph requires an event source");
	for (let index = 0; index < sources.length; index++) for (const target of outgoing.get(sources[index]!) ?? []) if (!reachable.has(target)) { reachable.add(target); sources.push(target); }
	for (const [index, node] of graph.nodes.entries()) if (object(node) && id(node.id) && !reachable.has(node.id)) fail(`/nodes/${index}`, "reachability", "node is unreachable from any event source");
	if (graph.layout !== undefined) {
		if (!object(graph.layout)) fail("/layout", "type", "layout must be an object");
		else {
			fields(graph.layout, ["nodes"], "/layout");
			if (graph.layout.nodes !== undefined) {
				if (!object(graph.layout.nodes)) fail("/layout/nodes", "type", "layout nodes must be an object");
				else for (const [key, position] of Object.entries(graph.layout.nodes)) {
					if (!nodes.has(key)) fail(`/layout/nodes/${key}`, "crossRef", "layout references a missing node");
					if (!object(position) || typeof position.x !== "number" || typeof position.y !== "number" || (position.collapsed !== undefined && typeof position.collapsed !== "boolean")) fail(`/layout/nodes/${key}`, "type", "layout position requires finite x/y and optional collapsed boolean");
					else fields(position, ["x", "y", "collapsed"], `/layout/nodes/${key}`);
				}
			}
		}
	}
	return errors.length ? { valid: false, errors } : { valid: true };
}
