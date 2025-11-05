import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface RepositoryRecord {
  crate?: unknown;
  npm_package?: unknown;
}

interface ProjectRecord {
  tags?: unknown;
  is_on_chain_contract?: unknown;
  repositories?: unknown;
}

interface CliOptions {
  inputPath: string;
  outputPath: string;
  dryRun: boolean;
}

const DEFAULT_RESULTS_PATH = resolve(
  __dirname,
  "..",
  "output",
  "results.json"
);

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);

  let inputPath = DEFAULT_RESULTS_PATH;
  let outputPath = DEFAULT_RESULTS_PATH;
  let dryRun = false;

  const resolveArgPath = (value: string) => resolve(process.cwd(), value);

  const takeValue = (index: number, flag: string): string => {
    const arg = args[index];
    if (arg.includes("=")) {
      const [, ...rest] = arg.split("=");
      const value = rest.join("=");
      if (!value) {
        throw new Error(`Missing value for ${flag}`);
      }
      return value;
    }

    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return next;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--input" || arg.startsWith("--input=")) {
      const value = takeValue(i, "--input");
      inputPath = resolveArgPath(value);
      if (!arg.includes("=")) {
        i++;
      }
      continue;
    }

    if (arg === "--output" || arg.startsWith("--output=")) {
      const value = takeValue(i, "--output");
      outputPath = resolveArgPath(value);
      if (!arg.includes("=")) {
        i++;
      }
      continue;
    }

    throw new Error(`Unrecognized argument: ${arg}`);
  }

  return { inputPath, outputPath, dryRun };
}

function printUsage(): void {
  console.log(`Usage: tsx src/cleanup-tags.ts [options]

Options:
  --input <path>    Path to the source results JSON (defaults to ${DEFAULT_RESULTS_PATH})
  --output <path>   Path to write the updated JSON (defaults to input path)
  --dry-run         Process without writing changes to disk
  -h, --help        Show this help message
`);
}

function ensureArrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const results: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed.length > 0) {
        results.push(trimmed);
      }
    }
  }
  return results;
}

function isTruthyBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1";
  }
  if (typeof value === "number") {
    return value === 1;
  }
  return false;
}

function projectHasEligibleLibraryRepo(repositories: unknown): boolean {
  if (!Array.isArray(repositories)) {
    return false;
  }

  return repositories.some((repo) => {
    if (repo && typeof repo === "object") {
      const record = repo as RepositoryRecord;
      return isTruthyBoolean(record.crate) || isTruthyBoolean(record.npm_package);
    }
    return false;
  });
}

function sanitizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const tag of tags) {
    if (!seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }

  return result;
}

function cleanProjectTags(project: ProjectRecord): { tags: string[]; changed: boolean } {
  const originalTags = ensureArrayOfStrings(project.tags);
  if (originalTags.length === 0) {
    return { tags: originalTags, changed: false };
  }

  const removable = new Set(["sdk", "api"]);
  const hasOnchainContract = isTruthyBoolean(project.is_on_chain_contract);
  const keepLibrary = projectHasEligibleLibraryRepo(project.repositories);

  let changed = false;
  const filtered = originalTags.filter((tag) => {
    const canonical = tag.trim().toLowerCase();

    if (removable.has(canonical)) {
      changed = true;
      return false;
    }

    if (canonical === "smart-contracts" && !hasOnchainContract) {
      changed = true;
      return false;
    }

    if (canonical === "library" && !keepLibrary) {
      changed = true;
      return false;
    }

    return true;
  });

  const deduped = sanitizeTags(filtered);
  if (deduped.length !== originalTags.length) {
    changed = true;
  }

  return { tags: deduped, changed };
}

function main(): void {
  try {
    const { inputPath, outputPath, dryRun } = parseCliArgs();

    if (!existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputPath}`);
    }

    const raw = readFileSync(inputPath, "utf-8");
    const data = JSON.parse(raw);

    if (!Array.isArray(data)) {
      throw new Error("Expected input JSON to be an array of projects.");
    }

    let modifiedCount = 0;

    const updated = data.map((project) => {
      if (!project || typeof project !== "object") {
        return project;
      }

      const result = cleanProjectTags(project as ProjectRecord);
      if (result.changed) {
        modifiedCount += 1;
      }

      if ((project as ProjectRecord).tags !== undefined) {
        (project as ProjectRecord).tags = result.tags;
      } else if (result.tags.length > 0) {
        (project as ProjectRecord).tags = result.tags;
      }

      return project;
    });

    const tagCounts = new Map<string, number>();
    updated.forEach((project) => {
      if (!project || typeof project !== "object") {
        return;
      }

      const tags = ensureArrayOfStrings((project as ProjectRecord).tags);
      tags.forEach((tag) => {
        const canonical = tag.trim();
        if (!canonical) {
          return;
        }
        tagCounts.set(canonical, (tagCounts.get(canonical) || 0) + 1);
      });
    });

    const topTags = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    if (!dryRun) {
      writeFileSync(outputPath, JSON.stringify(updated, null, 2));
    }

    console.log(`Processed ${data.length} projects.`);
    console.log(
      `Tags updated for ${modifiedCount} project${modifiedCount === 1 ? "" : "s"}.`
    );
    console.log(
      dryRun
        ? "Dry run complete. No files were written."
        : `Updated results written to: ${outputPath}`
    );
    console.log("Top 20 tags by project count:");
    if (topTags.length === 0) {
      console.log("  (none)");
    } else {
      const totalTopTags = topTags.reduce((sum, [, count]) => sum + count, 0);
      topTags.forEach(([tag, count], index) => {
        console.log(`  ${index + 1}. ${tag}: ${count}`);
      });
      console.log(`Total tally across top 20: ${totalTopTags}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ ${message}`);
    printUsage();
    process.exit(1);
  }
}

main();

