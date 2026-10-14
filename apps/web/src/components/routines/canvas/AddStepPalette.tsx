/**
 * T-65: categorized add-step palette pinned to the top-left corner of the
 * canvas viewport. Replaces the horizontal-scroll toolbar from T-64 with a
 * single discoverable trigger button + a vertical popover that groups step
 * types into Compute / I/O / Deck Read / Deck Write / File / Control.
 *
 * Discoverability: one button, one click, scannable categories. The popover
 * closes on outside-click and Escape, and each row shows the step's help text
 * inline so the author doesn't have to hover for a tooltip.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";

import type { RoutineDeckAction, RoutineStep } from "@npi-deck/protocol";

import { STEP_CATEGORIES } from "./step-categories";
import { actionLabel } from "../step-form-render";

interface AddStepPaletteProps {
	onAdd: (
		type: RoutineStep["type"],
		presetAction?: RoutineDeckAction,
		presetKind?: "if",
	) => void;
	advanced?: boolean;
}

export function AddStepPalette({ onAdd, advanced = false }: AddStepPaletteProps): JSX.Element {
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement | null>(null);

	// Close on outside click + Escape so the popover behaves like a menu.
	useEffect(() => {
		if (!open) return;
		function onDocPointer(e: MouseEvent | TouchEvent) {
			if (!wrapRef.current) return;
			if (wrapRef.current.contains(e.target as Node)) return;
			setOpen(false);
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") setOpen(false);
		}
		document.addEventListener("mousedown", onDocPointer);
		document.addEventListener("touchstart", onDocPointer);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDocPointer);
			document.removeEventListener("touchstart", onDocPointer);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	function pick(
		type: RoutineStep["type"],
		presetAction?: RoutineDeckAction,
		presetKind?: "if",
	) {
		onAdd(type, presetAction, presetKind);
		setOpen(false);
	}

	return (
		<div
			ref={wrapRef}
			className="pointer-events-auto absolute left-3 top-3 z-20"
			data-testid="add-step-palette"
		>
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label="Add action"
				className="flex h-8 items-center gap-1.5 rounded border border-line bg-paper px-2.5 text-xs text-ink-2 shadow-sm hover:text-ink"
			>
				<Plus className="h-3.5 w-3.5 text-accent" />
				Add action
				<ChevronDown
					className={`h-3 w-3 text-ink-3 transition-transform ${open ? "rotate-180" : ""}`}
				/>
			</button>
			{open ? (
				<div
					role="menu"
					aria-label="Choose an action"
					className="mt-1 max-h-[70vh] w-[320px] overflow-y-auto rounded border border-line bg-paper shadow-xl"
				>
					{STEP_CATEGORIES.filter((cat) => advanced || cat.key !== "io").map((cat, i) => (
						<div
							key={cat.key}
							className={i === 0 ? "" : "border-t border-line"}
						>
							<div className="bg-paper-2/60 px-2.5 pb-1 pt-1.5">
								<div className="font-mono text-2xs uppercase tracking-meta text-ink-3">
									{cat.key === "compute" ? "Commands and agents" : cat.key === "deck-read" ? "Read from the deck" : cat.key === "deck-write" ? "Update the deck" : cat.label}
								</div>
								{advanced ? <div className="text-2xs text-ink-4">{cat.tagline}</div> : null}
							</div>
							<div className="py-1">
								{cat.entries.filter((entry) => advanced || (
									!["transform", "if", "set_state"].includes(entry.key) &&
									!["move_task", "get_task", "get_inbox_item", "promote_inbox_item_to_task"].includes(entry.presetAction ?? "")
								)).map((entry) => (
									<button
										key={entry.key}
										type="button"
										role="menuitem"
										onClick={() => pick(entry.value, entry.presetAction, entry.presetKind)}
										aria-label={`Add ${actionLabel({ type: entry.value, action: entry.presetAction })}`}
										className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left hover:bg-paper-3"
									>
										<span className="text-xs text-ink-2">
											{entry.presetKind === "if" ? "Branch on a condition" : actionLabel({ type: entry.value, action: entry.presetAction })}
										</span>
										{advanced ? <span className="text-2xs leading-snug text-ink-3">{entry.help}</span> : null}
									</button>
								))}
							</div>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
