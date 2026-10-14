/**
 * Onboarding routes — drive the first-run wizard's state machine.
 *
 * GET  /api/onboarding/state          → OnboardingState (composite)
 * POST /api/onboarding/complete       → mark done (skipped flag distinguishes
 *                                       walked-through vs X-ed out)
 *
 * Provider auth and KB location updates reuse their existing routes.
 * Knowledge content is authored only by server-scoped project agents.
 */

import { Hono } from "hono";

import type {
	CompleteOnboardingRequest,
	OnboardingState,
} from "@npi-deck/protocol";

import { getOnboardingState, markOnboardingComplete } from "./onboarding-state.ts";

export function buildOnboardingRouter(): Hono {
	const app = new Hono();

	app.get("/state", async (c) => {
		const state: OnboardingState = await getOnboardingState();
		return c.json(state);
	});

	app.post("/complete", async (c) => {
		let body: CompleteOnboardingRequest = { skipped: false };
		try {
			body = (await c.req.json()) as CompleteOnboardingRequest;
		} catch {
			// Empty body is fine — assume non-skipped completion.
		}
		markOnboardingComplete(Boolean(body.skipped));
		const state = await getOnboardingState();
		return c.json(state);
	});

	app.post("/seed-kb-system", c => c.json({ error: "Human KB population is disabled; project agents author scoped project notes" }, 403));

	return app;
}
