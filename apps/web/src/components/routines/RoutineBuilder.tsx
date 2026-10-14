/** Canvas-first authoring with deliberate advanced controls and source access. */
import { useEffect, useMemo, useRef, useState } from "react";

import {
	validateRoutineSpec,
	type Routine,
	type RoutineDeckAction,
	type RoutineRun,
	type RoutineSpec,
	type RoutineStep,
	type RoutineTrigger,
	type ValidationError,
} from "@npi-deck/protocol";

import { routinesApi } from "@/lib/routines-api";
import { formatDurationMs } from "@/lib/utils";

import { compileGraph } from "./canvas/graph-compile";
import { RoutineCanvas } from "./canvas/RoutineCanvas";
import { SavePreviewDialog, shouldSkipSavePreview } from "./canvas/SavePreviewDialog";
import { useRunOverlay } from "./canvas/use-run-overlay";
import { AddStepPicker } from "./AddStepPicker";
import { SettingsForm } from "./SettingsForm";
import { StepCard } from "./StepCard";
import { TriggerPicker } from "./TriggerPicker";
import { WebhookSecretPanel } from "./WebhookSecretPanel";
import {
	appendStepRenderKey,
	makeStepRenderKeys,
	moveStepRenderKey,
	reconcileStepRenderKeys,
	removeStepRenderKey,
} from "./step-render-keys";
import {
	type RoutineValidationMessage,
	summarizeRoutineValidationErrors,
} from "./routine-validation";
import {
	emptyV1Spec,
	insertStep,
	moveStep,
	parseSpec,
	removeStep,
	replaceStep,
	replaceTriggers,
	scaffoldStep,
	stringifySpec,
} from "./spec-yaml";

interface Props {
	/** The routine being edited, or `undefined` if we're creating a new V1 routine. */
	routine: Routine | undefined;
	onSaved: (saved: Routine) => void;
	onError: (message: string) => void;
}

type Tab = "steps" | "canvas" | "triggers" | "settings" | "spec";

export function RoutineBuilder({ routine, onSaved, onError }: Props) {
	const legacy = routine !== undefined && routine.specVersion !== 1;
	const initialSpec = useMemo<RoutineSpec>(() => {
		if (routine && routine.specVersion !== 1) {
			return {
				name: routine.name,
				description: routine.description,
				trigger: routine.cron ? [{ cron: routine.cron }] : [{ manual: {} }],
				steps: [routine.actionKind === "prompt"
					? { id: "action", type: "agent", prompt: routine.actionBody }
					: { id: "action", type: "run", command: routine.actionBody, cwd: routine.actionCwd }],
			};
		}
		if (routine?.specYaml) {
			const parsed = parseSpec(routine.specYaml);
			if (parsed.ok && parsed.spec) return parsed.spec;
		}
		return emptyV1Spec();
	}, [routine]);

	const stepKeySeq = useRef(0);
	function nextStepKey(): string {
		const n = stepKeySeq.current;
		stepKeySeq.current += 1;
		return `step-${n}`;
	}
	function makeStepKeys(count: number): string[] {
		return makeStepRenderKeys(count, nextStepKey);
	}
	function reconcileStepKeys(next: RoutineSpec): void {
		setStepKeys((prev) => reconcileStepRenderKeys(prev, next.steps.length, nextStepKey));
	}

	const [spec, setSpec] = useState<RoutineSpec>(initialSpec);
	const persistedSpec = useRef(initialSpec);
	const [stepKeys, setStepKeys] = useState<string[]>(() => makeStepKeys(initialSpec.steps.length));
	const [yamlBuffer, setYamlBuffer] = useState<string>(() =>
		routine?.specYaml ?? stringifySpec(initialSpec),
	);
	const [yamlDirty, setYamlDirty] = useState(false);
	const [yamlError, setYamlError] = useState<string | undefined>();
	const [schemaErrors, setSchemaErrors] = useState<ValidationError[] | undefined>();
	const [tab, setTab] = useState<Tab>("canvas");
	const [advanced, setAdvanced] = useState(false);
	const [legacyCwd, setLegacyCwd] = useState(routine?.actionCwd ?? "");
	const [legacyKind, setLegacyKind] = useState(routine?.actionKind ?? "bash");
	const [busy, setBusy] = useState(false);
	const [enabled, setEnabled] = useState<boolean>(routine?.enabled ?? false);
	const [runs, setRuns] = useState<RoutineRun[]>([]);
	const [showRuns, setShowRuns] = useState(false);
	// T-70: pre-save diff preview state. When non-null, the SavePreviewDialog is
	// open and the contained `specToSave` + `specYaml` are what will be PATCHed
	// or POSTed when the user confirms. Cancelling clears this back to null.
	const [pendingSave, setPendingSave] = useState<{
		specToSave: RoutineSpec;
		specYaml: string;
	} | null>(null);

	// When the parent passes a different routine, reset everything.
	const lastRoutineId = useRef<string | undefined>(routine?.id);
	useEffect(() => {
		if (lastRoutineId.current === routine?.id) return;
		lastRoutineId.current = routine?.id;
		setStepKeys(makeStepKeys(initialSpec.steps.length));
		setSpec(initialSpec);
		persistedSpec.current = initialSpec;
		setYamlBuffer(routine?.specYaml ?? stringifySpec(initialSpec));
		setYamlDirty(false);
		setYamlError(undefined);
		setSchemaErrors(undefined);
		setEnabled(routine?.enabled ?? false);
		setTab("canvas");
		setAdvanced(false);
		setLegacyCwd(routine?.actionCwd ?? "");
		setLegacyKind(routine?.actionKind ?? "bash");
	}, [routine, initialSpec]);

	useEffect(() => {
		if (!routine) return;
		void routinesApi.runs(routine.id, 10).then((r) => setRuns(r.runs));
	}, [routine]);

	// Form -> YAML sync. Step cards use render-only keys that are deliberately
	// separate from editable step ids; otherwise changing `id` remounts the
	// active input and drops focus after every character.
	function updateSpec(next: RoutineSpec, nextStepKeys?: string[]): void {
		if (nextStepKeys) setStepKeys(nextStepKeys);
		else reconcileStepKeys(next);
		setSpec(next);
		setYamlBuffer(stringifySpec(next));
		setYamlDirty(false);
		setYamlError(undefined);
		setSchemaErrors(undefined);
	}
	// YAML -> form sync (debounced via blur; the textarea-onChange just tracks
	// the buffer; we re-parse when the user clicks "Apply" or switches tab).
	function applyYaml(): RoutineSpec | undefined {
		const result = parseSpec(yamlBuffer);
		if (!result.ok) {
			if (result.yamlError) setYamlError(`${result.yamlError.message}${result.yamlError.line ? ` (line ${result.yamlError.line})` : ""}`);
			else setYamlError(undefined);
			if (result.schemaErrors) setSchemaErrors(result.schemaErrors);
			else setSchemaErrors(undefined);
			return undefined;
		}
		const nextSpec = result.spec ?? emptyV1Spec();
		setStepKeys(makeStepKeys(nextSpec.steps.length));
		setSpec(nextSpec);
		setYamlDirty(false);
		setYamlError(undefined);
		setSchemaErrors(undefined);
		return nextSpec;
	}

	function switchTab(next: Tab): void {
		// If leaving the YAML tab with unsaved YAML, try to apply it first; if
		// invalid, keep the user on the YAML tab so they can see the error.
		if (tab === "spec" && yamlDirty && next !== "spec") {
			const ok = applyYaml();
			if (!ok) return;
		}
		setTab(next);
	}

	function toggleAdvanced(): void {
		if (advanced) {
			// Invalid source must be fixed before hiding it or changing views.
			if (tab === "spec" && yamlDirty && !applyYaml()) return;
			setTab("canvas");
		}
		setAdvanced((value) => !value);
	}

	const specValidation = useMemo(() => validateRoutineSpec(spec), [spec]);
	const specValidationMessages = useMemo(
		() => summarizeRoutineValidationErrors(specValidation.errors, spec),
		[specValidation.errors, spec],
	);
	// Compile the canvas graph on every spec change. In the linear short-circuit
	// path (no `layout.edges`), this is the identity function; it only does work
	// when the user has wired explicit edges via the canvas. Errors gate Save
	// and feed the canvas's red-ring overlay + bottom error strip.
	const compile = useMemo(() => legacy ? { steps: spec.steps, errors: [] } : compileGraph(spec), [spec, legacy]);

	// T-71: run-status overlay state. Shared between the canvas (ring colors
	// + badges + last-run picker) and the inspector (per-step output preview
	// in T-72). Subscribes to WS for live updates while the routine runs.
	const runOverlay = useRunOverlay(routine?.id);

	async function save(): Promise<void> {
		if (legacy) {
			await commitSave(spec, "");
			return;
		}
		const currentSpec = yamlDirty ? applyYaml() : spec;
		if (!currentSpec) {
			onError("Source has validation errors. Fix them before saving.");
			return;
		}
		const validation = validateRoutineSpec(currentSpec);
		if (!validation.valid) {
			onError(`Cannot save: ${summarizeRoutineValidationErrors(validation.errors, currentSpec)[0]?.message ?? "Routine is invalid"}`);
			return;
		}
		// An untouched loaded routine keeps its exact authored source and step
		// order; opening the canvas is not an implicit migration or graph edit.
		if (routine?.specYaml && !yamlDirty && currentSpec === persistedSpec.current) {
			await commitSave(currentSpec, routine.specYaml);
			return;
		}
		const finalCompile = compileGraph(currentSpec);
		if (finalCompile.errors.length > 0) {
			const first = finalCompile.errors[0]!;
			onError(`Cannot save: ${first.message}${finalCompile.errors.length > 1 ? ` (+${finalCompile.errors.length - 1} more)` : ""}`);
			return;
		}
		// Apply the topo-sorted step order so the runtime engine walks the graph
		// the user drew. No-op when compile was the identity.
		const specToSave: RoutineSpec = finalCompile.steps === currentSpec.steps
			? currentSpec
			: { ...currentSpec, steps: finalCompile.steps };
		const specYaml = stringifySpec(specToSave);

		// Source review is optional, never part of the normal create/save path.
		const previewable =
			tab === "spec" &&
			!legacy &&
			!shouldSkipSavePreview() &&
			specYaml !== (routine?.specYaml ?? "");
		if (previewable) {
			setPendingSave({ specToSave, specYaml });
			return;
		}
		await commitSave(specToSave, specYaml);
	}

	async function commitSave(specToSave: RoutineSpec, specYaml: string): Promise<void> {
		setBusy(true);
		try {
			if (routine && legacy) {
				const action = specToSave.steps[0]!;
				const cron = specToSave.trigger.find((trigger) => "cron" in trigger);
				const updated = await routinesApi.update(routine.id, {
					name: specToSave.name,
					description: specToSave.description ?? "",
					cron: cron && "cron" in cron ? cron.cron : "",
					actionKind: legacyKind,
					actionBody: action.type === "agent" ? action.prompt : action.type === "run" ? action.command : routine.actionBody,
					actionCwd: legacyCwd,
					enabled,
				});
				onSaved(updated);
			} else if (routine) {
				const updated = await routinesApi.update(routine.id, {
					name: specToSave.name,
					description: specToSave.description ?? "",
					specYaml,
					enabled,
				});
				onSaved(updated);
			} else {
				const created = await routinesApi.create({
					name: specToSave.name,
					description: specToSave.description ?? "",
					// V0 fields are ignored when specYaml is present.
					cron: "",
					actionKind: "bash",
					actionBody: "",
					enabled,
					specYaml,
				});
				onSaved(created);
			}
			setPendingSave(null);
			persistedSpec.current = specToSave;
		} catch (e) {
			onError(String(e));
		} finally {
			setBusy(false);
		}
	}

	async function runNow(): Promise<void> {
		if (!routine) return;
		try {
			await routinesApi.runNow(routine.id);
			await new Promise((r) => setTimeout(r, 600));
			const r = await routinesApi.runs(routine.id, 10);
			setRuns(r.runs);
			setShowRuns(true);
		} catch (e) {
			onError(String(e));
		}
	}

	// ─── Step helpers ───────────────────────────────────────────────────────

	const existingStepIds = spec.steps.map((s) => s.id);
	function onAddStep(type: RoutineStep["type"], presetAction?: RoutineDeckAction): void {
		updateSpec(
			insertStep(spec, scaffoldStep(type, existingStepIds, presetAction)),
			appendStepRenderKey(stepKeys, nextStepKey),
		);
	}
	function onChangeStep(index: number, next: RoutineStep): void {
		updateSpec(replaceStep(spec, index, next), stepKeys);
	}
	function onRemoveStep(index: number): void {
		updateSpec(removeStep(spec, index), removeStepRenderKey(stepKeys, index));
	}
	function onMoveUp(index: number): void {
		const target = Math.max(0, index - 1);
		updateSpec(moveStep(spec, index, target), moveStepRenderKey(stepKeys, index, target));
	}
	function onMoveDown(index: number): void {
		const target = Math.min(spec.steps.length - 1, index + 1);
		updateSpec(moveStep(spec, index, target), moveStepRenderKey(stepKeys, index, target));
	}
	function onChangeTriggers(triggers: RoutineTrigger[]): void {
		updateSpec(replaceTriggers(spec, triggers), stepKeys);
	}

	// ─── Render ────────────────────────────────────────────────────────────

	const legacyAction = spec.steps[0];
	const canSave =
		spec.name.trim().length > 0 &&
		spec.trigger.length > 0 &&
		spec.steps.length > 0 &&
		(legacy
			? (legacyAction?.type === "agent"
				? legacyAction.prompt
				: legacyAction?.type === "run"
					? legacyAction.command
					: routine?.actionBody ?? "").trim().length > 0
			: specValidation.valid) &&
		compile.errors.length === 0 &&
		!busy;

	return (
		<div
			className={
				// T-77: canvas tab claims the full viewport so the graph + inspector
				// can spread out; form tabs stay capped at 5xl for readability.
				tab === "canvas"
					? "flex h-full flex-col overflow-hidden rounded-lg border border-line bg-paper shadow-[0_1px_0_0_rgb(var(--ink)/0.03)]"
					: "mx-auto flex h-full max-w-5xl flex-col overflow-hidden rounded-lg border border-line bg-paper shadow-[0_1px_0_0_rgb(var(--ink)/0.03)]"
			}
		>
			<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
				<label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-ink-2">
					Name
					<input aria-label="Routine name" value={spec.name} onChange={(e) => updateSpec({ ...spec, name: e.target.value })} className="field h-8 min-w-0 flex-1 px-2 text-sm" />
				</label>
				<button type="button" aria-expanded={advanced} onClick={toggleAdvanced} className="btn-ghost h-8 px-2 text-xs">
					{advanced ? "Hide advanced" : "Advanced"}
				</button>
			</div>
			{advanced ? <TabBar tab={tab} onChange={switchTab} stepCount={spec.steps.length} triggerCount={spec.trigger.length} legacy={legacy} /> : null}
			<div
				className={
					tab === "canvas"
						? "flex-1 min-h-0"
						: "flex-1 overflow-y-auto px-3 py-3"
				}
			>
				{tab === "steps" ? (
					<div className="space-y-2">
						{spec.steps.length === 0 ? (
							<div className="rounded border border-dashed border-line bg-paper-2 p-4 text-center text-2xs text-ink-3">
								No steps yet. Pick one to start.
							</div>
						) : (
							spec.steps.map((step, idx) => (
								<StepCard
									key={`${routine?.id ?? "new"}-${stepKeys[idx] ?? idx}`}
									step={step}
									index={idx}
									total={spec.steps.length}
									existingIds={existingStepIds}
									onChange={(n) => onChangeStep(idx, n)}
									onRemove={() => onRemoveStep(idx)}
									onMoveUp={() => onMoveUp(idx)}
									onMoveDown={() => onMoveDown(idx)}
								/>
							))
						)}
						<AddStepPicker onAdd={onAddStep} />
					</div>
				) : null}

				{tab === "canvas" ? (
					<RoutineCanvas
						spec={spec}
						onChange={updateSpec}
						compileErrors={compile.errors}
						routineId={routine?.id}
						runs={runOverlay.runs}
						selectedRunId={runOverlay.selectedRunId}
						onSelectRun={runOverlay.setSelectedRunId}
						stepRunsByStepId={runOverlay.stepRunsByStepId}
						advanced={advanced && !legacy}
						allowAdd={!legacy}
						allowDelete={!legacy}
						allowConnect={!legacy}
					/>
				) : null}

				{tab === "triggers" ? (
					<TriggerPicker triggers={spec.trigger} onChange={onChangeTriggers} />
				) : null}

				{tab === "settings" ? (
					<div className="space-y-3">
						{legacy ? (
							<div className="space-y-3">
								<label className="block text-xs text-ink-2">Description
									<textarea aria-label="Routine description" value={spec.description ?? ""} onChange={(e) => updateSpec({ ...spec, description: e.target.value })} rows={3} className="field mt-1 w-full px-2 py-1" />
								</label>
								<label className="block text-xs text-ink-2">Schedule (cron; empty for on demand)
									<input aria-label="Routine schedule" value={spec.trigger.flatMap((trigger) => "cron" in trigger ? [trigger.cron] : [])[0] ?? ""} onChange={(e) => updateSpec({ ...spec, trigger: e.target.value ? [{ cron: e.target.value }] : [{ manual: {} }] })} className="field mt-1 h-8 w-full px-2" />
								</label>
								<label className="block text-xs text-ink-2">Action
									<select aria-label="Legacy action kind" value={legacyKind} onChange={(e) => {
										const kind = e.target.value as Routine["actionKind"];
										const action = spec.steps[0]!;
										const body = action.type === "agent" ? action.prompt : action.type === "run" ? action.command : "";
										setLegacyKind(kind);
										updateSpec({ ...spec, steps: [kind === "prompt" ? { id: "action", type: "agent", prompt: body } : { id: "action", type: "run", command: body, cwd: action.type === "run" ? action.cwd : legacyCwd }] });
									}} className="field mt-1 h-8 w-full px-2">
										<option value="bash">Shell command</option><option value="script">Script</option><option value="prompt">Ask an agent</option>
									</select>
								</label>
								<label className="block text-xs text-ink-2">Working directory
									<input aria-label="Working directory" value={legacyCwd} onChange={(e) => setLegacyCwd(e.target.value)} className="field mt-1 h-8 w-full px-2" />
								</label>
							</div>
						) : <SettingsForm spec={spec} onChange={updateSpec} />}
						{routine && !legacy ? (
							<WebhookSecretPanel routineId={routine.id} refreshKey={routine.updatedAt} onError={onError} />
						) : null}
					</div>
				) : null}

				{tab === "spec" ? (
					<div className="space-y-2">
						<textarea
							value={yamlBuffer}
							aria-label="Routine source"
							onChange={(e) => {
								setYamlBuffer(e.target.value);
								setYamlDirty(true);
							}}
							rows={28}
							spellCheck={false}
							className="field w-full resize-y px-2 py-1.5 font-mono text-2xs leading-relaxed"
						/>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={applyYaml}
								disabled={!yamlDirty}
								className="btn-ghost h-7 text-2xs disabled:opacity-40"
							>
								Apply to canvas
							</button>
							{yamlDirty ? (
								<span className="font-mono text-2xs text-warn">unsaved YAML edits</span>
							) : null}
						</div>
						{yamlError ? (
							<div className="rounded border border-danger/40 bg-danger/5 px-2 py-1.5 font-mono text-2xs text-danger">
								YAML parse: {yamlError}
							</div>
						) : null}
						{schemaErrors ? (
							<div className="rounded border border-danger/40 bg-danger/5 px-2 py-1.5">
								<div className="meta mb-0.5 text-danger">Schema errors</div>
								<ul className="space-y-0.5 font-mono text-2xs text-danger">
									{schemaErrors.slice(0, 6).map((e, idx) => (
										<li key={idx}>
											{e.path || "/"} — {e.message}
										</li>
									))}
								</ul>
							</div>
						) : null}
					</div>
				) : null}

				{routine && tab !== "canvas" ? (
					<div className="mt-3 border-t border-line pt-2">
						<button
							type="button"
							onClick={() => setShowRuns((s) => !s)}
							className="flex w-full items-center gap-1 text-left font-mono text-2xs text-ink-3 hover:text-ink"
						>
							<span>Recent runs ({runs.length})</span>
							<span className="text-ink-4">{showRuns ? "▾" : "▸"}</span>
						</button>
						{showRuns ? <RunList routine={routine} runs={runs} /> : null}
					</div>
				) : null}
			</div>
			{!legacy && spec.steps.length > 0 && specValidationMessages.length > 0 ? (
				<ValidationSummary messages={specValidationMessages} />
			) : null}
			<Footer
				routine={routine}
				canSave={canSave}
				busy={busy}
				enabled={enabled}
				setEnabled={setEnabled}
				onSave={() => void save()}
				onRunNow={() => void runNow()}
			/>
			{pendingSave ? (
				<SavePreviewDialog
					currentYaml={routine?.specYaml ?? ""}
					newYaml={pendingSave.specYaml}
					busy={busy}
					onCancel={() => {
						if (!busy) setPendingSave(null);
					}}
					onConfirm={() => {
						void commitSave(pendingSave.specToSave, pendingSave.specYaml);
					}}
				/>
			) : null}
		</div>
	);
}

function TabBar({
	tab,
	onChange,
	stepCount,
	triggerCount,
	legacy,
}: {
	tab: Tab;
	onChange: (next: Tab) => void;
	stepCount: number;
	triggerCount: number;
	legacy: boolean;
}) {
	const tabs: ReadonlyArray<{ id: Tab; label: string; badge?: number }> = legacy
		? [{ id: "canvas", label: "Canvas" }, { id: "settings", label: "Options" }]
		: [
			{ id: "canvas", label: "Canvas" },
			{ id: "steps", label: "Steps", badge: stepCount },
			{ id: "triggers", label: "Triggers", badge: triggerCount },
			{ id: "settings", label: "Options" },
			{ id: "spec", label: "View source" },
		];
	return (
		<div className="flex shrink-0 border-b border-line bg-paper">
			{tabs.map((t) => (
				<button
					key={t.id}
					type="button"
					onClick={() => onChange(t.id)}
					className={
						"relative h-9 px-3 text-2xs uppercase tracking-meta " +
						(tab === t.id
							? "text-ink after:absolute after:inset-x-2 after:bottom-0 after:h-px after:bg-accent"
							: "text-ink-3 hover:text-ink")
					}
				>
					{t.label}
					{t.badge !== undefined ? (
						<span className="ml-1.5 rounded bg-paper-2 px-1 font-mono text-2xs text-ink-3">
							{t.badge}
						</span>
					) : null}
				</button>
			))}
		</div>
	);
}
function ValidationSummary({ messages }: { messages: readonly RoutineValidationMessage[] }) {
	return (
		<div className="border-t border-danger/30 bg-danger/5 px-3 py-2">
			<div className="meta mb-1 text-danger">Fix before saving</div>
			<ul className="space-y-0.5 font-mono text-2xs text-danger">
				{messages.slice(0, 4).map((message) => (
					<li key={`${message.path}:${message.message}`}>{message.message}</li>
				))}
			</ul>
		</div>
	);
}

function Footer({
	routine,
	canSave,
	busy,
	enabled,
	setEnabled,
	onSave,
	onRunNow,
}: {
	routine: Routine | undefined;
	canSave: boolean;
	busy: boolean;
	enabled: boolean;
	setEnabled: (v: boolean) => void;
	onSave: () => void;
	onRunNow: () => void;
}) {
	return (
		<div className="flex shrink-0 items-center gap-2 border-t border-line bg-paper px-3 py-2">
			<label className="flex items-center gap-2 text-2xs">
				<input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
				<span>Enabled</span>
			</label>
			<div className="ml-auto flex items-center gap-1.5">
				{routine ? (
					<button type="button" onClick={onRunNow} className="btn-ghost h-7 px-2 text-2xs">
						Run now
					</button>
				) : null}
				<button
					type="button"
					onClick={onSave}
					disabled={!canSave}
					className="btn-primary h-7 px-2 text-2xs disabled:opacity-50"
				>
					{busy ? "Saving..." : routine ? "Save" : "Create"}
				</button>
			</div>
		</div>
	);
}

function RunList({ routine, runs }: { routine: Routine; runs: RoutineRun[] }) {
	return (
		<ul className="mt-2 space-y-1">
			{runs.length === 0 ? (
				<li className="font-mono text-2xs text-ink-3">No runs yet.</li>
			) : (
				runs.map((r) => {
					const dur =
						r.endedAt && r.startedAt
							? new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime()
							: undefined;
					const ok = !r.error && !r.abortReason;
					return (
						<li key={r.id} className="flex items-center gap-2 font-mono text-2xs">
							<span
								className={
									"h-1.5 w-1.5 shrink-0 rounded-full " +
									(r.endedAt || r.abortedAt ? (ok ? "bg-success" : "bg-danger") : "bg-accent")
								}
							/>
							<span className="text-ink-3">{new Date(r.startedAt).toLocaleString()}</span>
							<span className="text-ink-4">{r.trigger}</span>
							{dur !== undefined ? <span className="text-ink-4">{formatDurationMs(dur)}</span> : null}
							{r.abortReason ? <span className="text-warn">{r.abortReason}</span> : null}
							<a
								href={`/routines/${routine.id}/runs/${r.id}`}
								className="ml-auto text-ink-3 underline-offset-2 hover:text-accent hover:underline"
							>
								detail
							</a>
						</li>
					);
				})
			)}
		</ul>
	);
}
