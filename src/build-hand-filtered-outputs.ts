import { readFile, writeFile } from 'node:fs/promises';

type JsonObject = Record<string, unknown>;

const RESULTS_SOURCE_PATH = '/Users/elliott/dev/Developer-Tooling/bigquery/results.collapsed.json';
const HAND_FILTERED_SOURCE_PATH = '/Users/elliott/dev/Developer-Tooling/output/hand-filtered-results.json';
const MATCHED_OUTPUT_PATH = '/Users/elliott/dev/Developer-Tooling/output/hand-filtered-matched-results.json';
const ROUND7_UNMATCHED_OUTPUT_PATH =
  '/Users/elliott/dev/Developer-Tooling/output/op-rewards-round7-unmatched.json';

async function main() {
  const [results, handFiltered] = await Promise.all([
    loadJsonArray<JsonObject>(RESULTS_SOURCE_PATH, 'collapsed results dataset'),
    loadJsonArray<JsonObject>(HAND_FILTERED_SOURCE_PATH, 'hand-filtered dataset'),
  ]);

  const handFilteredIds = buildIdSet(handFiltered, HAND_FILTERED_SOURCE_PATH);

  const matched = results.filter((project) => {
    const idValue = project.id;
    if (typeof idValue !== 'string') {
      return false;
    }
    return handFilteredIds.has(idValue.toLowerCase());
  });

  const sanitizedMatched = matched.map((project) => sanitizeProject(project));

  await writeJsonFile(MATCHED_OUTPUT_PATH, sanitizedMatched);

  const matchedIds = new Set(matched.map((project) => String(project.id).toLowerCase()));

  const round7Unmatched = results.filter((project) => {
    const idValue = project.id;
    if (typeof idValue !== 'string') {
      return false;
    }

    if (matchedIds.has(idValue.toLowerCase())) {
      return false;
    }

    const rewardsRaw = project.opRewards;
    if (!Array.isArray(rewardsRaw)) {
      return false;
    }

    return rewardsRaw.some((entry) => {
      if (entry && typeof entry === 'object' && 'round_id' in entry) {
        const roundId = (entry as { round_id?: unknown }).round_id;
        return roundId === 7 || roundId === '7';
      }
      return false;
    });
  });

  const sanitizedRound7Unmatched = round7Unmatched.map((project) => sanitizeProject(project));

  await writeJsonFile(ROUND7_UNMATCHED_OUTPUT_PATH, sanitizedRound7Unmatched);

  console.log('Hand-filtered matched projects:', sanitizedMatched.length);
  console.log('Round 7 OP reward projects not already matched:', sanitizedRound7Unmatched.length);
  console.log('Matched output written to:', MATCHED_OUTPUT_PATH);
  console.log('Round 7 unmatched output written to:', ROUND7_UNMATCHED_OUTPUT_PATH);
}

async function loadJsonArray<T extends JsonObject>(absolutePath: string, label: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(absolutePath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${label} at ${absolutePath}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${label} at ${absolutePath} as JSON: ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Expected ${label} at ${absolutePath} to be a JSON array.`);
  }

  return parsed as T[];
}

function buildIdSet(records: JsonObject[], sourcePath: string): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    const idValue = record?.id;
    if (typeof idValue !== 'string') {
      continue;
    }
    ids.add(idValue.toLowerCase());
  }

  if (ids.size === 0) {
    console.warn(`Warning: no valid id fields found in ${sourcePath}.`);
  }

  return ids;
}

function sanitizeProject(project: JsonObject): JsonObject {
  const clone = JSON.parse(JSON.stringify(project)) as JsonObject;

  delete clone.open_source_observer_slug;
  delete clone.added_team_members;
  delete clone.added_funding;
  delete clone.is_submitted_to_oso;
  delete clone.kyc_team_id;
  delete clone.last_metadata_update;
  delete clone.created_at;
  delete clone.updated_at;

  if (Array.isArray(clone.repositories)) {
    clone.repositories = clone.repositories
      .filter((repo): repo is JsonObject => typeof repo === 'object' && repo !== null)
      .map((repo) => {
        const repoClone = { ...(repo as JsonObject) };
        delete repoClone.id;
        delete repoClone.created_at;
        delete repoClone.updated_at;
        return repoClone;
      });
  }

  if (Array.isArray(clone.selfReportedFunding)) {
    clone.selfReportedFunding = clone.selfReportedFunding
      .filter((entry): entry is JsonObject => typeof entry === 'object' && entry !== null)
      .map((entry) => {
        const fundingClone = { ...(entry as JsonObject) };
        delete fundingClone.created_at;
        delete fundingClone.updated_at;
        return fundingClone;
      });
  }

  if (Array.isArray(clone.opRewards)) {
    clone.opRewards = clone.opRewards
      .filter((entry): entry is JsonObject => typeof entry === 'object' && entry !== null)
      .map((entry) => {
        const rewardClone = { ...(entry as JsonObject) };
        delete rewardClone.created_at;
        delete rewardClone.updated_at;
        return rewardClone;
      });
  }

  return clone;
}

async function writeJsonFile(absolutePath: string, data: JsonObject[]): Promise<void> {
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(absolutePath, payload, 'utf-8');
}

void main();

