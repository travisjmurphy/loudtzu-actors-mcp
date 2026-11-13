import { describe, it, expect, vi } from "vitest";
import { buildRunUrl, runActorSync, ApifyError } from "../src/apify.js";

const ok = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("buildRunUrl", () => {
  it("uses run-sync-get-dataset-items with limits as query params", () => {
    const u = new URL(buildRunUrl({ actorId: "loudtzu~walmart-ca-product-search", maxTotalChargeUsd: 0.5, timeoutSecs: 120 }));
    expect(u.origin).toBe("https://api.apify.com");
    expect(u.pathname).toBe("/v2/acts/loudtzu~walmart-ca-product-search/run-sync-get-dataset-items");
    expect(u.searchParams.get("maxTotalChargeUsd")).toBe("0.5");
    expect(u.searchParams.get("timeout")).toBe("120");
    expect(u.searchParams.get("format")).toBe("json");
    expect(u.searchParams.has("token")).toBe(false);
  });
});

describe("runActorSync", () => {
  it("POSTs JSON input with a Bearer token and returns items", async () => {
    const f = ok([{ a: 1 }, { a: 2 }]);
    const items = await runActorSync({ token: "tok", actorId: "x~y", input: { keywords: ["tv"] }, fetchImpl: f as never });
    expect(items).toEqual([{ a: 1 }, { a: 2 }]);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual({ keywords: ["tv"] });
  });

  it("fails clearly without a token and never calls fetch", async () => {
    const f = ok([]);
    await expect(runActorSync({ token: "", actorId: "x~y", input: {}, fetchImpl: f as never })).rejects.toThrow(/APIFY_TOKEN/);
    expect(f).not.toHaveBeenCalled();
  });

  it("explains 408 sync timeouts", async () => {
    await expect(runActorSync({ token: "t", actorId: "x~y", input: {}, fetchImpl: ok({}, 408) as never })).rejects.toThrow(/300-second/);
  });

  it("surfaces Apify error type and message", async () => {
    const f = ok({ error: { type: "token-not-valid", message: "Authentication token is not valid." } }, 401);
    const err = await runActorSync({ token: "bad", actorId: "x~y", input: {}, fetchImpl: f as never }).catch((e) => e);
    expect(err).toBeInstanceOf(ApifyError);
    expect(err.status).toBe(401);
    expect(err.message).toContain("token-not-valid");
  });

  it("rejects non-array JSON", async () => {
    await expect(runActorSync({ token: "t", actorId: "x~y", input: {}, fetchImpl: ok({ foo: 1 }) as never })).rejects.toThrow(/JSON array/);
  });
});
