/**
 * /api/kb — read-only vault navigation and authenticated agent authoring.
 *
 * Write authority comes from the active server-bound agent capability,
 * never from owner cookies or a project claimed by the request.
 */

import { Hono } from "hono";

import { logger } from "./log.ts";
import type { KbService } from "./kb-service.ts";
import { readKb, writeKb, type KbAgentIdentity, type KbReadRequest, type KbWriteRequest } from "./kb-workflows.ts";

const log = logger("routes:kb");

export function buildKbRouter(service: KbService, options: {
	resolveAgent?: (token: string) => KbAgentIdentity | undefined;
} = {}): Hono {
	const app = new Hono();
	for (const operation of ["read", "write"] as const) {
		app.post(`/kb/agent/${operation}`, async c => {
			const match = /^Bearer (\S+)$/.exec(c.req.header("Authorization") ?? "");
			const identity = match ? options.resolveAgent?.(match[1]!) : undefined;
			if (!identity) return c.json({ error: "Active agent capability required" }, 401);
			try {
				const body = await c.req.json();
				if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Invalid request" }, 400);
				const allowed = operation === "read" ? ["operation", "path", "query", "limit"] : ["path", "content", "mode", "kind", "captureId"];
				if (Object.keys(body).some(key => !allowed.includes(key))) return c.json({ error: "Unknown request field" }, 400);
				const result = operation === "read"
					? await readKb(service, body as KbReadRequest)
					: await writeKb(service, identity, body as KbWriteRequest);
				return c.json(result);
			} catch (err) {
				return c.json({ error: String(err) }, operation === "write" ? 403 : 400);
			}
		});
	}
	app.get("/kb/links", async c => {
		const result = await service.getLinks(c.req.query("path") ?? "");
		return result ? c.json(result) : c.json({ error: "not found" }, 404);
	});

	app.get("/kb/tree", async (c) => {
		const subpath = c.req.query("path") ?? "";
		try {
			const body = await service.getTree(subpath);
			if (!body) return c.json({ error: "not found" }, 404);
			return c.json(body);
		} catch (err) {
			log.error(`getTree failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/kb/file", async (c) => {
		const subpath = c.req.query("path");
		if (!subpath) return c.json({ error: "path required" }, 400);
		try {
			const body = await service.getFile(subpath);
			if (!body) return c.json({ error: "not found" }, 404);
			return c.json(body);
		} catch (err) {
			log.error(`getFile failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	// Mutations require a server-bound agent capability, never owner-cookie or claimed project.
	app.put("/kb/file", c => c.json({ error: "Use an authenticated project agent's kb_write tool" }, 403));
	app.post("/kb/file", c => c.json({ error: "Use an authenticated project agent's kb_write tool" }, 403));

	app.get("/kb/graph", async (c) => {
		try {
			const body = await service.getGraph();
			return c.json(body);
		} catch (err) {
			log.error(`getGraph failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/kb/backlinks", async (c) => {
		const subpath = c.req.query("path");
		if (!subpath) return c.json({ error: "path required" }, 400);
		try {
			const body = await service.getBacklinks(subpath);
			if (!body) return c.json({ error: "not found" }, 404);
			return c.json(body);
		} catch (err) {
			log.error(`getBacklinks failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/kb/search", async (c) => {
		const q = c.req.query("q") ?? "";
		const limitRaw = c.req.query("limit");
		const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
		try {
			const body = await service.search(q, Number.isFinite(limit) ? limit : 20);
			return c.json(body);
		} catch (err) {
			log.error(`search failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/kb/status", async (c) => {
		try {
			const body = await service.getStatus();
			return c.json(body);
		} catch (err) {
			log.error(`getStatus failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/kb/init", c => c.json({ error: "Human KB population is disabled; project agents author scoped project notes" }, 403));

	return app;
}

