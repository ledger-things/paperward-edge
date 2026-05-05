import { describe, it, expect } from "vitest";
import { matchPath, matchAgent } from "@/utils/patterns";

describe("matchPath", () => {
  it("matches exact paths", () => {
    expect(matchPath("/foo", "/foo")).toBe(true);
    expect(matchPath("/foo", "/bar")).toBe(false);
  });

  it('matches "*" against any path', () => {
    expect(matchPath("*", "/anything")).toBe(true);
    expect(matchPath("*", "/")).toBe(true);
  });

  it("matches suffix wildcards", () => {
    expect(matchPath("/articles/*", "/articles/foo")).toBe(true);
    expect(matchPath("/articles/*", "/articles/foo/bar")).toBe(true);
    expect(matchPath("/articles/*", "/articles")).toBe(false);
    expect(matchPath("/articles/*", "/other")).toBe(false);
  });

  it("strips query strings before matching", () => {
    expect(matchPath("/foo", "/foo?bar=baz")).toBe(true);
  });
});

describe("matchAgent", () => {
  it('matches "*" against any agent_id including null', () => {
    expect(matchAgent("*", "signed:openai.com")).toBe(true);
    expect(matchAgent("*", "human")).toBe(true);
    expect(matchAgent("*", null)).toBe(true);
  });

  it("matches signed:* against any signed agent", () => {
    expect(matchAgent("signed:*", "signed:openai.com")).toBe(true);
    expect(matchAgent("signed:*", "signed:perplexity.ai")).toBe(true);
    expect(matchAgent("signed:*", "human")).toBe(false);
    expect(matchAgent("signed:*", "unsigned:gptbot")).toBe(false);
    expect(matchAgent("signed:*", null)).toBe(false);
  });

  it("matches signed:{operator} exactly", () => {
    expect(matchAgent("signed:openai.com", "signed:openai.com")).toBe(true);
    expect(matchAgent("signed:openai.com", "signed:perplexity.ai")).toBe(false);
  });

  it("matches unsigned:* and unsigned:{name}", () => {
    expect(matchAgent("unsigned:*", "unsigned:gptbot")).toBe(true);
    expect(matchAgent("unsigned:*", "human")).toBe(false);
    expect(matchAgent("unsigned:gptbot", "unsigned:gptbot")).toBe(true);
    expect(matchAgent("unsigned:gptbot", "unsigned:claudebot")).toBe(false);
  });

  it("matches human and unknown literally", () => {
    expect(matchAgent("human", "human")).toBe(true);
    expect(matchAgent("human", null)).toBe(false);
    expect(matchAgent("unknown", null)).toBe(true);
    expect(matchAgent("unknown", "human")).toBe(false);
    expect(matchAgent("unknown", "signed:openai.com")).toBe(false);
  });
});
