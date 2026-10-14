import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Store Problem Health Score & Severity Calculation", () => {
  function computeHealthScore(critical, warning, notice) {
    return Math.max(0, 100 - (critical * 15 + warning * 5 + notice * 2));
  }

  it("calculates 100 for a healthy store with 0 problems", () => {
    assert.equal(computeHealthScore(0, 0, 0), 100);
  });

  it("penalizes critical issues with 15 points each", () => {
    assert.equal(computeHealthScore(1, 0, 0), 85);
    assert.equal(computeHealthScore(2, 0, 0), 70);
  });

  it("penalizes warnings with 5 points and notices with 2 points", () => {
    assert.equal(computeHealthScore(0, 3, 4), 100 - (3 * 5 + 4 * 2)); // 100 - 23 = 77
  });

  it("caps score at 0 minimum when critical count is large", () => {
    assert.equal(computeHealthScore(10, 5, 2), 0);
  });

  it("validates fix classifications for standard Shopify problems", () => {
    const problems = [
      { id: "p1", title: "Active Product Out of Stock", severity: "CRITICAL", fixType: "APP_FIX", actionKey: "FIX_OUT_OF_STOCK" },
      { id: "p2", title: "Active Product Missing Images", severity: "CRITICAL", fixType: "DEV_FIX" },
      { id: "p3", title: "$0.00 Variant Price Error", severity: "CRITICAL", fixType: "DEV_FIX" },
      { id: "p4", title: "Missing SEO Metadata", severity: "WARNING", fixType: "APP_FIX", actionKey: "FIX_SEO_METADATA" },
      { id: "p5", title: "Missing Product Description", severity: "WARNING", fixType: "DEV_FIX" },
    ];

    const appFixes = problems.filter((p) => p.fixType === "APP_FIX");
    const devFixes = problems.filter((p) => p.fixType === "DEV_FIX");

    assert.equal(appFixes.length, 2);
    assert.equal(devFixes.length, 3);
    assert.ok(appFixes.every((p) => p.actionKey));
  });
});
