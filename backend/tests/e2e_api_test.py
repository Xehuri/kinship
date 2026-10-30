"""
OMP 端到端 API 测试 (L2)
需要服务器运行在 https://localhost:8768

用法:
  python tests/e2e_api_test.py
  
测试步骤:
  1. GET /health → 验证 200
  2. WebSocket 连接 → 监听 ai_stream_* 事件
  3. POST /api/screen/session/message → 验证 200 立即返回
  4. WebSocket 接收 → 验证 ai_stream_delta 到达 (最多等 60s)
  （原步骤 5 POST /api/screen/session/abort 已随该孤儿端点于 2026-10-08 P0-U2 删除）
"""
import sys
import os
import json
import asyncio
import time
import pytest
import httpx
import websockets

BASE_URL = "https://localhost:8768"
WS_URL = "wss://localhost:8768/ws"
TIMEOUT_SEC = 60  # 等待 AI 响应的最大时间

SSL_CTX = None
try:
    import ssl
    SSL_CTX = ssl.create_default_context()
    SSL_CTX.check_hostname = False
    SSL_CTX.verify_mode = ssl.CERT_NONE
except:
    pass


@pytest.mark.asyncio
async def test_health():
    """测试健康检查端点"""
    print("\n[1/5] GET /health ...", end=" ", flush=True)
    async with httpx.AsyncClient(verify=SSL_CTX) as client:
        resp = await client.get(f"{BASE_URL}/health", timeout=5)
        assert resp.status_code == 200, f"health 返回 {resp.status_code}"
        data = resp.json()
        assert "status" in data, f"health 响应格式异常: {data}"
        print(f"PASS ({resp.status_code}, status={data.get('status')})")
        return True


@pytest.mark.asyncio
async def test_websocket_connect():
    """测试 WebSocket 连接"""
    print("[2/5] WebSocket 连接中 ...", end=" ", flush=True)
    async with websockets.connect(
        WS_URL,
        ssl=SSL_CTX,
        ping_interval=30,
        max_size=2**20,
    ) as ws:
        # 等待一下确保连接建立
        await asyncio.sleep(0.5)
        print("PASS (已连接)")
        return ws


@pytest.mark.skip(reason="E2E test requiring live WebSocket and AI service")
@pytest.mark.asyncio
async def test_send_message():
    """发送消息并验证 WebSocket 收到 AI 事件（需要实际运行的 AI 服务）"""
    print("[3/5] POST /api/screen/session/message (发送: '请用中文说 hello，只说一句话') ...", end=" ", flush=True)

    async with httpx.AsyncClient(verify=SSL_CTX, timeout=10) as client:
        resp = await client.post(
            f"{BASE_URL}/api/screen/session/message",
            json={"message": "请用中文说 hello，只说一句话"}
        )
        assert resp.status_code == 200, f"send_message 返回 {resp.status_code}"
        data = resp.json()
        print(f"OK (status={resp.status_code})")

    # 在 WebSocket 上等待 AI 事件
    print(f"[4/5] 等待 AI 流式事件 (最多 {TIMEOUT_SEC}s) ...")
    received_events = []
    start_time = time.time()
    timeout_error = None

    try:
        while (time.time() - start_time) < TIMEOUT_SEC:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=2)
                data = json.loads(msg) if isinstance(msg, str) else msg

                # 只捕获 ai_stream_* 事件
                if isinstance(data, dict):
                    etype = data.get("type", "")
                    if etype.startswith("ai_stream_"):
                        received_events.append(etype)
                        delta = data.get("delta", data.get("full_text", ""))
                        print(f"  << 收到 {etype}: {delta[:60]}")

                        # ai_stream_end 表示流结束
                        if etype == "ai_stream_end":
                            full_text = data.get("full_text", "")
                            print(f"  << AI 响应完成: {full_text[:100]}")
                            break

            except asyncio.TimeoutError:
                continue
            except websockets.ConnectionClosed:
                print("  !! WebSocket 连接关闭")
                break

    except asyncio.CancelledError:
        pass

    elapsed = time.time() - start_time
    print(f"  等待耗时: {elapsed:.1f}s")

    # 验证：至少收到一个 ai_stream_delta
    has_delta = any("delta" in t for t in received_events)
    has_end = any("end" in t for t in received_events)

    assert has_delta, f"未收到 ai_stream_delta, 只收到: {received_events}"
    print(f"  PASS (收到 {len(received_events)} 个事件: {received_events})")

    return received_events


async def main():
    print("=" * 60)
    print("OMP 端到端 API 测试 (L2)")
    print(f"服务器: {BASE_URL}")
    print("=" * 60)

    passed = 0
    total = 4

    try:
        # 1. 健康检查
        if await test_health():
            passed += 1
    except Exception as e:
        print(f"FAIL: {e}")

    try:
        # 2. WebSocket 连接
        ws = await test_websocket_connect()
        if ws:
            passed += 1

            # 3. 发送消息
            try:
                events = await test_send_message(ws)
                passed += 1
                # 4. 等待事件也算通过
                if events:
                    passed += 1
            except Exception as e:
                print(f"FAIL: {e}")

            # 关闭 WebSocket
            await ws.close()

    except Exception as e:
        print(f"FAIL: {e}")

    print(f"\n{'=' * 60}")
    print(f"结果: {passed}/{total} 通过")
    print(f"{'=' * 60}")

    return passed == total


if __name__ == "__main__":
    success = asyncio.run(main())
    sys.exit(0 if success else 1)
