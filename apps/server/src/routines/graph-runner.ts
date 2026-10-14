import {
	compileStructuredOutputSchema, isGraphValue, validateRoutineGraph,
	type GraphActivation, type GraphEmission, type GraphExecutionResult, type GraphNode,
	type GraphNodeInput, type GraphNodeRun, type GraphNodeType, type GraphOutput,
	type GraphValue, type GraphValueType, type RoutineGraph, type ValidationError, type ValidationResult,
} from "@npi-deck/protocol";
import { checkBudget, newBudgetState } from "./budget.ts";

export interface GraphUsage {
	llmTokensIn?: number;
	llmTokensOut?: number;
	llmCostMicros?: number;
}
export interface GraphNodeContext {
	node: GraphNode;
	inputs: GraphNodeInput[];
	activation: GraphActivation;
	signal: AbortSignal;
	runId: string;
	/** Report each increment once. Caps are checked immediately; never estimate silently. */
	recordUsage(usage: GraphUsage): void;
}
export interface GraphNodeImplementation {
	definition: GraphNodeType;
	execute(context: GraphNodeContext): GraphEmission[] | Promise<GraphEmission[]>;
}
export interface GraphExecutionOptions {
	runId?: string;
	signal?: AbortSignal;
	onNodeRun?: (record: GraphNodeRun) => void | Promise<void>;
}
export class GraphValidationError extends Error {
	constructor(public readonly errors: ValidationError[]) {
		super(`Invalid routine graph: ${errors.map((error) => `${error.path}: ${error.message}`).join("; ")}`);
		this.name = "GraphValidationError";
	}
}

/** One extensible catalogue shared by validation, execution and the HTTP catalogue. */
export class GraphNodeRegistry {
	private readonly implementations = new Map<string, GraphNodeImplementation>();
	private readonly validators = new Map<string, (config: unknown) => ValidationResult>();

	constructor() {
		this.register({
			definition: {
				type: "event.source", label: "Event source", kind: "event", inputs: [],
				outputs: [{ id: "event", type: "object" }],
				configSchema: {
					type: "object", required: ["eventType"],
					properties: { eventType: { type: "string", minLength: 1 }, cron: { type: "string", minLength: 1 } },
					additionalProperties: false,
				},
			},
			execute: ({ node, activation }) => node.config.eventType === activation.eventType
				? [{ port: "event", value: activation.event }] : [],
		});
	}

	register(implementation: GraphNodeImplementation): void {
		const definition = implementation.definition;
		if (typeof implementation.execute !== "function" || !isGraphValue(definition) || !definition || typeof definition.type !== "string" || !definition.type.trim() || typeof definition.label !== "string" || !definition.label.trim() || !["event", "gate", "operation", "action"].includes(definition.kind) || !Array.isArray(definition.inputs) || !Array.isArray(definition.outputs)) throw new Error("Invalid graph node implementation");
		if (this.implementations.has(definition.type)) throw new Error(`Graph node type already registered: ${definition.type}`);
		if (definition.kind === "event" && definition.inputs.length) throw new Error("Event sources cannot have input ports");
		if (definition.configSchema !== undefined && (definition.configSchema === null || typeof definition.configSchema !== "object" || Array.isArray(definition.configSchema))) throw new Error("Config schema must be a JSON object");
		for (const direction of ["inputs", "outputs"] as const) {
			const ids = new Set<string>();
			for (const port of definition[direction]) {
				if (!port || typeof port.id !== "string" || !port.id.trim() || ids.has(port.id) || !["object", "array", "string", "number", "boolean", "null"].includes(port.type) || (port.label !== undefined && typeof port.label !== "string") || (port.required !== undefined && typeof port.required !== "boolean") || (port.multiple !== undefined && typeof port.multiple !== "boolean")) throw new Error(`Invalid ${direction} port for ${definition.type}`);
				ids.add(port.id);
			}
		}
		// Compile before installing: bad schemas must not poison a previously usable registry.
		const validate = definition.configSchema === undefined ? undefined : compileStructuredOutputSchema(definition.configSchema);
		this.implementations.set(definition.type, implementation);
		if (validate) this.validators.set(definition.type, validate);
	}

	get(type: string): GraphNodeImplementation | undefined { return this.implementations.get(type); }
	describe(): GraphNodeType[] { return [...this.implementations.values()].map((implementation) => implementation.definition); }
	validate(graph: unknown): ValidationResult {
		const result = validateRoutineGraph(graph, this.describe());
		if (!result.valid) return result;
		const errors: ValidationError[] = [];
		for (const [index, node] of (graph as RoutineGraph).nodes.entries()) {
			const validation = this.validators.get(node.type)?.(node.config);
			for (const error of validation?.errors ?? []) errors.push({ ...error, path: `/nodes/${index}/config${error.path === "/" ? "" : error.path}` });
		}
		return errors.length ? { valid: false, errors } : { valid: true };
	}
}

function valueMatches(value: GraphValue, type: GraphValueType): boolean {
	if (type === "object") return true;
	if (type === "array") return Array.isArray(value);
	if (type === "null") return value === null;
	return typeof value === type;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Deterministic DAG run; settle absent branches before considering downstream required inputs. */
export async function executeGraph(graph: RoutineGraph, activation: GraphActivation, registry: GraphNodeRegistry, options: GraphExecutionOptions = {}): Promise<GraphExecutionResult> {
	const validation = registry.validate(graph);
	if (!validation.valid) throw new GraphValidationError(validation.errors ?? []);
	if (!isGraphValue(activation) || !activation || Array.isArray(activation) || typeof activation.eventType !== "string" || !activation.eventType.trim() || !activation.event || typeof activation.event !== "object" || Array.isArray(activation.event) || (activation.sourceNodeId !== undefined && (typeof activation.sourceNodeId !== "string" || !graph.nodes.some((node) => node.id === activation.sourceNodeId && registry.get(node.type)!.definition.kind === "event")))) {
		throw new GraphValidationError([{ path: "/activation", keyword: "type", message: "activation requires eventType, an event object, and an existing event source when selected", params: {} }]);
	}
	const nodeRuns: GraphNodeRun[] = [], outputs: GraphOutput[] = [];
	const state = newBudgetState(Date.now);
	const controller = new AbortController();
	let abortReason: "budget" | "cancelled" | undefined;
	let runError: string | undefined;
	let status: GraphExecutionResult["status"] = "success";
	const cancel = () => {
		if (controller.signal.aborted || status === "failed") return;
		abortReason = "cancelled"; runError = message(options.signal?.reason ?? "Graph run cancelled"); controller.abort(options.signal?.reason);
	};
	if (options.signal?.aborted) cancel();
	else options.signal?.addEventListener("abort", cancel, { once: true });
	const abortBudget = (reason: string) => {
		if (controller.signal.aborted || status === "failed") return;
		abortReason = "budget"; runError = reason; controller.abort(new Error(reason));
	};
	const enforceBudget = () => {
		const exceeded = checkBudget(state, graph.budget, Date.now);
		if (exceeded) abortBudget(`Graph budget exceeded: ${exceeded.limit} (${exceeded.value} > ${exceeded.cap})`);
	};
	let deadline: ReturnType<typeof setTimeout> | undefined;
	// Reschedule long deadlines instead of overflowing the platform's signed 32-bit timer.
	const scheduleDeadline = () => {
		const remaining = state.startedAtMs + graph.budget!.max_duration_secs! * 1000 - Date.now();
		if (remaining <= 0) abortBudget("Graph budget exceeded: max_duration_secs");
		else deadline = setTimeout(scheduleDeadline, Math.min(remaining, 2_147_483_647));
	};
	if (graph.budget?.max_duration_secs !== undefined) scheduleDeadline();
	const incoming = new Map<string, RoutineGraph["edges"]>();
	const outgoing = new Map<string, string[]>();
	const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
	for (const edge of graph.edges) {
		const edges = incoming.get(edge.to.nodeId) ?? []; edges.push(edge); incoming.set(edge.to.nodeId, edges);
		const targets = outgoing.get(edge.from.nodeId) ?? []; targets.push(edge.to.nodeId); outgoing.set(edge.from.nodeId, targets);
		indegree.set(edge.to.nodeId, indegree.get(edge.to.nodeId)! + 1);
	}
	const settled = new Map<string, Map<string, GraphOutput[]>>();
	const emittedValues = new Map<GraphOutput, GraphValue>();
	const pending = new Set(graph.nodes.map((node) => node.id));
	const runId = options.runId ?? crypto.randomUUID();
	try {
		while (pending.size) {
			// Graph declaration order breaks ties, independent of handler timing and edge order.
			const node = graph.nodes.find((candidate) => pending.has(candidate.id) && indegree.get(candidate.id) === 0)!;
			pending.delete(node.id);
			const implementation = registry.get(node.type)!;
			const definition = implementation.definition;
			const inputs: GraphNodeInput[] = [];
			for (const edge of incoming.get(node.id) ?? []) for (const output of settled.get(edge.from.nodeId)?.get(edge.from.port) ?? []) inputs.push({ port: edge.to.port, edgeId: edge.id, output });
			const envelopes = inputs.map((input) => input.output);
			const record: GraphNodeRun = { nodeId: node.id, type: node.type, status: "skipped", inputs: envelopes, inputPorts: inputs.map((input) => input.port), outputs: [], endedAt: "" };
			const selected = definition.kind === "event"
				? (activation.sourceNodeId === undefined || activation.sourceNodeId === node.id) && node.config.eventType === activation.eventType
				: inputs.length > 0 && definition.inputs.every((port) => port.required === false || inputs.some((input) => input.port === port.id));
			if (status === "success" && selected) {
				enforceBudget();
				if (!controller.signal.aborted && graph.budget?.max_steps_executed !== undefined && state.stepsExecuted >= graph.budget.max_steps_executed) abortBudget("Graph budget exceeded: max_steps_executed");
				if (controller.signal.aborted) {
					record.status = "aborted"; record.error = runError; status = "aborted";
				} else {
					record.startedAt = new Date().toISOString();
					let active = true;
					try {
						for (const port of definition.inputs) {
							const values = inputs.filter((input) => input.port === port.id);
							if (!port.multiple && values.length > 1) throw new Error(`Input port ${port.id} accepts only one value`);
							for (const input of values) if (!valueMatches(emittedValues.get(input.output)!, port.type)) throw new Error(`Input port ${port.id} expected ${port.type}`);
						}
						const context: GraphNodeContext = {
							node, inputs, activation, signal: controller.signal, runId,
							recordUsage: (usage) => {
								if (!active) throw new Error("Cannot report usage after graph node settled");
								if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw new Error("Invalid graph usage");
								for (const [key, value] of Object.entries(usage)) if (!["llmTokensIn", "llmTokensOut", "llmCostMicros"].includes(key) || typeof value !== "number" || !Number.isFinite(value) || value < 0 || (key !== "llmCostMicros" && !Number.isInteger(value))) throw new Error(`Invalid graph usage: ${key}`);
								if (!Number.isFinite(state.totalTokensIn + (usage.llmTokensIn ?? 0)) || !Number.isFinite(state.totalTokensOut + (usage.llmTokensOut ?? 0)) || !Number.isFinite(state.totalCostMicros + (usage.llmCostMicros ?? 0))) throw new Error("Graph usage totals overflowed");
								state.totalTokensIn += usage.llmTokensIn ?? 0;
								state.totalTokensOut += usage.llmTokensOut ?? 0;
								state.totalCostMicros += usage.llmCostMicros ?? 0;
								enforceBudget();
								controller.signal.throwIfAborted();
							},
						};
						const emissions = await withAbort(() => { state.stepsExecuted++; return implementation.execute(context); }, controller.signal);
						enforceBudget(); controller.signal.throwIfAborted();
						if (!Array.isArray(emissions)) throw new Error("Node must return an array of emissions");
						const counts = new Map<string, number>();
						for (const emission of emissions) {
							if (!emission || typeof emission.port !== "string") throw new Error("Emission requires a named output port");
							const port = definition.outputs.find((candidate) => candidate.id === emission.port);
							if (!port) throw new Error(`Unknown output port: ${emission.port}`);
							if (!isGraphValue(emission.value)) throw new Error(`Output port ${port.id} returned non-JSON, nonfinite or cyclic data`);
							if (!valueMatches(emission.value, port.type)) throw new Error(`Output port ${port.id} expected ${port.type}`);
							counts.set(port.id, (counts.get(port.id) ?? 0) + 1);
							if (!port.multiple && counts.get(port.id)! > 1) throw new Error(`Output port ${port.id} accepts only one emission`);
						}
						// Validate the whole batch before exposing any part of it to consumers.
						for (const emission of emissions) {
							const value = emission.value;
							const output: GraphOutput = { nodeId: node.id, port: emission.port, result: value !== null && typeof value === "object" && !Array.isArray(value) ? value : { value }, inputs: envelopes };
							record.outputs.push(output); emittedValues.set(output, value);
						}
						record.status = "success";
					} catch (error) {
						const cancelled = controller.signal.aborted && error === controller.signal.reason;
						record.status = cancelled ? "aborted" : "failed";
						record.error = cancelled ? runError : message(error);
						status = record.status; runError = record.error;
					} finally { active = false; }
				}
			}
			const ports = new Map<string, GraphOutput[]>();
			for (const output of record.outputs) { const list = ports.get(output.port) ?? []; list.push(output); ports.set(output.port, list); }
			settled.set(node.id, ports);
			outputs.push(...record.outputs);
			record.endedAt = new Date().toISOString(); nodeRuns.push(record);
			await options.onNodeRun?.(record);
			for (const target of outgoing.get(node.id) ?? []) indegree.set(target, indegree.get(target)! - 1);
		}
		if (controller.signal.aborted && status === "success") status = "aborted";
		return { status, nodeRuns, outputs, ...(runError !== undefined ? { error: runError } : {}), ...(status === "aborted" && abortReason ? { abortReason } : {}), usage: { llmTokensIn: state.totalTokensIn, llmTokensOut: state.totalTokensOut, llmCostMicros: state.totalCostMicros, stepsExecuted: state.stepsExecuted } };
	} finally {
		if (deadline !== undefined) clearTimeout(deadline);
		options.signal?.removeEventListener("abort", cancel);
	}
}

function withAbort<T>(execute: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) { reject(signal.reason); return; }
		const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
		signal.addEventListener("abort", abort, { once: true });
		try {
			Promise.resolve(execute()).then(
				(value) => { signal.removeEventListener("abort", abort); resolve(value); },
				(error) => { signal.removeEventListener("abort", abort); reject(error); },
			);
		} catch (error) { signal.removeEventListener("abort", abort); reject(error); }
	});
}

/** Address the envelope itself, e.g. ["inputs", 0, "result", "message"]. Own keys only. */
export function readGraphPath(output: GraphOutput, path: readonly (string | number)[]): GraphValue | undefined {
	let value: unknown = output;
	for (const key of path) {
		if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
		value = (value as Record<string | number, unknown>)[key];
	}
	return value as GraphValue | undefined;
}
/** Find the nearest matching upstream envelope, in stable input order. */
export function findGraphOutput(output: GraphOutput, nodeId: string, port?: string): GraphOutput | undefined {
	const queue = [output], seen = new Set<GraphOutput>();
	for (let index = 0; index < queue.length; index++) {
		const current = queue[index]!;
		if (seen.has(current)) continue;
		seen.add(current);
		if (current.nodeId === nodeId && (port === undefined || current.port === port)) return current;
		queue.push(...current.inputs);
	}
	return undefined;
}
