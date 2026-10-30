// T26：HTTP 层统一错误类型。路由/中间件只抛 HttpError，由 Router 顶层映射为 JSON 错误响应。
// 裸 node:http 方案 A（见 docs/05-http-framework-decision.md），零外部依赖。

/** 带 HTTP 状态码与稳定机器码的错误；message 面向人，code 面向调用方。 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }

  static unauthorized(message = "missing or invalid token"): HttpError {
    return new HttpError(401, "unauthorized", message);
  }

  static notFound(path: string): HttpError {
    return new HttpError(404, "not_found", `no route for ${path}`);
  }

  static methodNotAllowed(path: string): HttpError {
    return new HttpError(405, "method_not_allowed", `method not allowed for ${path}`);
  }

  static payloadTooLarge(maxBytes: number): HttpError {
    return new HttpError(413, "payload_too_large", `request body exceeds ${maxBytes} bytes`);
  }

  static unsupportedMediaType(received: string): HttpError {
    return new HttpError(415, "unsupported_media_type", `content-type must be application/json, got: ${received}`);
  }

  static badJson(reason: string): HttpError {
    return new HttpError(400, "bad_json", `request body is not valid JSON: ${reason}`);
  }
}
