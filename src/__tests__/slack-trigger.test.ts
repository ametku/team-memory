import { describe, it, expect } from "vitest";
import { isQualifyingPrompt } from "../slack-trigger.js";

describe("isQualifyingPrompt", () => {
  // --- qualifying ---
  it("qualifies question markers", () => {
    expect(isQualifyingPrompt("why does the payments service timeout")).toBe(true);
    expect(isQualifyingPrompt("how should I handle retries in this service")).toBe(true);
    expect(isQualifyingPrompt("what is the correct way to configure viper here")).toBe(true);
    expect(isQualifyingPrompt("should we use redis or postgres for this cache")).toBe(true);
    expect(isQualifyingPrompt("is there a way to skip the integration step")).toBe(true);
  });

  it("qualifies debugging signals", () => {
    expect(isQualifyingPrompt("getting an error when running the migration script")).toBe(true);
    expect(isQualifyingPrompt("the deploy pipeline is broken again today")).toBe(true);
    expect(isQualifyingPrompt("this keeps crashing on startup with a null reference")).toBe(true);
    expect(isQualifyingPrompt("auth is failing on the staging environment")).toBe(true);
    expect(isQualifyingPrompt("seeing an exception in the webhook handler")).toBe(true);
  });

  it("qualifies architecture and decision signals", () => {
    expect(isQualifyingPrompt("what is the best way to approach this refactor")).toBe(true);
    expect(isQualifyingPrompt("should we use a saga pattern here or two-phase commit")).toBe(true);
    expect(isQualifyingPrompt("help me decide between these two approaches")).toBe(true);
    expect(isQualifyingPrompt("I need to implement the new auth middleware")).toBe(true);
  });

  // --- not qualifying ---
  it("does not qualify short prompts", () => {
    expect(isQualifyingPrompt("fix typo")).toBe(false);
    expect(isQualifyingPrompt("rename this")).toBe(false);
    expect(isQualifyingPrompt("done")).toBe(false);
  });

  it("does not qualify empty or whitespace", () => {
    expect(isQualifyingPrompt("")).toBe(false);
    expect(isQualifyingPrompt("   ")).toBe(false);
  });

  it("does not qualify code-only prompts", () => {
    expect(isQualifyingPrompt("const x = foo.bar.baz()")).toBe(false);
    expect(isQualifyingPrompt("{ id: string; name: string }")).toBe(false);
  });

  it("does not qualify simple edit instructions with no signals", () => {
    expect(isQualifyingPrompt("add a return statement at the end of this function")).toBe(false);
    expect(isQualifyingPrompt("extract this block into a separate file")).toBe(false);
  });
});
