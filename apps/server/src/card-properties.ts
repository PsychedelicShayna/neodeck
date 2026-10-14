import { parseDocument, isMap, isScalar, stringify } from "yaml";

/** Card.body is the canonical property store. Routing never comes from YAML. */
export function cardFrontmatter(body: string): { properties: Record<string, unknown>; content: string; header?: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
	if (!match) return { properties: {}, content: body };
	const doc = parseDocument(match[1]!);
	if (doc.errors.length || (doc.contents && !isMap(doc.contents))) throw new Error("Card front matter must be a valid YAML mapping");
	return { properties: (doc.toJSON() ?? {}) as Record<string, unknown>, content: body.slice(match[0].length), header: match[1] };
}

/** No properties supplied means raw leading YAML (including comments) is untouched. */
export function withCardProperties(body: string, properties?: Record<string, unknown>): string {
	if (properties === undefined) return body;
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) throw new Error("properties must be an object");
	const entries = Object.entries(properties);
	if (!entries.length) return body;
	const parsed = cardFrontmatter(body);
	let header = parsed.header === undefined ? "" : parsed.header + "\n";
	const doc = parseDocument(header);
	const replacements: Array<{ start: number; end: number; text: string }> = [];
	for (const [key, value] of entries) {
		const pair = isMap(doc.contents) ? doc.contents.items.find(item => isScalar(item.key) && item.key.value === key) : undefined;
		const start = isScalar(pair?.key) ? pair.key.range?.[0] : undefined;
		const end = pair?.value && "range" in pair.value ? pair.value.range?.[2] : undefined;
		const replacement = stringify({ [key]: value });
		if (start !== undefined && end !== undefined) replacements.push({ start, end, text: replacement });
		else header += replacement;
	}
	for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
		header = header.slice(0, replacement.start) + replacement.text + header.slice(replacement.end);
	}
	return `---\n${header}---\n${parsed.content}`;
}

export function cardExecutionProperties(body: string): { readOnly: boolean; worktree?: string; model?: string; role?: string } {
	const { properties } = cardFrontmatter(body);
	const readonly = properties["read-only"];
	if (readonly !== undefined && typeof readonly !== "boolean") throw new Error("read-only must be a boolean");
	const strings: Record<string, string> = {};
	for (const key of ["worktree", "model", "role"]) {
		const value = properties[key];
		if (value !== undefined) {
			if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a nonempty string`);
			strings[key] = value.trim();
		}
	}
	return { readOnly: readonly === true, ...strings };
}
