"""P2P 设备直连后端组件（Phase 1：配对、设备 token、短时信令票据；
Phase 2：可选 aiortc DataChannel 数据面，``p2p.webrtc.enabled`` 默认关闭）。

默认关闭：config.yaml 无 p2p 段或 p2p.enabled=false 时本包不产生任何运行时副作用。
"""
