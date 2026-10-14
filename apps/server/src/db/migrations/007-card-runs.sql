CREATE TABLE card_runs (
 id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL,
 payload TEXT NOT NULL,
 repository TEXT,
 owned_worktree_path TEXT,
 runtime_path TEXT
);
CREATE INDEX card_runs_task ON card_runs(task_id);
