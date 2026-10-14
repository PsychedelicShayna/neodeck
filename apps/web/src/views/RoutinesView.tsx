import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import type { Routine } from "@npi-deck/protocol";

import { Layout } from "@/components/Layout";
import { EditorInspector } from "@/components/routines/EditorInspector";
import { RoutineEditorPage } from "@/components/routines/RoutineEditorPage";
import { routinesApi } from "@/lib/routines-api";
import { cn } from "@/lib/utils";

export function RoutinesView() {
	const [params, setParams] = useSearchParams();
	const target = params.get("edit") ?? "new";
	const [routines, setRoutines] = useState<Routine[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string>();
	const refresh = useCallback(async () => {
		try {
			const result = await routinesApi.list();
			setRoutines(result.routines);
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => { void refresh(); }, [refresh]);

	function open(id: string): void {
		setParams((previous) => {
			const next = new URLSearchParams(previous);
			next.set("edit", id);
			return next;
		});
	}
	function onSaved(saved: Routine): void {
		setRoutines((previous) => [...previous.filter((routine) => routine.id !== saved.id), saved]);
		if (target === "new") open(saved.id);
	}
	function onDeleted(id: string): void {
		setRoutines((previous) => previous.filter((routine) => routine.id !== id));
		open("new");
	}
	const selected = target === "new" ? "new" : routines.find((routine) => routine.id === target);
	const sidebar = (
		<div className="flex h-full flex-col overflow-y-auto">
			<section className="border-b border-line p-3">
				<h2 className="mb-2 text-sm font-semibold text-ink">Routines</h2>
				<button type="button" onClick={() => open("new")} className="btn-primary h-8 w-full text-xs"><Plus className="h-3.5 w-3.5" />New routine</button>
			</section>
			<nav aria-label="Saved routines" className="space-y-1 p-3">
				{loading ? <p className="text-xs text-ink-3">Loading routines...</p> : null}
				{routines.slice().sort((a, b) => a.name.localeCompare(b.name)).map((routine) => (
					<button key={routine.id} type="button" onClick={() => open(routine.id)} aria-current={target === routine.id ? "page" : undefined} className={cn("w-full rounded px-2 py-2 text-left text-sm hover:bg-paper-3", target === routine.id ? "bg-paper-3 text-ink" : "text-ink-2")}>
						<span className="block truncate">{routine.name}</span>
						{routine.description ? <span className="mt-1 block line-clamp-2 text-xs text-ink-3">{routine.description}</span> : null}
					</button>
				))}
			</nav>
			<p className="px-3 text-xs leading-relaxed text-ink-3">Add actions to the canvas, then save and run. Select a saved routine to keep working on it.</p>
		</div>
	);
	const main = (
		<div className="flex h-full min-h-0 flex-col">
			{error ? <div role="alert" className="border-b border-line bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div> : null}
			<div className="min-h-0 flex-1">
				{selected ? <RoutineEditorPage key={target} routine={selected} onSaved={onSaved} onDeleted={onDeleted} /> : <div className="p-6 text-sm text-ink-3">{loading ? "Loading routine..." : "Routine not found. Select a saved routine or create a new one."}</div>}
			</div>
		</div>
	);
	return <Layout sidebar={sidebar} main={main} inspector={<EditorInspector routine={selected === "new" ? undefined : selected} onChange={(updated) => setRoutines((previous) => previous.map((routine) => routine.id === updated.id ? updated : routine))} onDeleted={onDeleted} onError={setError} />} topBar={null} />;
}
