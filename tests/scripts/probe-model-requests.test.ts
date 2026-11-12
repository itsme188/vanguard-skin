/**
 * The request-shape probe spends real money, so its guards are pinned
 * without ever calling the API: the run is faked through `deps.run`.
 */
import { describe, it, expect } from "vitest";
import { main, probeWorstCase, SHAPE_SPECS, SHAPES, type ProbeDeps } from "../../scripts/chat-eval/probe-model-requests";
import { priceFor } from "../../scripts/chat-eval/pricing";

function deps(env: Record<string, string | undefined>, run?: ProbeDeps["run"]) {
  const lines: string[] = [];
  const calls: Array<[string, string]> = [];
  const d: ProbeDeps = {
    env,
    print: (l) => lines.push(l),
    run:
      run ??
      (async (shape, model) => {
        calls.push([shape, model]);
        return { verdict: "ACCEPTED", detail: "stop=end_turn in=10 out=5", usd: 0.001 };
      }),
  };
  return { d, lines, calls };
}

describe("probe-model-requests guards", () => {
  it("refuses without --confirm-spend and sends nothing", async () => {
    const { d, lines, calls } = deps({ ANTHROPIC_API_KEY: "sk-test" });
    expect(await main([], d)).toBe(2);
    expect(lines.join("\n")).toMatch(/--confirm-spend/);
    expect(calls).toHaveLength(0);
  });

  it("refuses without a key in the environment", async () => {
    const { d, lines, calls } = deps({});
    expect(await main(["--confirm-spend"], d)).toBe(2);
    expect(lines.join("\n")).toMatch(/ANTHROPIC_API_KEY/);
    expect(calls).toHaveLength(0);
  });

  it("skips every request whose worst case would pass the ceiling", async () => {
    const { d, lines, calls } = deps({ ANTHROPIC_API_KEY: "sk-test" });
    const code = await main(["--confirm-spend", "--max-usd", "0.000001", "--models", "claude-sonnet-5-5"], d);
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(lines.some((l) => l.includes("SKIPPED"))).toBe(true);
  });

  it("books a non-4xx failure at its worst case, so the ceiling still holds", async () => {
    const price = priceFor("claude-sonnet-5-5")!;
    const worst = probeWorstCase(SHAPE_SPECS.extractor, price);
    const { d, calls } = deps({ ANTHROPIC_API_KEY: "sk-test" }, async (shape, model) => {
      calls.push([shape, model]);
      return { verdict: "REJECTED", detail: "no-status unknown_error: socket hang up", usd: 0 };
    });
    // Room for exactly one worst case: the second extractor request must be skipped.
    await main(["--confirm-spend", "--max-usd", String(worst * 1.5), "--models", "claude-sonnet-5-5,claude-sonnet-5-5", "--only", "extractor"], d);
    expect(calls).toHaveLength(1);
  });

  it("names every shape and books web search fees and results", () => {
    expect(SHAPES).toContain("extractor");
    const price = priceFor("claude-opus-5-5")!;
    expect(probeWorstCase(SHAPE_SPECS["web-search-basic"], price)).toBeGreaterThan(
      probeWorstCase({ ...SHAPE_SPECS["web-search-basic"], searches: 0 }, price),
    );
  });

  it("probes the chat's request on a Haiku id too (2026-11-13: a chat can start on Haiku)", () => {
    expect(SHAPES).toContain("chat-haiku");
    expect(SHAPE_SPECS["chat-haiku"].maxTokens).toBe(SHAPE_SPECS.chat.maxTokens);
    expect(SHAPE_SPECS["chat-haiku"].appliesTo("claude-haiku-5-5")).toBe(true);
    expect(SHAPE_SPECS["chat-haiku"].appliesTo("claude-sonnet-5-5")).toBe(false);
    expect(SHAPE_SPECS.chat.appliesTo("claude-haiku-5-5")).toBe(false);
  });
});
