// T30 验收：只读 ops API（health/config/catalog/audit）。
// 鉴权继承 http 骨架（auth 先于匹配）；脱敏断言：响应全文不含任何 resolved 密钥值；
// 审计只回哈希+时间；全部写方法 405（不存在写端点）。
// 端口一律 ephemeral（listen 0），afterEach 关 server 防句柄泄漏（照 http/router.test.ts）。
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import { parseLoomConfig } from "../config/loom-config.js";
import { HotConfigStore } from "../hotreload/store.js";
import {
  BROKEN_YAML,
  ENV_OK,
  FIXED_TS,
  MemoryAuditSink,
  VALID_YAML_A,
  VALID_YAML_B,
  sha,
} from "../hotreload/fixtures.js";
import { Router } from "../http/router.js";
import { registerOpsRoutes, type OpsDeps } from "./index.js";

const GOOD_TOKEN = "tok-ops";
const TOKENS: readonly string[] = [GOOD_TOKEN];
const VERSION = "0.0.0-test";

// fixtures 配置的凭据 resolved 值：脱敏断言要求响应文本绝不包含它们。
const SECRET_VALUES: readonly string[] = [ENV_OK.LOOM_KEY_EFLOWCODE, ENV_OK.LOOM_KEY_OPENAI];

// providers[].apiKey 内联密钥（seed）：/config 与审计序列化均不得出现。
const INLINE_KEY = "sk-inline-ops-canary-7c4d";
const INLINE_KEY_YAML = `
server:
  port: 5098
  hostname: 127.0.0.1
workspace: /srv/loom/inline-ws
providers:
  - provider: eflowcode
    baseUrl: https://inline.example/v1
    apiKey: ${INLINE_KEY}
  - provider: env-only
    baseUrl: https://env-only.example/v1
models:
  - id: inline-model
    provider: eflowcode
    contextWindow: 1000
    maxOutput: 100
    timeout: 5000
pricing:
  eflowcode:
    input: 0
    output: 0
credentials:
  eflowcode: \${LOOM_KEY_EFLOWCODE}
`;

let active: Server | null = null;

async function serve(deps: OpsDeps): Promise<string> {
  const router = new Router({ tokens: TOKENS });
  registerOpsRoutes(router, deps);
  const server = createServer(router.toRequestHandler());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  expect(addr.port).toBeGreaterThanOrEqual(1); // listen(0) 由内核分配 ephemeral
  active = server;
  return `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  const server = active;
  if (server === null) return;
  active = null;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

function authed(path: string, method?: "POST" | "PUT" | "PATCH" | "DELETE"): Promise<Response> {
  const init: RequestInit = method === undefined ? {} : { method };
  return fetch(path, { ...init, headers: { "X-Loom-Token": GOOD_TOKEN } });
}

function staticDeps(): OpsDeps {
  return {
    getConfig: () => parseLoomConfig(VALID_YAML_A, "<test>", { env: ENV_OK }),
    hotStore: null,
    startedAt: Date.now(),
    version: VERSION,
  };
}

/** 注入内存 sink + 固定时钟的热加载库并 apply A：审计哈希可精确断言。 */
function hotStoreA(): { store: HotConfigStore; sink: MemoryAuditSink } {
  const sink = new MemoryAuditSink();
  const store = new HotConfigStore({ sink, env: ENV_OK, now: () => FIXED_TS });
  store.apply(VALID_YAML_A);
  return { store, sink };
}

describe("ops-api health (T30)", () => {
  it("/health requires token: 401 without header (auth inherited from router)", async () => {
    const base = await serve(staticDeps());
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe("unauthorized");
  });

  it("/health returns status/version/uptime/startedAt", async () => {
    const startedAt = Date.now() - 5000;
    const base = await serve({ ...staticDeps(), startedAt });
    const res = await authed(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string; version: string; uptimeMs: number; startedAt: string;
    };
    expect(body.status).toBe("ok");
    expect(body.version).toBe(VERSION);
    expect(body.uptimeMs).toBeGreaterThanOrEqual(5000);
    expect(new Date(body.startedAt).getTime()).toBe(startedAt);
  });
});

describe("ops-api config (T30)", () => {
  it("/config exposes only ${VAR} refs, never resolved secret values", async () => {
    const base = await serve(staticDeps());
    const res = await authed(`${base}/config`);
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const secret of SECRET_VALUES) expect(text.includes(secret)).toBe(false);
    const body = JSON.parse(text) as {
      server: { port: number; hostname: string };
      credentials: { name: string; envRef: string }[];
      effectiveVersionSha256: string | null;
    };
    expect(body.server).toEqual({ port: 5097, hostname: "127.0.0.1" });
    expect(body.credentials).toEqual([{ name: "eflowcode", envRef: "${LOOM_KEY_EFLOWCODE}" }]);
    expect(body.effectiveVersionSha256).toBeNull(); // hotStore=null：无版本面
  });

  it("/config echoes the hot store active version sha", async () => {
    const { store } = hotStoreA();
    const base = await serve({
      getConfig: () => store.get(),
      hotStore: store,
      startedAt: Date.now(),
      version: VERSION,
    });
    const body = (await (await authed(`${base}/config`)).json()) as {
      effectiveVersionSha256: string;
    };
    expect(body.effectiveVersionSha256).toBe(sha(VALID_YAML_A));
  });
});

describe("ops-api config provider redaction", () => {
  function inlineDeps(): OpsDeps {
    return {
      getConfig: () => parseLoomConfig(INLINE_KEY_YAML, "<test>", { env: ENV_OK }),
      hotStore: null,
      startedAt: Date.now(),
      version: VERSION,
    };
  }

  it("/config 只回 apiKeyConfigured 布尔：内联密钥/env 值均不出现在响应文本", async () => {
    const base = await serve(inlineDeps());
    const text = await (await authed(`${base}/config`)).text();
    expect(text.includes(INLINE_KEY)).toBe(false);
    for (const secret of SECRET_VALUES) expect(text.includes(secret)).toBe(false);
    expect(text.includes('"apiKey"')).toBe(false);

    const body = JSON.parse(text) as {
      providers: { name: string; baseUrl: string; apiKeyConfigured: boolean }[];
    };
    expect(body.providers).toEqual([
      { name: "eflowcode", baseUrl: "https://inline.example/v1", apiKeyConfigured: true },
      { name: "env-only", baseUrl: "https://env-only.example/v1", apiKeyConfigured: false },
    ]);
    expect(Object.keys(body.providers[0]!).sort()).toEqual([
      "apiKeyConfigured",
      "baseUrl",
      "name",
    ]);
  });

  it("config.applied 审计序列化只含哈希/时间：内联密钥零命中", () => {
    const sink = new MemoryAuditSink();
    const store = new HotConfigStore({ sink, env: ENV_OK, now: () => FIXED_TS });
    expect(store.apply(INLINE_KEY_YAML).ok).toBe(true);
    const serialized = JSON.stringify(sink.events);
    expect(serialized).not.toContain(INLINE_KEY);
    for (const secret of SECRET_VALUES) expect(serialized.includes(secret)).toBe(false);
  });
});

describe("ops-api catalog (T30)", () => {
  it("/catalog/models lists the active model set and follows hot swaps", async () => {
    const { store } = hotStoreA();
    const base = await serve({
      getConfig: () => store.get(),
      hotStore: store,
      startedAt: Date.now(),
      version: VERSION,
    });
    const first = (await (await authed(`${base}/catalog/models`)).json()) as {
      count: number; models: { id: string }[];
    };
    expect(first.count).toBe(1);
    expect(first.models.map((m) => m.id)).toEqual(["qwen3.8-flash"]);

    const applied = store.apply(VALID_YAML_B);
    expect(applied.ok).toBe(true);
    const second = (await (await authed(`${base}/catalog/models`)).json()) as {
      count: number; models: { id: string; provider: string; vision: boolean }[];
    };
    expect(second.count).toBe(2);
    expect(second.models.map((m) => m.id)).toEqual(["qwen3.8-flash", "gpt-4o"]);
    expect(second.models[1]).toMatchObject({ provider: "eflowcode", vision: false });
  });

  it("catalog requires token like every other ops path", async () => {
    const base = await serve(staticDeps());
    expect((await fetch(`${base}/catalog/models`)).status).toBe(401);
  });
});

describe("ops-api audit (T30)", () => {
  it("/config/audit returns hash+time only: no source path, no error text, no secrets", async () => {
    const { store, sink } = hotStoreA();
    store.apply(BROKEN_YAML, "/srv/loom/secret-path/loom.yaml");
    const base = await serve({
      getConfig: () => store.get(),
      hotStore: store,
      startedAt: Date.now(),
      version: VERSION,
      audit: () => sink.events,
    });
    const res = await authed(`${base}/config/audit`);
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const secret of SECRET_VALUES) expect(text.includes(secret)).toBe(false);
    expect(text.includes("/srv/loom/secret-path")).toBe(false); // source 不外泄
    expect(text.includes("解析失败")).toBe(false); // errors 文本不外泄
    const body = JSON.parse(text) as { events: unknown[] };
    expect(body.events).toEqual([
      { ts: FIXED_TS, status: "applied", beforeSha256: null, afterSha256: sha(VALID_YAML_A) },
      {
        ts: FIXED_TS,
        status: "rejected",
        stage: "schema",
        beforeSha256: sha(VALID_YAML_A),
        afterSha256: sha(BROKEN_YAML),
      },
    ]);
  });

  it("/config/audit with no audit source returns an empty list", async () => {
    const base = await serve(staticDeps());
    const body = (await (await authed(`${base}/config/audit`)).json()) as { events: unknown[] };
    expect(body.events).toEqual([]);
  });
});

describe("ops-api read-only (T30)", () => {
  const paths = ["/health", "/config", "/catalog/models", "/config/audit"];

  it("every ops path rejects all write methods with 405 (no write endpoints exist)", async () => {
    const base = await serve(staticDeps());
    for (const p of paths) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        const res = await authed(`${base}${p}`, method);
        expect(res.status, `${method} ${p}`).toBe(405);
      }
    }
  });

  it("unknown paths stay 404 even with token; nothing reachable without token", async () => {
    const base = await serve(staticDeps());
    expect((await authed(`${base}/config/extra`)).status).toBe(404);
    expect((await fetch(`${base}/config`)).status).toBe(401);
    expect((await fetch(`${base}/config/extra`, { method: "POST" })).status).toBe(401); // 鉴权先于匹配
  });
});
