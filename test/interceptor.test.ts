import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    send = send;
  },
  GetSecretValueCommand: class {
    constructor(public input: unknown) {}
  },
}));

const event = (headers?: Record<string, string>) => ({
  interceptorInputVersion: "1.0",
  mcp: { gatewayRequest: { headers, body: { jsonrpc: "2.0", id: 7, method: "tools/list" } } },
});

describe("api-key interceptor", () => {
  beforeEach(() => {
    vi.resetModules();
    send.mockReset().mockResolvedValue({ SecretString: "key-one, key-two" });
  });

  it("parseKeys splits comma-separated keys and drops blanks", async () => {
    const { parseKeys } = await import("../lambda/api-key-interceptor/index");
    expect(parseKeys(" a ,b,, ")).toEqual(["a", "b"]);
  });

  it("extractKey prefers Bearer token and is case-insensitive on header names", async () => {
    const { extractKey } = await import("../lambda/api-key-interceptor/index");
    expect(extractKey({ authorization: "bearer abc" })).toBe("abc");
    expect(extractKey({ Authorization: "Bearer abc", "X-Api-Key": "xyz" })).toBe("abc");
    expect(extractKey({ "X-API-KEY": "xyz" })).toBe("xyz");
    expect(extractKey({ Authorization: "Basic Zm9v" })).toBeUndefined();
    expect(extractKey(undefined)).toBeUndefined();
  });

  it("isValidKey matches only exact keys", async () => {
    const { isValidKey } = await import("../lambda/api-key-interceptor/index");
    expect(isValidKey("key-two", ["key-one", "key-two"])).toBe(true);
    expect(isValidKey("key-tw", ["key-one", "key-two"])).toBe(false);
    expect(isValidKey(undefined, ["key-one"])).toBe(false);
    expect(isValidKey("x", [])).toBe(false);
  });

  it("passes the request body through when the key is valid", async () => {
    const { handler } = await import("../lambda/api-key-interceptor/index");
    const res = await handler(event({ Authorization: "Bearer key-two" }));
    expect(res).toEqual({
      interceptorOutputVersion: "1.0",
      mcp: { transformedGatewayRequest: { body: { jsonrpc: "2.0", id: 7, method: "tools/list" } } },
    });
  });

  it("returns 401 with a JSON-RPC error when the key is missing or wrong", async () => {
    const { handler } = await import("../lambda/api-key-interceptor/index");
    for (const headers of [undefined, { "x-api-key": "nope" }]) {
      const res = await handler(event(headers));
      expect(res.mcp).toMatchObject({
        transformedGatewayResponse: { statusCode: 401, body: { jsonrpc: "2.0", id: 7, error: { code: -32001 } } },
      });
    }
  });

  it("caches the secret between invocations", async () => {
    const { handler } = await import("../lambda/api-key-interceptor/index");
    await handler(event({ "x-api-key": "key-one" }));
    await handler(event({ "x-api-key": "key-one" }));
    expect(send).toHaveBeenCalledTimes(1);
  });
});
