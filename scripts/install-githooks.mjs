import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd());
const SOURCE = resolve(ROOT, ".githooks", "pre-commit");
const DEST = resolve(ROOT, ".git", "hooks", "pre-commit");

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(resolve(ROOT, ".git")))) {
  // Not a git checkout (e.g. packaged install). Nothing to do.
  process.exit(0);
}

if (!(await exists(SOURCE))) {
  console.error(`Missing hook source at ${SOURCE}`);
  process.exit(1);
}

await mkdir(resolve(ROOT, ".git", "hooks"), { recursive: true });

const contents = await readFile(SOURCE, "utf-8");

// Only overwrite if different to avoid clobbering custom local hooks unexpectedly.
if (await exists(DEST)) {
  const current = await readFile(DEST, "utf-8");
  if (current === contents) {
    process.exit(0);
  }
}

await writeFile(DEST, contents, "utf-8");
await chmod(DEST, 0o755);

console.log("Installed git pre-commit hook.");

