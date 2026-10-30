// T26 body reader 验收：1MB 限（413）、Content-Type 校验（415）、坏 JSON（400）、正常解析。
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import { Router, readJsonBody } from "./index.js";
import { sendJson } from "./respond.js";

const TOKENS: readonly string[] = ["tok-body"];

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  const router = new Router({ tokens: TOKENS });
  router.add("POST", "/echo", async (req, res) => {
    const body = await readJsonBody(req);
    sendJson(res, 200, { echoed: body ?? null });
  });

  server = createServer(router.toRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "X-Loom-Token": "tok-body", ...extra };
}

describe("loom json body reader (T26)", () => {
  it("parses a valid JSON body", async () => {
    const res = await fetch(`${baseUrl}/echo`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echoed: { hello: "world" } });
  });

  it("treats an empty body as undefined", async () => {
    const res = await fetch(`${baseUrl}/echo`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echoed: null });
  });

  it("rejects non-JSON content type with 415", async () => {
    const res = await fetch(`${baseUrl}/echo`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "text/plain" }),
      body: "hello",
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("unsupported_media_type");
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await fetch(`${baseUrl}/echo`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("bad_json");
  });

  it("rejects >1MB body with 413", async () => {
    const big = "x".repeat(1024 * 1024 + 16);
    const res = await fetch(`${baseUrl}/echo`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ data: big }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("payload_too_large");
  });
});
