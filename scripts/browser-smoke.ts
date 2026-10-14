#!/usr/bin/env bun
/**
 * Run Chromium/Electron away from the desktop and credential services.
 * bun scripts/browser-smoke.ts --home /tmp/private-smoke --timeout 180 -- \
 *   /absolute/path/to/chrome --user-data-dir=/tmp/private-smoke/profile [args…]
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function fail(message: string): never {
	console.error(`browser-smoke: ${message}`);
	process.exit(1);
}

const args = process.argv.slice(2);
const separator = args.indexOf("--");
if (separator < 0) fail("expected --home DIR --timeout SECONDS -- EXECUTABLE [args]");
let home = "";
let seconds = 180;
for (let index = 0; index < separator; index += 2) {
	const value = args[index + 1];
	if (!value || index + 1 >= separator) fail("missing option value");
	if (args[index] === "--home") home = value;
	else if (args[index] === "--timeout") seconds = Number(value);
	else fail(`unknown option ${args[index]}`);
}
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) fail("timeout must be 1–3600 seconds");
if (!path.isAbsolute(home)) fail("--home must be an absolute private directory");
try { home = realpathSync(home); } catch { fail("--home must already exist"); }
if (home === "/" || home === realpathSync(os.homedir())) fail("refusing the real home or filesystem root");
if (!statSync(home).isDirectory()) fail("--home must be a directory");
if (!home.startsWith(realpathSync(os.tmpdir()) + path.sep)) fail("--home must be a dedicated temporary directory");
const [executable, ...browserArgs] = args.slice(separator + 1);
if (!executable || !path.isAbsolute(executable)) fail("browser executable must be an absolute path");
let profile: string | undefined;
for (let index = 0; index < browserArgs.length; index++) {
	const argument = browserArgs[index]!;
	if (argument === "--password-store" || argument.startsWith("--password-store=")) {
		const value = argument === "--password-store" ? browserArgs[++index] : argument.slice("--password-store=".length);
		if (value !== "basic") fail("only --password-store=basic is allowed");
	}
	if (argument === "--display" || argument.startsWith("--display=")) fail("display overrides are forbidden");
	if (argument === "--user-data-dir" || argument.startsWith("--user-data-dir=")) {
		if (profile !== undefined) fail("duplicate browser profile override");
		profile = argument === "--user-data-dir" ? browserArgs[++index] : argument.slice("--user-data-dir=".length);
	}
}
if (!profile || !path.isAbsolute(profile)) fail("a private absolute --user-data-dir is required");
function privateDirectory(directory: string): string {
	const resolved = path.resolve(directory);
	if (!resolved.startsWith(home + path.sep)) fail("directory must be inside the private home");
	let ancestor = resolved;
	while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
	const canonical = realpathSync(ancestor);
	if (canonical !== home && !canonical.startsWith(home + path.sep)) fail("directory escapes the private home through a symlink");
	mkdirSync(resolved, { recursive: true, mode: 0o700 });
	return realpathSync(resolved);
}
privateDirectory(profile);

// Allowlist rather than inherit: neither the live D-Bus address nor any desktop,
// Wayland, display, credentials or agent configuration can reach the browser.
const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8" };
for (const [key, directory] of Object.entries({
	TMPDIR: "tmp", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data",
	XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state", XDG_RUNTIME_DIR: "runtime",
})) {
	const target = privateDirectory(path.join(home, directory));
	env[key] = target;
}
const child = spawn("timeout", [
	"--foreground", "--signal=TERM", "--kill-after=5s", `${seconds}s`,
	"xvfb-run", "-a", executable, "--password-store=basic", ...browserArgs,
], { env, stdio: "inherit", detached: true });
let stopping = false;
function signalGroup(signal: NodeJS.Signals): void {
	if (!child.pid) return;
	try { process.kill(-child.pid, signal); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
// Crashpad deliberately detaches from Chromium's process group. Only touch
// crash handlers from this browser tree carrying this invocation's private HOME.
function detachedCrashpads(): number[] {
	const browserDirectory = path.dirname(realpathSync(executable));
	const owned: number[] = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
			if (!argv[0] || path.dirname(argv[0]) !== browserDirectory) continue;
			if (path.basename(argv[0]) !== "chrome_crashpad_handler" && !argv.includes("--type=crashpad-handler")) continue;
			if (readFileSync(`/proc/${entry}/environ`, "utf8").split("\0").includes(`HOME=${home}`)) owned.push(Number(entry));
		} catch (error) {
			if (!["ENOENT", "ESRCH", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
	}
	return owned;
}
function signalPid(pid: number, signal: NodeJS.Signals): void {
	try { process.kill(pid, signal); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
async function finish(code: number): Promise<void> {
	if (stopping) return;
	stopping = true;
	const crashpads = detachedCrashpads();
	for (const pid of crashpads) signalPid(pid, "SIGTERM");
	signalGroup("SIGTERM");
	await Bun.sleep(500);
	signalGroup("SIGKILL");
	for (const pid of crashpads) signalPid(pid, "SIGKILL");
	await Bun.sleep(100);
	const survivors = child.pid ? spawnSync("pgrep", ["-a", "-g", String(child.pid)], { env, encoding: "utf8" }) : undefined;
	if ((survivors && survivors.status !== 1) || detachedCrashpads().length > 0) {
		console.error(`browser-smoke: cleanup could not be verified for process group ${child.pid}\n${survivors?.stdout ?? ""}${survivors?.stderr ?? ""}`);
		process.exit(1);
	}
	console.log(`browser-smoke: process group ${child.pid ?? "not started"} and private crash handlers terminated`);
	process.exit(code);
}
child.once("error", (error) => { console.error(`browser-smoke: ${error.message}`); void finish(1); });
child.once("exit", (code, signal) => { void finish(code ?? (signal ? 1 : 0)); });
process.once("SIGINT", () => { void finish(130); });
process.once("SIGTERM", () => { void finish(143); });
