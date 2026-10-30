// T30 ops domain 出口：配置/目录/健康只读 API（脱敏视图 + 注入式 deps，供 T31 组装）。
export {
  registerOpsRoutes,
  toConfigView,
  type AuditEventView,
  type ConfigView,
  type CredentialView,
  type HealthBody,
  type ModelView,
  type OpsDeps,
  type ProviderView,
} from "./routes.js";
