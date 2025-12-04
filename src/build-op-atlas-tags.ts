import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
type JsonObject = { [key: string]: JsonValue };
type JsonArray = JsonValue[];

interface RawProject extends JsonObject {
  id?: JsonValue;
  rawTags?: JsonValue;
}

interface AtlasProject extends JsonObject {
  id?: JsonValue;
}

interface TagTaxonomy extends JsonObject {
  allowedTags?: JsonValue;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RAW_PROJECTS_PATH = join(
  __dirname,
  "..",
  "output",
  "raw-project-tags.json"
);
const ATLAS_PROJECTS_PATH = join(
  __dirname,
  "..",
  "output",
  "op-atlas-projects-full.json"
);
const TAG_TAXONOMY_PATH = join(__dirname, "..", "config", "tag-taxonomy.json");
const OUTPUT_PATH = join(
  __dirname,
  "..",
  "output",
  "op-atlas-projects-with-tags.json"
);

function readJsonFile(path: string): JsonValue {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (error: any) {
    throw new Error(`Failed to read JSON from ${path}: ${error.message || error}`);
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalizeTag(tag: string): string {
  return tag
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9+-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function ensureArray(value: JsonValue, name: string): JsonArray {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${name} to be an array.`);
  }
  return value;
}

function extractProjectId(raw: RawProject, index: number): string {
  const rawId = raw.id;
  if (typeof rawId === "string" && rawId.trim().length > 0) {
    return rawId;
  }
  throw new Error(`Project at index ${index} is missing a valid id.`);
}

function collectAllowedTags(taxonomy: TagTaxonomy): Map<string, string> {
  const allowedTags = ensureArray(taxonomy.allowedTags ?? [], "allowedTags");
  const map = new Map<string, string>();

  for (const tag of allowedTags) {
    if (typeof tag !== "string") {
      continue;
    }
    const canonical = canonicalizeTag(tag);
    if (canonical.length === 0) {
      continue;
    }
    map.set(canonical, tag);
  }

  if (map.size === 0) {
    throw new Error("No valid allowed tags found in tag taxonomy.");
  }

  return map;
}

function normalizeTagsFromValue(
  value: JsonValue,
  allowedTagMap: Map<string, string>
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const filtered: string[] = [];

  for (const tag of value) {
    if (typeof tag !== "string") {
      continue;
    }
    const canonical = canonicalizeTag(tag);
    if (!canonical || !allowedTagMap.has(canonical) || seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    filtered.push(allowedTagMap.get(canonical)!);
  }

  return filtered;
}

function mergeTagLists(lists: string[][]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const list of lists) {
    for (const tag of list) {
      if (seen.has(tag)) {
        continue;
      }
      seen.add(tag);
      merged.push(tag);
    }
  }

  return merged;
}

function main(): void {
  const rawProjectsValue = readJsonFile(RAW_PROJECTS_PATH);
  const atlasProjectsValue = readJsonFile(ATLAS_PROJECTS_PATH);
  const tagTaxonomyValue = readJsonFile(TAG_TAXONOMY_PATH);

  const rawProjectsArray = ensureArray(
    rawProjectsValue,
    "raw project tags file"
  );
  const atlasProjectsArray = ensureArray(
    atlasProjectsValue,
    "OP Atlas projects file"
  );

  if (!isJsonObject(tagTaxonomyValue)) {
    throw new Error("Tag taxonomy file must be a JSON object.");
  }

  const allowedTagMap = collectAllowedTags(tagTaxonomyValue as TagTaxonomy);

  const atlasById = new Map<string, AtlasProject>();
  atlasProjectsArray.forEach((entry, index) => {
    if (!isJsonObject(entry)) {
      throw new Error(`Atlas project at index ${index} is not a JSON object.`);
    }
    const idValue = entry.id;
    if (typeof idValue !== "string" || idValue.trim().length === 0) {
      throw new Error(`Atlas project at index ${index} is missing a valid id.`);
    }
    atlasById.set(idValue, entry);
  });

  const mergedProjects = rawProjectsArray.map((entry, index) => {
    if (!isJsonObject(entry)) {
      throw new Error(`Raw project at index ${index} is not a JSON object.`);
    }

    const rawProject = entry as RawProject;
    const projectId = extractProjectId(rawProject, index);
    const atlasProject = atlasById.get(projectId);

    let baseProject: JsonObject;

    if (!atlasProject) {
      const { rawTags: _rawTags, readmeContent: _readmeContent, tags: _tags, ...rest } =
        rawProject;
      console.warn(
        `⚠️  No OP Atlas record found for id ${projectId}; falling back to raw project data.`
      );
      baseProject = rest;
    } else {
      baseProject = atlasProject;
    }

    const existingAtlasTags = atlasProject
      ? normalizeTagsFromValue(atlasProject.tags as JsonValue, allowedTagMap)
      : [];
    const existingRawTags = normalizeTagsFromValue(
      rawProject.tags,
      allowedTagMap
    );
    const filteredRawTags = normalizeTagsFromValue(
      rawProject.rawTags,
      allowedTagMap
    );
    const mergedTags = mergeTagLists([
      existingAtlasTags,
      existingRawTags,
      filteredRawTags,
    ]);

    return {
      ...baseProject,
      tags: mergedTags,
    };
  });

  writeFileSync(OUTPUT_PATH, JSON.stringify(mergedProjects, null, 2));
  console.log(`✓ Wrote ${mergedProjects.length} projects to ${OUTPUT_PATH}`);
}

main();

