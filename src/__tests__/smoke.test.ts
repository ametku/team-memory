import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const CLI_PATH = resolve(import.meta.dirname, "../../dist/cli.js");

describe("team-memory CLI", () => {
  it("prints usage on --help", () => {
    const output = execFileSync("node", [CLI_PATH, "--help"], {
      encoding: "utf-8",
    });
    expect(output).toContain("team-memory");
    expect(output).toContain("Commands:");
  });

  it("prints version on --version", () => {
    const output = execFileSync("node", [CLI_PATH, "--version"], {
      encoding: "utf-8",
    });
    expect(output.trim()).toBe("0.1.0");
  });

  it("exits with code 1 on unknown command", () => {
    expect(() =>
      execFileSync("node", [CLI_PATH, "nonexistent"], { encoding: "utf-8" })
    ).toThrow();
  });
});
