// Shared helpers for staging the Windows PC sensor runtime.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export function fail(message) {
  throw new Error(message);
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(`${command} ${args.join(" ")} failed (exit ${result.status}): ${detail}`);
  }
  return result.stdout || "";
}

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

export function treeSize(dir) {
  return walkFiles(dir).reduce((total, file) => total + fs.statSync(file).size, 0);
}

export function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function normalizeName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, "_");
}

export function parseWheelName(fileName) {
  const match = /^(.+)-([0-9][^-]*)(?:-([0-9][^-]*))?-([^-]+)-([^-]+)-([^-]+)\.whl$/i.exec(fileName);
  if (!match) return null;
  return { dist: match[1], version: match[2], python: match[4], abi: match[5], platform: match[6] };
}

function wheelTagAllowed(meta) {
  if (meta.platform === "any") {
    return meta.abi === "none" && /^(py2\.py3|py3|py311|cp311)$/i.test(meta.python);
  }
  if (meta.platform !== "win_amd64") return false;
  return meta.abi === "abi3" || (meta.python.toLowerCase() === "cp311" && meta.abi === "cp311");
}

function wheelCandidates(dir, pkg, version) {
  if (!fs.existsSync(dir)) return [];
  const wanted = normalizeName(pkg);
  return fs
    .readdirSync(dir)
    .filter((name) => {
      const meta = parseWheelName(name);
      return meta && normalizeName(meta.dist) === wanted && meta.version === version && wheelTagAllowed(meta);
    })
    .map((name) => path.join(dir, name))
    .sort();
}

function isValidWheel(file) {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) return false;
  const result = spawnSync(
    "python3",
    ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); sys.exit(1 if z.testzip() else 0)", file],
    { encoding: "utf8" },
  );
  return result.status === 0;
}

function sidecarSha(file) {
  const sidecar = `${file}.sha256`;
  const actual = sha256File(file);
  if (fs.existsSync(sidecar)) {
    const expected = fs.readFileSync(sidecar, "utf8").trim().split(/\s+/)[0];
    return expected === actual ? actual : null;
  }
  fs.writeFileSync(sidecar, `${actual}\n`);
  return actual;
}

export function readRequirementSpecs(requirementsPath) {
  const specs = [];
  for (const raw of fs.readFileSync(requirementsPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+-]+)$/.exec(line);
    if (!match) fail(`Unsupported requirement line: ${line}`);
    specs.push({ name: match[1], version: match[2], spec: `${match[1]}==${match[2]}` });
  }
  if (specs.length === 0) fail("Requirement file is empty");
  return specs;
}

export function ensurePythonZip({ pythonCacheDir, lockPath, seedRoot }) {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  if (!lock.url || !lock.sha256 || !lock.version) fail("python-embed.lock.json is incomplete");
  const zipName = path.basename(new URL(lock.url).pathname);
  const zipPath = path.join(pythonCacheDir, zipName);
  fs.mkdirSync(pythonCacheDir, { recursive: true });

  if (!fs.existsSync(zipPath)) {
    const seedZip = path.join(seedRoot, "python-3.11.9-embed-amd64.zip");
    if (fs.existsSync(seedZip)) {
      console.log(`Using seeded Python embed zip: ${seedZip}`);
      fs.copyFileSync(seedZip, zipPath);
    } else {
      console.log(`Downloading ${lock.url}`);
      const tmp = `${zipPath}.download`;
      run("curl", ["-fL", "--retry", "3", "--connect-timeout", "20", "-o", tmp, lock.url], {
        env: process.env,
        stdio: ["ignore", "ignore", "inherit"],
      });
      fs.renameSync(tmp, zipPath);
    }
  }

  const actual = sha256File(zipPath);
  if (actual !== lock.sha256) {
    fail(`Python embed SHA-256 mismatch for ${zipPath}: expected ${lock.sha256}, got ${actual}`);
  }
  return { zipPath, lock };
}

function pipDownload(cacheRoot, spec, destination) {
  const tmp = fs.mkdtempSync(path.join(cacheRoot, "pip-"));
  const env = { ...process.env, PIP_NO_INPUT: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" };
  try {
    console.log(`Downloading ${spec} (win_amd64/cp311)`);
    run(
      "python3",
      [
        "-m", "pip", "download",
        "--dest", tmp,
        "--platform", "win_amd64",
        "--python-version", "311",
        "--implementation", "cp",
        "--abi", "cp311",
        "--only-binary=:all:",
        "--no-deps",
        "--no-cache-dir",
        "--disable-pip-version-check",
        "--progress-bar", "off",
        spec,
      ],
      { env, stdio: ["ignore", "inherit", "inherit"] },
    );
    const wheels = fs.readdirSync(tmp).filter((name) => name.endsWith(".whl"));
    if (wheels.length !== 1) fail(`Expected exactly one wheel for ${spec}, found: ${wheels.join(", ") || "none"}`);
    const meta = parseWheelName(wheels[0]);
    if (!meta || !wheelTagAllowed(meta)) fail(`Downloaded wheel has an unsupported tag: ${wheels[0]}`);
    const finalPath = path.join(destination, wheels[0]);
    fs.copyFileSync(path.join(tmp, wheels[0]), finalPath);
    return finalPath;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function acquireWheel({ name, version, spec }, { cacheRoot, wheelCacheDir, seedRoot }) {
  const cached = wheelCandidates(wheelCacheDir, name, version);
  if (cached.length > 1) fail(`Ambiguous cached wheels for ${name}==${version}: ${cached.join(", ")}`);
  if (cached.length === 1) {
    const sha = isValidWheel(cached[0]) ? sidecarSha(cached[0]) : null;
    if (sha) return { file: cached[0], sha256: sha };
    console.warn(`Discarding corrupt cached wheel: ${cached[0]}`);
    fs.rmSync(cached[0], { force: true });
    fs.rmSync(`${cached[0]}.sha256`, { force: true });
  }

  const seeded = wheelCandidates(path.join(seedRoot, "pin"), name, version);
  if (seeded.length > 1) fail(`Ambiguous seeded wheels for ${name}==${version}: ${seeded.join(", ")}`);
  if (seeded.length === 1 && isValidWheel(seeded[0])) {
    const finalPath = path.join(wheelCacheDir, path.basename(seeded[0]));
    fs.copyFileSync(seeded[0], finalPath);
    const sha = sha256File(finalPath);
    fs.writeFileSync(`${finalPath}.sha256`, `${sha}\n`);
    return { file: finalPath, sha256: sha };
  }

  const downloaded = pipDownload(cacheRoot, spec, wheelCacheDir);
  if (!isValidWheel(downloaded)) fail(`Downloaded wheel is corrupt: ${downloaded}`);
  const sha = sha256File(downloaded);
  fs.writeFileSync(`${downloaded}.sha256`, `${sha}\n`);
  return { file: downloaded, sha256: sha };
}

const WHEEL_INSTALL_PY = `
import os, shutil, sys, tempfile, zipfile

runtime_root, site_packages, *wheels = sys.argv[1:]
targets = {
    "purelib": site_packages,
    "platlib": site_packages,
    "scripts": os.path.join(runtime_root, "Scripts"),
    "data": runtime_root,
}

def copy_entry(src, dst, ignore=None):
    if os.path.isdir(src):
        shutil.copytree(src, dst, dirs_exist_ok=True, ignore=ignore)
    else:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)

ignore = shutil.ignore_patterns("__pycache__", "*.pyc")
for wheel in wheels:
    with tempfile.TemporaryDirectory(prefix="wheel-", dir=os.path.dirname(wheel)) as tmp:
        with zipfile.ZipFile(wheel) as archive:
            bad = archive.testzip()
            if bad:
                raise SystemExit("corrupt wheel entry: " + bad)
            archive.extractall(tmp)
        for entry in os.listdir(tmp):
            src = os.path.join(tmp, entry)
            if entry.endswith(".data") and os.path.isdir(src):
                for sub in os.listdir(src):
                    target_root = targets.get(sub)
                    if not target_root:
                        continue
                    subdir = os.path.join(src, sub)
                    os.makedirs(target_root, exist_ok=True)
                    for item in os.listdir(subdir):
                        copy_entry(os.path.join(subdir, item), os.path.join(target_root, item), ignore)
            else:
                copy_entry(src, os.path.join(site_packages, entry), ignore)
`;

export function installWheels({ runtimeOut, sitePackages, wheels }) {
  run("python3", ["-c", WHEEL_INSTALL_PY, runtimeOut, sitePackages, ...wheels.map((wheel) => wheel.file)]);
}

export function copyAppSource({ sourceRoot, appOut }) {
  fs.mkdirSync(path.join(appOut, "pc_sensor"), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, "pc_sensor_app.py"), path.join(appOut, "pc_sensor_app.py"));

  for (const file of walkFiles(path.join(sourceRoot, "pc_sensor"))) {
    if (!file.endsWith(".py") || file.split(path.sep).includes("__pycache__")) continue;
    const dest = path.join(appOut, "pc_sensor", path.relative(path.join(sourceRoot, "pc_sensor"), file));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
  }

  fs.cpSync(path.join(sourceRoot, "static"), path.join(appOut, "static"), {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes("__pycache__"),
  });

  fs.cpSync(path.join(sourceRoot, "assets"), path.join(appOut, "assets"), {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes("__pycache__"),
  });
}

export function computeSourceSha(appDir) {
  const files = walkFiles(appDir)
    .map((file) => path.relative(appDir, file).split(path.sep).join("/"))
    .filter(
      (rel) =>
        rel === "pc_sensor_app.py" ||
        (rel.startsWith("pc_sensor/") && rel.endsWith(".py")) ||
        rel.startsWith("static/") ||
        rel.startsWith("assets/"),
    )
    .sort();
  const hash = crypto.createHash("sha256");
  for (const rel of files) {
    hash.update(`${rel}\0`);
    hash.update(fs.readFileSync(path.join(appDir, ...rel.split("/"))));
  }
  return hash.digest("hex");
}
