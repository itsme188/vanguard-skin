/**
 * Workspace card failure handling and privacy (Analysis tab fix wave,
 * 2026-11-15). Source pins: the repo has no DOM test harness.
 *
 * - TrustStrip: a failed load must leave the skeleton and show a plain error
 *   line with a retry, never pulse forever behind an empty catch.
 * - CashDeployCard: the GET is read through `readMutationResult` (status and
 *   envelope checked, non-JSON body tolerated) and a network failure is told
 *   in domain words, never a raw `err.message` ("Unexpected token <").
 * - CashDeployCard: a pick's rationale quotes the sector gap in pp, which the
 *   Gap column masks, so the rationale renders through <PrivateText>.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";

const trust = readFileSync("app/dashboard/components/analysis/TrustStrip.tsx", "utf8");
const cash = readFileSync("app/dashboard/components/analysis/CashDeployCard.tsx", "utf8");

describe("TrustStrip: a failed load is shown, not a skeleton forever", () => {
  const fetchFn = trust.slice(
    anchorIndex(trust, "const fetchState = useCallback"),
    anchorIndex(trust, "}, [scope]);"),
  );

  it("has no empty catch on the trust-state fetch", () => {
    expect(fetchFn).not.toMatch(/catch\(\s*\(\)\s*=>\s*\{\s*(\/\*[^*]*\*\/)?\s*\}\s*\)/);
  });

  it("records an error for a non-success reply and for a network failure", () => {
    expect(fetchFn).toContain("readMutationResult");
    expect(fetchFn).toContain("networkFailureMessage");
    expect(fetchFn).toContain("setLoadError(");
  });

  it("renders the error line with a retry before the skeleton", () => {
    const errIdx = anchorIndex(trust, "if (!state && loadError)");
    const skeletonIdx = anchorIndex(trust, "animate-pulse");
    expect(errIdx).toBeLessThan(skeletonIdx);
    const block = trust.slice(errIdx, skeletonIdx);
    expect(block).toContain("onClick={retry}");
    const retryFn = trust.slice(anchorIndex(trust, "function retry()"), errIdx);
    expect(retryFn).toContain("fetchState()");
    expect(block).toContain("Retry");
  });
});

describe("CashDeployCard: the reply is read safely", () => {
  const runFn = cash.slice(anchorIndex(cash, "async function run()"), anchorIndex(cash, "return (\n"));

  it("reads the response through readMutationResult, never a bare res.json()", () => {
    expect(runFn).toContain("readMutationResult");
    expect(runFn).not.toContain("res.json()");
  });

  it("never renders a raw exception message", () => {
    expect(runFn).not.toContain("e.message");
    expect(runFn).toContain("networkFailureMessage");
  });
});

describe("CashDeployCard: the pick rationale is masked", () => {
  it("wraps p.rationale in <PrivateText>", () => {
    const idx = anchorIndex(cash, "{p.rationale}");
    const around = cash.slice(idx - 40, idx + 40);
    expect(around).toContain("<PrivateText>{p.rationale}</PrivateText>");
  });
});
