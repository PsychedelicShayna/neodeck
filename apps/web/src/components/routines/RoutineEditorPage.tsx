import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { Routine } from "@npi-deck/protocol";

import { routinesApi } from "@/lib/routines-api";
import { RoutineBuilder } from "./RoutineBuilder";

interface Props {
	routine: Routine | "new";
	onSaved: (saved: Routine) => void;
	onDeleted: (id: string) => void;
}

export function RoutineEditorPage({ routine, onSaved, onDeleted }: Props) {
	const [error, setError] = useState<string>();
	const isNew = routine === "new";
	async function remove(): Promise<void> {
		if (routine === "new" || !confirm(`Delete routine "${routine.name}"?`)) return;
		try {
			await routinesApi.remove(routine.id);
			onDeleted(routine.id);
		} catch (e) {
			setError(String(e));
		}
	}
	return (
		<div className="flex h-full min-h-0 flex-col bg-paper">
			<header className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-2">
				<div className="min-w-0 flex-1">
					<h1 className="truncate text-lg font-semibold text-ink">{isNew ? "New routine" : routine.name}</h1>
					<p className="text-xs text-ink-3">{isNew ? "Choose what happens. Arrange it on the canvas." : routine.description}</p>
				</div>
				{!isNew ? <button type="button" onClick={() => void remove()} className="btn-ghost h-8 px-2 text-xs text-danger"><Trash2 className="h-3.5 w-3.5" />Delete</button> : null}
			</header>
			{error ? <div role="alert" className="border-b border-line bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div> : null}
			<div className="min-h-0 flex-1 p-3">
				<RoutineBuilder routine={isNew ? undefined : routine} onSaved={(saved) => { setError(undefined); onSaved(saved); }} onError={setError} />
			</div>
		</div>
	);
}
