// T26 验收：404 未知路由 / 401 无 token / 200 带 token（+ :param、405、鉴权先于匹配、SSE、body reader）。
// 全部用 ephemeral 端口（listen 0），每个测试内关闭 server，防句柄泄漏。
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import { Router, startSseStream, writeSseFrame } from "./index.js";

const GOOD_TOKEN = "tok-good";
const TOKENS: readonly string[] = [GOOD_TOKEN, "tok-other"];

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  const router = new Router({ tokens: TOKENS });
  router.add("GET", "/ping", (_req, res, ctx) => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, token: ctx.token }));
  });
  router.add("GET", "/sessions/:id/messages", (_req, res, ctx) => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ id: ctx.params["id"] ?? null }));
  });
  router.add("POST", "/sessions", (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ created: true }));
  });
  router.add("GET", "/stream", (_req, res) => {
    startSseStream(res);
    writeSseFrame(res, { payload: { type: "session.idle", properties: { sessionID: "s_1" } } });
    res.end();
  });
  router.add("GET", "/boom", () => {
    throw new Error("handler exploded");
  });

  server = createServer(router.toRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  expect(addr.port).toBeGreaterThanOrEqual(1); // listen(0) 由内核分配 ephemeral
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe("loom http router (T26)", () => {
  it("returns 401 with JSON error body when no token header", async () => {
    const res = await fetch(`${baseUrl}/ping`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("unauthorized");
  });

  it("returns 401 when token is invalid", async () => {
    const res = await fetch(`${baseUrl}/ping`, { headers: { Authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  it("returns 200 with Bearer token and exposes it on ctx", async () => {
    const res = await fetch(`${baseUrl}/ping`, { headers: { Authorization: `Bearer ${GOOD_TOKEN}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; token: string };
    expect(body.ok).toBe(true);
    expect(body.token).toBe(GOOD_TOKEN);
  });

  it("accepts X-Loom-Token header as an alternative", async () => {
    const res = await fetch(`${baseUrl}/ping`, { headers: { "X-Loom-Token": GOOD_TOKEN } });
    expect(res.status).toBe(200);
  });

  it("returns 404 JSON for unknown route even with token", async () => {
    const res = await fetch(`${baseUrl}/nope`, { headers: { "X-Loom-Token": GOOD_TOKEN } });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("not_found");
  });

  it("auth runs before matching: unknown path without token is 401 not 404", async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(401);
  });

  it("captures :param segments", async () => {
    const res = await fetch(`${baseUrl}/sessions/sess_42/messages`, { headers: { "X-Loom-Token": GOOD_TOKEN } });
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual({ id: "sess_42" });
  });

  it("returns 405 when path matches but method does not", async () => {
    const res = await fetch(`${baseUrl}/ping`, {
      method: "DELETE",
      headers: { "X-Loom-Token": GOOD_TOKEN },
    });
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("method_not_allowed");
  });

  it("handler throw maps to 500 JSON", async () => {
    const res = await fetch(`${baseUrl}/boom`, { headers: { "X-Loom-Token": GOOD_TOKEN } });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("internal_error");
  });

  it("SSE frame has data: line, blank separator and never an event: field", async () => {
    const res = await fetch(`${baseUrl}/stream`, { headers: { "X-Loom-Token": GOOD_TOKEN } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const text = await res.text();
    expect(text).not.toContain("event:");
    const lines = text.split("\n");
    expect(lines[0]?.startsWith("data:")).toBe(true);
    const envelope = JSON.parse(lines[0]?.slice("data:".length) ?? "null") as {
      payload: { type: string; properties: { sessionID: string } };
    };
    expect(envelope.payload.type).toBe("session.idle");
    expect(envelope.payload.properties.sessionID).toBe("s_1");
    expect(text.endsWith("\n\n")).toBe(true);
  });
});
