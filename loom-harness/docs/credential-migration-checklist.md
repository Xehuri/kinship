# 凭据迁移清单（Credential Migration Checklist）

> **未来授权事项（切换日执行）**——本文档只登记程序与检查项，**开发期一律不执行**。
> 依据：docs/02-实施计划-v1.md T07 与切换日附录；决策 D32（不触碰现状）约束开发期。

## 铁律（无例外）

1. 密钥值**绝不进 git**：`loom.yaml`（真实配置）保持 gitignore；仓库内只有
   `config/loom.example.yaml` 模板，模板中 credentials 全部是 `${LOOM_KEY_*}` 引用。
2. 密钥值**绝不进 agent 上下文/日志**：加载器（`packages/server/src/config/loom-config.ts`）
   校验失败的错误信息只回显环境变量名或字段位置，永不回显值；`/config` 对
   `providers[].apiKey` 只回 `apiKeyConfigured` 布尔；任何审计/排错同样只引用变量名。
3. 凭据二选一：`providers[].apiKey` 内联在真实 `loom.yaml`（文件权限由部署侧后端强制
   0600），**或** `credentials` 段的 `${LOOM_KEY_*}` 经 systemd `Environment=` 注入。
   内联 `apiKey` 在场时优先于 `credentials` 解析值；`credentials` 段本身仍只允许 env 引用。

## 注入模式（照 `AXEUH_KERNEL_TOKEN` 先例）

现网先例：kernel token 由 systemd unit 文件的 `Environment=` 行注入，
服务进程只读环境变量，配置文件零密钥。Loom 的 env 回退模式沿用同一模式
（内联模式则把 `providers[].apiKey` 落真实 `loom.yaml`，由部署侧后端强制 0600）：

```ini
# /etc/systemd/system/axeuh-loom.service.d/credentials.conf（切换日创建，权限 0600）
[Service]
Environment=LOOM_KEY_EFLOWCODE=<届时人工写入，不经过任何文档/context>
```

- 变量命名规范：`LOOM_KEY_<供应商大写>`，与 `loom.yaml` credentials 段的
  `${LOOM_KEY_*}` 引用一一对应。
- drop-in 文件本身**不入库**；unit 变更走运维流程，不进代码仓库。
- 验证注入：`systemctl show axeuh-loom -p Environment` 只看变量名是否存在，
  排错时避免回显值（必要时 `grep -o '^[A-Z_]*='`）。

## 切换日检查项（逐项勾选）

- [ ] 1. 权限授权：获得切换日执行授权（本清单动作全部依赖该授权）。
- [ ] 2. 盘点密钥源：现有 `ai/config.yaml` 等处的供应商密钥清单（只登记
      "供应商→变量名"映射，不抄录值）。
- [ ] 3. 创建 systemd drop-in：按上文模式为每个 `LOOM_KEY_*` 落 `Environment=` 行。
- [ ] 4. 生成真实 `loom.yaml`：从 `config/loom.example.yaml` 复制。凭据二选一——
      `providers[].apiKey` 内联（真实配置须 0600），或 credentials 段全
      `${LOOM_KEY_*}` 引用并经 systemd 注入。
- [ ] 5. fail-fast 冒烟：以 loom 用户环境运行加载器（`loadLoomConfig`），
      确认全部引用解析成功；任一 `无值` 报错即停止切换并回到第 3 项。
- [ ] 6. 反向验证：临时删一个环境变量重启，确认服务拒绝启动（fail-fast 生效）。
- [ ] 7. 泄漏审计：`grep -rE 'sk-|[A-Za-z0-9]{32,}' config/ packages/server/src/`
      于仓库执行，确认模板/源码无内联密钥残留（真实 `loom.yaml` 为 gitignore 配置，
      若用 `providers[].apiKey` 须确认其部署侧文件权限为 0600）。
- [ ] 8. 旧密钥吊销：新链路验证通过后，按各供应商流程轮换/吊销迁移前旧密钥。

## 开发期禁令（现状，D32）

- 不建 systemd 单元、不注入任何 `LOOM_*` 环境变量到现有服务。
- 测试凭据用注入的假 env（见 `loom-config.test.ts` 的 `env` 参数），
  不读任何真实密钥文件。
