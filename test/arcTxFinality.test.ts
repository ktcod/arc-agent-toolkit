import { describe, it, expect } from "vitest";
import { classify } from "../src/tools/arcTxFinality.js";

const heads = { latest: 1000, safe: 990, finalized: 980 };

describe("finality classification", () => {
  it("reports finalized at or below the finalized head", () => {
    expect(classify(980, false, heads)).toBe("finalized");
    expect(classify(500, false, heads)).toBe("finalized");
  });

  it("reports safe between the safe and finalized heads", () => {
    expect(classify(985, false, heads)).toBe("safe");
    expect(classify(990, false, heads)).toBe("safe");
  });

  it("reports included above the safe head", () => {
    expect(classify(999, false, heads)).toBe("included");
  });

  it("distinguishes a mempool transaction from one nobody has seen", () => {
    expect(classify(null, true, heads)).toBe("pending");
    expect(classify(null, false, heads)).toBe("unknown");
  });

  it("degrades to included when the node exposes no safe or finalized head", () => {
    // Never claim finality we cannot prove.
    expect(classify(900, false, { latest: 1000, safe: null, finalized: null })).toBe("included");
  });
});
