import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { snapshotCardAgentState } from "./card-workspace.ts";
import { parseSettingsToml } from "./settings-toml.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("readonly card snapshots import legacy config once and copy only native TOML", () => {
	const root = mkdtempSync(path.join(tmpdir(), "deck-card-state-")); roots.push(root);
	const source = path.join(root, "source"), target = path.join(root, "target");
	mkdirSync(source);
	const legacy = "extensions:\n  enabled: false\n";
	writeFileSync(path.join(source, "config.yaml"), legacy); chmodSync(path.join(source, "config.yaml"), 0o640);
	writeFileSync(path.join(source, "models.toml"), '[providers.fixture]\nauth = "none"\n');
	writeFileSync(path.join(source, "unrelated.json"), "{}");
	snapshotCardAgentState(source, target);
	expect(readFileSync(path.join(source, "config.yaml"), "utf8")).toBe(legacy);
	expect(parseSettingsToml(readFileSync(path.join(target, "config.toml"), "utf8"))).toEqual({ extensions: { enabled: false } });
	expect(readFileSync(path.join(target, "models.toml"), "utf8")).toBe(readFileSync(path.join(source, "models.toml"), "utf8"));
	expect(statSync(path.join(target, "config.toml")).mode & 0o777).toBe(0o640);
	expect(existsSync(path.join(target, "config.yaml"))).toBe(false);
	expect(existsSync(path.join(target, "unrelated.json"))).toBe(false);
});
