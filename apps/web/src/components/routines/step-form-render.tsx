/**
 * Shared rendering helpers for routine step forms.
 *
 * Both the form-mode `StepCard` and the canvas-mode `StepInspector` need to:
 *   - tint the type badge consistently (`STEP_TYPE_BG`)
 *   - dispatch on `step.type` to the right per-type form component
 *
 * Exporting both from this module keeps the two surfaces in lockstep: when a
 * new step type lands and the renderer here gets a new `case`, both card and
 * inspector pick it up automatically. Avoiding duplication of the dispatch
 * switch is the load-bearing reason this module exists.
 */

import type { RoutineStep } from "@npi-deck/protocol";
import { Field } from "./form-primitives";

import {
	AgentStepForm,
	DeckStepForm,
	HttpStepForm,
	McpStepForm,
	RunStepForm,
	SetStateStepForm,
	TransformStepForm,
	WaitStepForm,
	WriteStepForm,
} from "./StepForms";

/** Background tint used on the type badge — same palette as `StepNode` so a
 * step authored in form mode and viewed in canvas mode reads identically. */
export const STEP_TYPE_BG: Record<RoutineStep["type"], string> = {
	run: "bg-paper-3",
	agent: "bg-accent/10",
	write: "bg-success/10",
	http: "bg-info/10",
	deck: "bg-accent-soft/60",
	mcp: "bg-warn/10",
	transform: "bg-paper-3",
	wait: "bg-paper-2",
	set_state: "bg-paper-3",
};

/** User-facing action names, independent of the persisted type identifiers. */
export function actionLabel(step: Pick<RoutineStep, "type"> & { action?: string }): string {
	if (step.type === "deck") {
		const names: Record<string, string> = {
			create_inbox_item: "Create inbox item", create_task: "Create card",
			move_task: "Move card", promote_inbox_item_to_task: "Make a card from inbox",
			list_tasks: "Find cards", list_inbox: "Read inbox", get_task: "Read card",
			get_inbox_item: "Read inbox item", kb_orphan_census: "Find unlinked notes",
		};
		return names[step.action ?? ""] ?? "Deck action";
	}
	const names: Record<RoutineStep["type"], string> = {
		run: "Run command", agent: "Ask an agent", write: "Write file",
		http: "Send request", mcp: "Use integration", transform: "Transform data",
		wait: "Wait", set_state: "Remember values", deck: "Deck action",
	};
	return names[step.type];
}

/** Dispatch to the right per-type form for `step`. */
export function renderStepForm(
	step: RoutineStep,
	onChange: (next: RoutineStep) => void,
	advanced = true,
): JSX.Element {
	if (!advanced && ["write", "http", "mcp", "transform", "set_state"].includes(step.type)) {
		return <Field label="Action settings">
			<p className="text-2xs text-ink-3">Turn on Advanced to edit this action's settings.</p>
		</Field>;
	}
	switch (step.type) {
		case "run":
			return <RunStepForm step={step} onChange={onChange} advanced={advanced} />;
		case "agent":
			return <AgentStepForm step={step} onChange={onChange} advanced={advanced} />;
		case "write":
			return <WriteStepForm step={step} onChange={onChange} />;
		case "http":
			return <HttpStepForm step={step} onChange={onChange} />;
		case "deck":
			return <DeckStepForm step={step} onChange={onChange} advanced={advanced} />;
		case "mcp":
			return <McpStepForm step={step} onChange={onChange} />;
		case "transform":
			return <TransformStepForm step={step} onChange={onChange} />;
		case "wait":
			return <WaitStepForm step={step} onChange={onChange} />;
		case "set_state":
			return <SetStateStepForm step={step} onChange={onChange} />;
	}
}
