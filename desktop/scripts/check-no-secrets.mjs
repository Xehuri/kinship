#!/usr/bin/env node
// Secret and artifact hygiene check for the staged PC sensor bundle.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const outputRoot = path.join(desktopRoot, "resources", "pc-sensor");
const appDir = path.join(outputRoot, "app");

const FORBIDDEN_NAMES = new Set([
  "config.json",
  "pc_sensor_config.json",
  "config.example.json",
  "pc_sensor_config.example.json",
]);
const ALLOWED_EXES = new Set(["runtime/python.exe", "runtime/pythonw.exe"]);
const TEXT_EXTENSIONS = new Set([
  ".py", ".html", ".htm", ".js", ".css", ".json", ".md", ".txt", ".ini", ".cfg", ".yaml", ".yml", ".pth",
]);
const LITERAL_RULES = [
  {
    name: "agent_token literal",
    pattern: /\bagent_token\b\s*[:=]\s*["'][A-Za-z0-9_\-./+=]{20,}["']/,
  },
  {
    name: "password_enc literal",
    pattern: /(?:["']password_enc["']\s*:\s*["'][^"']{8,}["']|\bpassword_enc\s*[:=]\s*["'][^"']{8,}["'])/,
  },
  {
    name: "private key",
    pattern: /BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY/,
  },
  {
    name: "personal hostname",
    pattern: /\b(?:[a-z0-9-]+\.)*(?:axeuh\.com|xehuri\.top)\b/i,
  },
];

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

function rel(file) {
  return path.relative(outputRoot, file).split(path.sep).join("/");
}

function main() {
  if (!fs.existsSync(outputRoot)) {
    console.error(`NO_SECRETS_FAILED: missing staged output: ${outputRoot}`);
    process.exit(1);
  }

  const findings = [];
  const files = walkFiles(outputRoot);

  for (const file of files) {
    const relative = rel(file);
    const name = path.basename(file);
    if (FORBIDDEN_NAMES.has(name)) findings.push(`${relative}: forbidden config file`);
    if (name.endsWith(".log")) findings.push(`${relative}: log file`);
    if (name.includes(".bak-")) findings.push(`${relative}: backup file`);
    if (name.endsWith(".exe") && !ALLOWED_EXES.has(relative)) findings.push(`${relative}: unexpected executable`);
  }

  for (const file of walkFiles(appDir)) {
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of LITERAL_RULES) {
        if (rule.pattern.test(line)) {
          findings.push(`${rel(file)}:${index + 1}: ${rule.name}`);
        }
      }
    });
  }

  if (findings.length > 0) {
    for (const finding of findings) console.error(`NO_SECRETS_FAILED: ${finding}`);
    process.exit(1);
  }

  console.log(`Scanned ${files.length} staged files (values redacted by design)`);
  console.log("NO_SECRETS_OK");
}

main();
