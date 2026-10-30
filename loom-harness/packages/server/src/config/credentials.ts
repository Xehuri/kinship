// T07 凭据处理：credentials 段只允许 ${ENV_VAR} 引用；密钥字面量一律拒绝；
// env 无值 fail-fast；错误信息永不回显密钥值。本模块绝不从文件读取密钥。

/** env 引用形式：整体必须恰为 ${VAR}，变量名遵循 shell 标识符规则。 */
export const ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** 疑似密钥字面量：非 env-ref 且长度>12（宁可误杀不可漏放）。 */
export function suspectInlineSecret(v: string): boolean {
  return !ENV_REF.test(v) && v.length > 12;
}

export interface CredentialEntry {
  readonly envRef: string;
  readonly value: string;
}

export type Credentials = Readonly<Record<string, CredentialEntry>>;

/**
 * 校验 credentials 段并用 env 立即解析；每个非法条目 push 到 errors
 * （只回显变量名，绝不回显值）。raw 缺省 → 空凭据表。
 */
export function checkCredentials(
  raw: unknown,
  env: Readonly<Record<string, string | undefined>>,
  errors: string[],
): Credentials | undefined {
  if (raw === undefined) {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push("credentials: 需要映射");
    return undefined;
  }
  const out: Record<string, CredentialEntry> = {};
  for (const [name, value] of Object.entries(raw)) {
    const where = `credentials.${name}`;
    if (typeof value !== "string") {
      errors.push(where + ": 值必须是字符串形式的 ${ENV_VAR} 引用");
      continue;
    }
    const m = ENV_REF.exec(value);
    if (m === null) {
      const reason = suspectInlineSecret(value)
        ? "疑似内联密钥字面量（禁止，只允许 ${ENV_VAR} 引用）"
        : "不是 ${ENV_VAR} 引用形式";
      errors.push(`${where}: ${reason}`);
      continue;
    }
    const envName = m[1];
    if (envName === undefined) {
      errors.push(`${where}: env 变量名解析失败`);
      continue;
    }
    const resolved = env[envName];
    if (resolved === undefined || resolved === "") {
      errors.push(`${where}: 引用 ${envName} 在环境中无值（fail-fast）`);
      continue;
    }
    out[name] = { envRef: envName, value: resolved };
  }
  return out;
}
