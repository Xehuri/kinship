// T14 回执 schema + harness 侧验证块（docs/02 §T14；决策 docs/01 D23/D5/D25）。
// 下游消费：T39 影子验证（回执 PASS + 产物存在 + 无越界写）。
//
// 复用收敛词表（convergence/ SideStatus）与运行引擎终态（run-engine/ RunRow/RunLaunchResult），
// 只读 import，禁改其文件。

export type {
  Verdict,
  VerificationCheck,
  VerificationBlock,
  HarnessReceipt,
  ManifestEntry,
  ArtifactProbeResult,
  ArtifactProbe,
  CommitBodyAssertion,
  CommitBodyAssertionResult,
  CoverageDeclaration,
  VerificationInput,
  VerificationDeps,
  ReceiptBuildInput,
} from "./types.js";

export { manifestFromPointers, verifyManifest, MemoryArtifactProbe } from "./manifest.js";

export {
  COMMIT_BODY_REQUIRED_FIELDS,
  defaultCommitBodyAssertion,
  verifyCommitBody,
} from "./commit-body.js";

export { DEFAULT_COVERAGE_THRESHOLD, verifyCoverage } from "./coverage.js";

export {
  runVerification,
  verificationFailed,
  applyVerificationDowngrade,
  buildReceipt,
} from "./verify.js";

export {
  RECEIPT_MARK,
  receiptMessage,
  MemoryReceiptDelivery,
  type ReceiptDeliveryPort,
} from "./delivery.js";
