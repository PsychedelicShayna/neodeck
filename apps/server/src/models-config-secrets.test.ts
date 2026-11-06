import { expect, test } from "bun:test";
import { parse } from "smol-toml";
import { maskModelsToml, PlaceholderError, restoreModelsToml } from "./models-config-secrets.ts";

const requireMask = (source: string) => {
 const result = maskModelsToml(source);
 if (!result.ok) throw new Error("Expected unambiguous masking");
 return result;
};

test("native dotted/quoted keys, inline tables and array tables mask and restore comments without reserializing", () => {
 const source = `# header with retired-secret-1234\r
[providers."private.provider"] # provider comment\r
apiKey   = 'sk-native-key-12345'  # key comment\r
baseUrl = "https://gw.test/v1?token=sk-url-token-12345"\r
headers = { "X.Custom" = 'sk-header-token-12345' } # inline table comment\r
requestMetadata.team = "sk-team-token-12345"\r
[[providers."private.provider".models]] # array table comment\r
id = 'model-one'\r
headers."X-Route" = "sk-route-token-12345"\r
[providers."private.provider".modelOverrides."old.model".headers]\r
Override = "sk-override-token-12345"\r
`;
 const mask = requireMask(source);
 for (const value of ["retired-secret-1234", "sk-native-key-12345", "sk-url-token-12345", "sk-header-token-12345", "sk-team-token-12345", "sk-route-token-12345", "sk-override-token-12345", "provider comment", "key comment", "inline table comment", "array table comment"]) expect(mask.masked).not.toContain(value);
 expect(mask.masked).toContain("id = 'model-one'\r\n");
 expect(mask.masked).toContain("apiKey   = ");
 const restored = restoreModelsToml(mask.masked, mask.secrets, mask.comments);
 expect(parse(restored)).toEqual(parse(source));
 for (const comment of ["# header with retired-secret-1234", "# provider comment", "# key comment", "# inline table comment", "# array table comment"]) expect(restored).toContain(`${comment}\r\n`);
 expect(restored).toContain("id = 'model-one'\r\n");
 expect(restored.split("\r\n").length).toBe(source.split("\r\n").length);
});

test("multiline strings containing hash characters are credentials, not comment syntax", () => {
 for (const quote of ['"""', "'''"]) {
  const source = `[providers.test]\napiKey = ${quote}\nsk-multiline-key-12345\n# part-of-credential\n${quote} # actual-comment\nmodels = [{ id = 'plain-model' }]\n`;
  const mask = requireMask(source);
  expect(mask.masked).not.toContain("sk-multiline-key-12345"); expect(mask.masked).not.toContain("part-of-credential"); expect(mask.masked).not.toContain("actual-comment");
  const restored = restoreModelsToml(mask.masked, mask.secrets, mask.comments);
  expect(parse(restored)).toEqual(parse(source)); expect(restored).toContain("# actual-comment\n");
 }
});

test("escaped occurrences and credential-like unknown nested fields never leak", () => {
 const source = '[providers.test]\napiKey = "sk-secret-12345"\nmodels = [{ id = "model", name = "backup sk-secret-12345" }]\n[extra]\nauth_token = "sk-extra-12345"\n';
 const mask = requireMask(source); expect(mask.masked).not.toContain("sk-secret-12345"); expect(mask.masked).not.toContain("sk-extra-12345");
 expect(() => restoreModelsToml(mask.masked, mask.secrets, mask.comments)).toThrow(PlaceholderError);
 const escaped = '[providers.test]\napiKey = "zq9"\nmodels = [{ id = "model-\\u007Aq9" }]\n';
 expect(maskModelsToml(escaped).ok).toBe(false);
 expect(maskModelsToml('[providers.test]\napiKey = "sk-broken-secret-12345\n').ok).toBe(false);
});

test("new raw comments preserve their exact source and forged comments fail closed", () => {
 const mask = requireMask('[providers.test]\napiKey = "sk-native-key-12345" # hidden original\nmodels = [{ id = "model" }]\n');
 const incoming = `${mask.masked}# user supplied  spacing # and symbols\n`;
 expect(restoreModelsToml(incoming, mask.secrets, mask.comments)).toContain("# user supplied  spacing # and symbols\n");
 const forged = incoming.replace(/<npi-deck-comment:[0-9a-f]{16}>/, "<npi-deck-comment:0123456789abcdef>");
 try { restoreModelsToml(forged, mask.secrets, mask.comments); throw new Error("Expected stale comment rejection"); } catch (error) { expect(error).toBeInstanceOf(PlaceholderError); expect((error as PlaceholderError).status).toBe(409); }
});
