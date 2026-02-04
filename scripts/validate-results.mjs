import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function fail(message) {
  // eslint-disable-next-line no-console
  console.error(`❌ ${message}`);
  process.exitCode = 1;
}

function warn(message) {
  // eslint-disable-next-line no-console
  console.warn(`⚠️  ${message}`);
}

function isNonEmptyString(x) {
  return typeof x === "string" && x.trim().length > 0;
}

function isOptionalString(x) {
  return x === undefined || x === null || typeof x === "string";
}

function isValidHttpUrl(x) {
  if (!isNonEmptyString(x)) return false;
  try {
    const u = new URL(x);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function loadJson(path) {
  const raw = await readFile(path, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`Invalid JSON at ${path}: ${String(e)}`);
    return null;
  }
}

const ROOT = resolve(process.cwd());
const RESULTS_PATH = resolve(ROOT, "output", "results.json");
const TAXONOMY_PATH = resolve(ROOT, "output", "taxonomy.json");

const taxonomy = await loadJson(TAXONOMY_PATH);
const results = await loadJson(RESULTS_PATH);

if (!taxonomy || !results) {
  process.exit(process.exitCode || 1);
}

const tagsList = taxonomy?.tags;
if (!Array.isArray(tagsList) || tagsList.some((t) => !isNonEmptyString(t))) {
  fail(`taxonomy.tags must be an array of non-empty strings in ${TAXONOMY_PATH}`);
}
const allowedTags = new Set((tagsList || []).map((t) => t.trim()));

const categoryDefs = taxonomy?.categories?.definitions;
if (!Array.isArray(categoryDefs)) {
  fail(`taxonomy.categories.definitions must be an array in ${TAXONOMY_PATH}`);
}
const allowedCategories = new Set(
  (categoryDefs || [])
    .map((c) => (c && typeof c === "object" ? c.name : null))
    .filter(isNonEmptyString)
);

if (!Array.isArray(results)) {
  fail(`results.json must be an array at ${RESULTS_PATH}`);
  process.exit(process.exitCode || 1);
}

const seenIds = new Set();

for (let i = 0; i < results.length; i++) {
  const entry = results[i];
  const where = `results[${i}]`;

  if (!entry || typeof entry !== "object") {
    fail(`${where} must be an object`);
    continue;
  }

  // id
  if (!isNonEmptyString(entry.id)) {
    fail(`${where}.id must be a non-empty string`);
  } else {
    if (seenIds.has(entry.id)) {
      fail(`${where}.id is duplicated: "${entry.id}"`);
    }
    seenIds.add(entry.id);
  }

  // name
  if (!isNonEmptyString(entry.name)) {
    fail(`${where}.name must be a non-empty string`);
  }

  // description
  if (!isNonEmptyString(entry.description)) {
    fail(`${where}.description must be a non-empty string`);
  }

  // llmstext
  if (!isOptionalString(entry.llmstext)) {
    fail(`${where}.llmstext must be a string if present`);
  }

  // repos
  if (!Array.isArray(entry.repos) || entry.repos.length < 1) {
    fail(`${where}.repos must be a non-empty array`);
  } else {
    for (let r = 0; r < entry.repos.length; r++) {
      const repoUrl = entry.repos[r];
      if (!isValidHttpUrl(repoUrl)) {
        fail(`${where}.repos[${r}] must be a valid http(s) URL`);
      }
    }
  }

  // tags
  if (!Array.isArray(entry.tags) || entry.tags.length < 1) {
    fail(`${where}.tags must be a non-empty array`);
  } else {
    for (let t = 0; t < entry.tags.length; t++) {
      const tag = entry.tags[t];
      if (!isNonEmptyString(tag)) {
        fail(`${where}.tags[${t}] must be a non-empty string`);
        continue;
      }
      if (!allowedTags.has(tag)) {
        fail(`${where}.tags contains unknown tag "${tag}" (not in taxonomy.json)`);
      }
    }
  }

  // category
  if (!isNonEmptyString(entry.category)) {
    fail(`${where}.category must be a non-empty string`);
  } else if (!allowedCategories.has(entry.category)) {
    fail(`${where}.category "${entry.category}" does not match any taxonomy category name`);
  }
}

if (process.exitCode && process.exitCode !== 0) {
  // eslint-disable-next-line no-console
  console.error("\nValidation failed.");
  process.exit(process.exitCode);
} else {
  // eslint-disable-next-line no-console
  console.log("✅ Validation passed.");
}

