-- Native V2 source of truth. Legacy V0/V1 rows keep NULL and their original formats.
ALTER TABLE routines ADD COLUMN graph_json TEXT;

-- Full immutable executed definition, activation, outputs and recursive provenance.
-- Kept on the existing run row, fetched separately from lightweight run listings.
ALTER TABLE routine_runs ADD COLUMN graph_run_json TEXT;
