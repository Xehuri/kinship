// T26：注册式 method/path 路由（裸 node:http 方案 A，见 docs/05-http-framework-decision.md）。
// 鉴权在最前（无未鉴权路径）→ 匹配路由 → 调 handler；异常统一映射为 JSON 错误体。
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { TokenAuth } from "./auth.js";
import { HttpError } from "./errors.js";
import { sendErrorJson } from "./respond.js";
import type { HandlerCtx, HttpMethod, LoomHandler } from "./types.js";

interface Segment {
  readonly literal: string | null; // null = :param 捕获段
  readonly name: string | null;
}

interface Route {
  readonly method: HttpMethod;
  readonly pattern: string;
  readonly segments: readonly Segment[];
  readonly handler: LoomHandler;
}

export interface RouterOptions {
  /** 合法 token 列表（构造注入；空列表 = 拒绝一切请求）。 */
  readonly tokens: readonly string[];
}

const METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const METHOD_SET: ReadonlySet<string> = new Set<string>(METHODS);

function assertMethod(method: string): HttpMethod {
  const upper = method.toUpperCase();
  const found = METHODS.find((m) => m === upper);
  if (found === undefined) throw new Error(`unsupported method: ${method}`);
  return found;
}

function compilePattern(pattern: string): readonly Segment[] {
  const parts = splitPath(pattern);
  return parts.map((part) => {
    if (part.startsWith(":")) {
      const name = part.slice(1);
      if (name.length === 0) throw new Error(`empty param name in pattern: ${pattern}`);
      return { literal: null, name };
    }
    if (part.includes(":")) throw new Error(`inline param must be a whole segment: ${part}`);
    return { literal: part, name: null };
  });
}

/** 拆路径并归一化：去 query、去尾部斜杠（根路径保持 []）。 */
function splitPath(rawUrl: string): string[] {
  const path = rawUrl.split("?", 2)[0] ?? "/";
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.split("/").filter((seg) => seg.length > 0);
}

function matchSegments(
  route: readonly Segment[],
  actual: readonly string[],
): Record<string, string> | null {
  if (route.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < route.length; i++) {
    const seg = route[i];
    const part = actual[i];
    if (seg === undefined || part === undefined) return null;
    if (seg.literal !== null) {
      if (seg.literal !== part) return null;
    } else if (seg.name !== null) {
      params[seg.name] = decodeSegment(part);
    }
  }
  return params;
}

function decodeSegment(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part; // 非法百分号编码：原样交给 handler，不 500
  }
}

export class Router {
  readonly #auth: TokenAuth;
  readonly #routes: Route[] = [];

  constructor(options: RouterOptions) {
    this.#auth = new TokenAuth(options.tokens);
  }

  /** 注册路由。pathPattern 支持整段 :param（如 `/sessions/:id/messages`）。重复注册同 method+pattern 覆盖旧 handler。 */
  add(method: HttpMethod, pathPattern: string, handler: LoomHandler): this {
    const m = assertMethod(method);
    if (!pathPattern.startsWith("/")) throw new Error(`pattern must start with '/': ${pathPattern}`);
    const existing = this.#routes.findIndex((r) => r.method === m && r.pattern === pathPattern);
    const route: Route = { method: m, pattern: pathPattern, segments: compilePattern(pathPattern), handler };
    if (existing >= 0) this.#routes[existing] = route;
    else this.#routes.push(route);
    return this;
  }

  /** 产出 node:http createServer 用的请求监听器。 */
  toRequestHandler(): RequestListener {
    return (req, res) => {
      void this.#dispatch(req, res);
    };
  }

  async #dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // 1) 鉴权先于路由匹配：不存在任何未鉴权可达路径（含 404 探测）。
      const token = this.#auth.authenticate(req);
      // 2) 匹配。HEAD/OPTIONS 等未注册方法直接 405（骨架阶段不做 GET 别名）。
      const rawMethod = (req.method ?? "GET").toUpperCase();
      if (!METHOD_SET.has(rawMethod)) throw HttpError.methodNotAllowed(req.url ?? "/");
      const method = rawMethod as HttpMethod;
      const url = new URL(req.url ?? "/", "http://loom.local");
      const parts = splitPath(req.url ?? "/");
      const match = this.#matchRoute(method, parts);
      if (match.kind === "none") throw HttpError.notFound(url.pathname);
      if (match.kind === "wrong-method") throw HttpError.methodNotAllowed(url.pathname);
      // 3) 进入 handler。
      const ctx: HandlerCtx = { token, params: match.params, url };
      await match.route.handler(req, res, ctx);
      if (!res.headersSent) sendErrorJson(res, 500, "handler_no_response", "handler completed without sending a response");
    } catch (err) {
      this.#respondError(res, err);
    }
  }

  #matchRoute(method: HttpMethod, parts: readonly string[]):
    | { kind: "hit"; route: Route; params: Record<string, string> }
    | { kind: "wrong-method" }
    | { kind: "none" } {
    let wrongMethod = false;
    for (const route of this.#routes) {
      const params = matchSegments(route.segments, parts);
      if (params === null) continue;
      if (route.method === method) return { kind: "hit", route, params };
      wrongMethod = true;
    }
    return wrongMethod ? { kind: "wrong-method" } : { kind: "none" };
  }

  #respondError(res: ServerResponse, err: unknown): void {
    if (res.headersSent) {
      res.destroy(); // 已开始流式输出（如 SSE），只能断流
      return;
    }
    if (err instanceof HttpError) {
      sendErrorJson(res, err.status, err.code, err.message);
      return;
    }
    if (err instanceof URIError || (err instanceof TypeError && err.message.includes("Invalid URL"))) {
      sendErrorJson(res, 400, "bad_request", "malformed request URI");
      return;
    }
    const message = err instanceof Error ? err.message : "internal error";
    sendErrorJson(res, 500, "internal_error", message);
  }
}
