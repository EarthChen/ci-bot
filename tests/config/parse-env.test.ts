import { describe, it, expect } from "vitest";
import { parseEnvFile } from "../../src/config/index.js";

describe("parseEnvFile", () => {
  it("parses simple KEY=value pairs", () => {
    expect(parseEnvFile("FOO=bar\nBAZ=qux")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores blank lines and # comments", () => {
    expect(
      parseEnvFile("# header\n\nFOO=bar\n# trailing\n"),
    ).toEqual({ FOO: "bar" });
  });

  it("strips matching single or double quotes around values", () => {
    expect(parseEnvFile('A="hello"\nB=\'world\'')).toEqual({
      A: "hello",
      B: "world",
    });
  });

  it("does not strip quotes when unbalanced (opaque blob preserved)", () => {
    expect(parseEnvFile('A="unterminated')).toEqual({ A: '"unterminated' });
  });

  it("supports optional `export ` prefix", () => {
    expect(parseEnvFile("export FOO=bar")).toEqual({ FOO: "bar" });
  });

  it("skips lines without an = sign", () => {
    expect(parseEnvFile("NOEQUALSHERE\nFOO=bar")).toEqual({ FOO: "bar" });
  });
});
