#!/usr/bin/env node
/**
 * T23 测试 fixture —— fake stdio MCP 服务（newline-delimited JSON-RPC 2.0）。
 *
 * 工具语义对齐 fixture-workspace/.opencode/ai_mcp.py：
 *   - send_notification(title, content[, response_format]) → "通知已发送: <title>"
 *   - tts_speak(text[, voice, style, user_id]) → 'TTS语音已成功发送: "<preview>"'
 * 附加测试魔法（放在 arguments 里，真 ai-mcp 不会有）：
 *   - __delay_ms: N      → 延迟 N 毫秒再回响应（测超时 / 乱序 id 关联）
 *   - tts_speak text="__die__" → 不回应直接 exit(3)（测子进程死亡）
 *   - send_notification title="__badframe__" → stdout 吐一行非法 JSON（测协议错误）
 *   - 环境变量 FAKE_MCP_ENV_TEST 回显在 serverInfo.version（测 env 透传）
 *   - 启动时 stderr 打 "ready cwd=<cwd>"（测 cwd + stderr 透传）
 */

import process from "node:process";

const STDIN_ENCODING = "utf8";

let notifyCount = 0;
let ttsCount = 0;

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function logErr(line) {
  process.stderr.write(`${line}\n`);
}

const TOOL_DEFS = [
  {
    name: "send_notification",
    description: "给用户的手机发送一条系统通知。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "通知标题" },
        content: { type: "string", description: "通知正文" },
        response_format: { type: "string", enum: ["markdown", "json"], default: "markdown" },
      },
      required: ["title", "content"],
    },
    annotations: { title: "Send Phone Notification", readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "tts_speak",
    description: "使用TTS语音合成并播放文本。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要朗读的文本内容" },
        voice: { type: "string", default: "mimo_default" },
        style: { type: ["string", "null"] },
        user_id: { type: ["string", "null"] },
        response_format: { type: "string", enum: ["markdown", "json"], default: "markdown" },
      },
      required: ["text"],
    },
    annotations: { title: "TTS Speak - Voice Synthesis", readOnlyHint: false, destructiveHint: false },
  },
];

function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  const delayMs = typeof args.__delay_ms === "number" ? args.__delay_ms : 0;

  const finish = () => {
    if (name === "send_notification") {
      if (args.title === "__badframe__") {
        process.stdout.write("this-is-not-json\n");
        return;
      }
      notifyCount += 1;
      logErr(`tool send_notification #${String(notifyCount)}`);
      respond(id, {
        content: [{ type: "text", text: `通知已发送: ${String(args.title)} (count=${String(notifyCount)})` }],
      });
      return;
    }
    if (name === "tts_speak") {
      if (args.text === "__die__") {
        process.exit(3);
      }
      ttsCount += 1;
      logErr(`tool tts_speak #${String(ttsCount)}`);
      const text = String(args.text ?? "");
      const preview = text.length > 50 ? `${text.slice(0, 50)}...` : text;
      respond(id, {
        content: [{ type: "text", text: `TTS语音已成功发送: "${preview}" (count=${String(ttsCount)})` }],
      });
      return;
    }
    respondError(id, -32601, `tool not found: ${String(name)}`);
  };

  if (delayMs > 0) {
    setTimeout(finish, delayMs);
  } else {
    finish();
  }
}

function handleMessage(obj) {
  const { id, method, params } = obj;
  if (method === "initialize") {
    respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: {
        name: "fake-ai-mcp",
        version: process.env.FAKE_MCP_ENV_TEST ?? "unset",
      },
    });
    return;
  }
  if (method === "notifications/initialized") {
    logErr("initialized");
    return;
  }
  if (method === "ping") {
    respond(id, {});
    return;
  }
  if (method === "tools/list") {
    respond(id, { tools: TOOL_DEFS });
    return;
  }
  if (method === "tools/call") {
    handleToolCall(id, params);
    return;
  }
  if (id !== undefined) {
    respondError(id, -32601, `method not found: ${String(method)}`);
  }
}

process.stderr.write(`ready cwd=${process.cwd()}\n`);

let buffer = "";
process.stdin.setEncoding(STDIN_ENCODING);
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).replace(/\r$/, "");
    buffer = buffer.slice(nl + 1);
    if (line.length === 0) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    handleMessage(obj);
  }
});
process.stdin.on("end", () => {
  process.exit(0);
});
