import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

interface CollapseSummary {
  totalRecords: number;
  uniqueIds: number;
  usedRecords: number;
  mergedRecords: number;
  missingId: number;
  missingMetadata: number;
  olderRecordsSkipped: number;
}

const USAGE = `
Usage: tsx src/collapse-json-by-id.ts <inputPath> [outputPath] [idField] [metadataField] [selfFundingPath] [opRewardsPath]

Collapses records in a JSON array by merging objects that share the same id (default: "id").
Only records with the most recent metadata field value (default: "last_metadata_update") are merged.
All merged fields are returned as arrays of unique, non-empty values.
If a funding dataset path is provided, entries are joined by project id and emitted as "selfReportedFunding".
If an OP rewards dataset path is provided, entries are joined by project id and emitted as "opRewards".
`;

async function main() {
  const [
    inputPath,
    outputPathArg,
    idFieldArg,
    metadataFieldArg,
    selfFundingPathArg,
    opRewardsPathArg,
  ] = process.argv.slice(2);

  if (!inputPath) {
    console.error(USAGE.trim());
    process.exitCode = 1;
    return;
  }

  const idField = idFieldArg ?? 'id';
  const metadataField = metadataFieldArg ?? 'last_metadata_update';
  const absoluteInputPath = resolveAbsolutePath(inputPath);

const outputPath = resolveOutputPath(absoluteInputPath, outputPathArg);

  let raw: string;
  try {
    raw = await readFile(absoluteInputPath, 'utf-8');
  } catch (error) {
    console.error(`Failed to read input file at ${absoluteInputPath}:`, error);
    process.exitCode = 1;
    return;
  }

  let records: JsonObject[];
  try {
    records = parseRecords(raw);
  } catch (error) {
    console.error('Unable to parse input file as JSON array or newline-delimited JSON objects:', error);
    process.exitCode = 1;
    return;
  }

  const { collapsed, summary } = collapseRecords(records, idField, metadataField);

  let selfFunding: Map<string, JsonObject[]> | undefined;
  if (selfFundingPathArg) {
    try {
      selfFunding = await loadFundingIndex(selfFundingPathArg, 'self-reported funding');
    } catch (error) {
      console.error(String(error));
      process.exitCode = 1;
      return;
    }
  }

  let opRewards: Map<string, JsonObject[]> | undefined;
  if (opRewardsPathArg) {
    try {
      opRewards = await loadFundingIndex(opRewardsPathArg, 'OP rewards');
    } catch (error) {
      console.error(String(error));
      process.exitCode = 1;
      return;
    }
  }

  const finalRecords = applyFundingAttachments(collapsed, idField, {
    selfReportedFunding: selfFunding,
    opRewards,
  });

  try {
    await writeFile(outputPath, JSON.stringify(finalRecords, null, 2));
  } catch (error) {
    console.error(`Failed to write output file at ${outputPath}:`, error);
    process.exitCode = 1;
    return;
  }

  logSummary({ ...summary, outputPath, idField, metadataField });
}

function resolveAbsolutePath(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

function resolveOutputPath(inputPath: string, outputPathArg?: string): string {
  if (outputPathArg) {
    return resolveAbsolutePath(outputPathArg);
  }

  const { dir, name, ext } = path.parse(inputPath);
  const suffix = '.collapsed';
  const finalExt = ext || '.json';
  return path.join(dir, `${name}${suffix}${finalExt}`);
}

function parseRecords(raw: string): JsonObject[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed as JsonObject[];
    }
  } catch (error) {
    // Fall back to newline-delimited JSON (NDJSON).
    const records = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    if (!records.every((record) => isJsonObject(record))) {
      throw error;
    }
    return records as JsonObject[];
  }

  throw new Error('Expected a JSON array or newline-delimited JSON objects.');
}

async function loadFundingIndex(pathArg: string, label: string): Promise<Map<string, JsonObject[]>> {
  const absolutePath = resolveAbsolutePath(pathArg);

  let raw: string;
  try {
    raw = await readFile(absolutePath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${label} data from ${absolutePath}: ${message}`);
  }

  let records: JsonObject[];
  try {
    records = parseRecords(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${label} data from ${absolutePath}: ${message}`);
  }

  return buildFundingIndex(records);
}

function collapseRecords(records: JsonObject[], idField: string, metadataField: string) {
  const byId = new Map<
    string,
    {
      metadata: JsonValue;
      records: JsonObject[];
    }
  >();

  let missingId = 0;
  let missingMetadata = 0;
  let olderRecordsSkipped = 0;

  for (const record of records) {
    if (!isJsonObject(record) || !(idField in record)) {
      missingId += 1;
      continue;
    }

    if (!(metadataField in record)) {
      missingMetadata += 1;
      continue;
    }

    const metadataValue = record[metadataField];
    if (isMeaninglessMetadata(metadataValue)) {
      missingMetadata += 1;
      continue;
    }

    const idValue = record[idField];
    const idKey = buildIdKey(idValue);
    const existing = byId.get(idKey);

    if (!existing) {
      byId.set(idKey, { metadata: metadataValue, records: [record] });
      continue;
    }

    const comparison = compareMetadata(metadataValue, existing.metadata);

    if (comparison > 0) {
      olderRecordsSkipped += existing.records.length;
      existing.metadata = metadataValue;
      existing.records = [record];
    } else if (comparison === 0) {
      existing.records.push(record);
    } else {
      olderRecordsSkipped += 1;
    }
  }

  const collapsed: JsonObject[] = [];
  let usedRecords = 0;

  for (const { records: groupedRecords } of byId.values()) {
    collapsed.push(mergeGroupRecords(groupedRecords));
    usedRecords += groupedRecords.length;
  }

  const summary: CollapseSummary = {
    totalRecords: records.length,
    uniqueIds: collapsed.length,
    usedRecords,
    mergedRecords: usedRecords - collapsed.length,
    missingId,
    missingMetadata,
    olderRecordsSkipped,
  };

  return { collapsed, summary };
}

function applyFundingAttachments(
  records: JsonObject[],
  idField: string,
  attachments: Record<string, Map<string, JsonObject[]> | undefined>,
) {
  for (const [field, dataset] of Object.entries(attachments)) {
    if (!dataset) {
      continue;
    }

    attachFundingData(records, dataset, idField, field);
  }

  return records;
}

function attachFundingData(
  records: JsonObject[],
  fundingById: Map<string, JsonObject[]>,
  idField: string,
  targetField: string,
) {
  for (const record of records) {
    const identifier = record[idField] as JsonValue | undefined;
    if (identifier === undefined) {
      continue;
    }

    const fundingEntries = fundingById.get(buildIdKey(identifier));
    if (!fundingEntries || fundingEntries.length === 0) {
      continue;
    }

    const existing = record[targetField] as JsonValue | undefined;
    record[targetField] = mergeFundingEntries(existing, fundingEntries);
  }

  return records;
}

function mergeFundingEntries(existing: JsonValue | undefined, incoming: JsonObject[]): JsonObject[] {
  const entries: JsonObject[] = [];
  const seen = new Map<string, JsonObject>();

  const addEntry = (value: JsonValue) => {
    if (!isJsonObject(value)) {
      return;
    }

    const sanitized = sanitizeFundingRecord(value);
    if (Object.keys(sanitized).length === 0) {
      return;
    }

    const key = sanitized.round_id;
    const normalizedKey = createFundingKey(key, sanitized);

    const existingEntry = seen.get(normalizedKey);
    if (!existingEntry) {
      seen.set(normalizedKey, sanitized);
      return;
    }

    const choice = pickLatestByUpdatedAt(existingEntry, sanitized);
    seen.set(normalizedKey, choice);
  };

  if (existing !== undefined) {
    if (Array.isArray(existing)) {
      existing.forEach(addEntry);
    } else {
      addEntry(existing);
    }
  }

  for (const entry of incoming) {
    addEntry(entry);
  }

  for (const value of seen.values()) {
    entries.push(removeFundingInternalKeys(value));
  }

  return entries;
}

function buildFundingIndex(records: JsonObject[]): Map<string, JsonObject[]> {
  const byProjectId = new Map<string, JsonObject[]>();

  for (const record of records) {
    if (!isJsonObject(record)) {
      continue;
    }

    const projectIdentifier = record.project_id as JsonValue | undefined;
    if (projectIdentifier === undefined || isMeaningless(projectIdentifier)) {
      continue;
    }

    const amount = record.amount as JsonValue | undefined;
    if (!hasMeaningfulAmount(amount)) {
      continue;
    }

    const sanitized = sanitizeFundingRecord(record);
    if (Object.keys(sanitized).length === 0) {
      continue;
    }

    const key = buildIdKey(projectIdentifier);
    const bucket = byProjectId.get(key);
    if (bucket) {
      bucket.push(sanitized);
    } else {
      byProjectId.set(key, [sanitized]);
    }
  }

  return byProjectId;
}

function mergeGroupRecords(records: JsonObject[]): JsonObject {
  const merged: JsonObject = {};
  const repositoryAccumulator: JsonObject[] = [];

  for (const record of records) {
    const { repoEntries, otherEntries } = extractRepositoryEntries(record);
    repositoryAccumulator.push(...repoEntries);

    for (const [key, value] of otherEntries) {
      merged[key] = mergeField(merged[key], value);
    }
  }

  if (repositoryAccumulator.length > 0) {
    merged.repositories = mergeRepositories(merged.repositories, repositoryAccumulator);
  }

  return merged;
}

function mergeField(existing: JsonValue | undefined, incoming: JsonValue): JsonValue {
  const values: JsonValue[] = [];
  const seen = new Set<string>();

  const addValue = (value: JsonValue) => {
    if (isMeaningless(value)) {
      return;
    }
    const key = stableStringify(value);
    if (!seen.has(key)) {
      seen.add(key);
      values.push(cloneJsonValue(value));
    }
  };

  if (existing !== undefined) {
    if (Array.isArray(existing)) {
      existing.forEach(addValue);
    } else {
      addValue(existing);
    }
  }

  if (Array.isArray(incoming)) {
    incoming.forEach(addValue);
  } else {
    addValue(incoming);
  }

  if (values.length === 0) {
    return existing ?? [];
  }

  return values.length === 1 ? values[0] : values;
}

function hasMeaningfulAmount(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return false;
    }

    const numeric = Number(trimmed.replace(/,/g, ''));
    if (!Number.isNaN(numeric)) {
      return numeric !== 0;
    }

    return true;
  }

  return true;
}

function sanitizeFundingRecord(record: JsonObject): JsonObject {
  const sanitized: JsonObject = {};

  for (const [key, value] of Object.entries(record)) {
    if (isInternalKey(key)) {
      continue;
    }

    sanitized[key] = cloneJsonValue(value);
  }

  return sanitized;
}

function removeFundingInternalKeys(record: JsonObject): JsonObject {
  const sanitized: JsonObject = {};

  for (const [key, value] of Object.entries(record)) {
    if (key === 'id' || key === 'project_id') {
      continue;
    }

    sanitized[key] = cloneJsonValue(value);
  }

  return sanitized;
}

function createFundingKey(roundId: JsonValue | undefined, record: JsonObject): string {
  if (typeof roundId === 'string' && roundId.trim().length > 0) {
    return `round:${roundId.trim()}`;
  }

  return `entry:${stableStringify(record)}`;
}

function pickLatestByUpdatedAt(left: JsonObject, right: JsonObject): JsonObject {
  const leftTimestamp = toTimestamp(left.updated_at as JsonValue);
  const rightTimestamp = toTimestamp(right.updated_at as JsonValue);

  if (leftTimestamp !== null && rightTimestamp !== null) {
    return rightTimestamp > leftTimestamp ? right : left;
  }

  const leftComparable = toComparableString(left.updated_at as JsonValue);
  const rightComparable = toComparableString(right.updated_at as JsonValue);

  if (leftComparable === rightComparable) {
    return right;
  }

  return rightComparable > leftComparable ? right : left;
}

function compareMetadata(nextValue: JsonValue, currentValue: JsonValue): number {
  const nextTimestamp = toTimestamp(nextValue);
  const currentTimestamp = toTimestamp(currentValue);

  if (nextTimestamp !== null && currentTimestamp !== null && nextTimestamp !== currentTimestamp) {
    return nextTimestamp > currentTimestamp ? 1 : -1;
  }

  const nextComparable = toComparableString(nextValue);
  const currentComparable = toComparableString(currentValue);

  if (nextComparable === currentComparable) {
    return 0;
  }

  return nextComparable > currentComparable ? 1 : -1;
}

function toTimestamp(value: JsonValue): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function toComparableString(value: JsonValue): string {
  if (value === null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return stableStringify(value);
}

function extractRepositoryEntries(record: JsonObject) {
  const repoFields: Record<string, JsonValue> = {};
  const repoObjects: JsonObject[] = [];
  const otherEntries: Array<[string, JsonValue]> = [];

  for (const [key, value] of Object.entries(record)) {
    if (isInternalKey(key)) {
      continue;
    }

    if (key === 'repositories') {
      repoObjects.push(...normalizeRepositoryCollection(value));
      continue;
    }

    if (key.startsWith('repo_')) {
      const trimmedKey = key.slice(5);
      if (trimmedKey.length > 0) {
        repoFields[trimmedKey] = value;
      }
      continue;
    }

    otherEntries.push([key, value]);
  }

  const repoEntries = [...repoObjects, ...buildRepositoryObjects(repoFields)];
  return { repoEntries, otherEntries };
}

function buildRepositoryObjects(repoFields: Record<string, JsonValue>): JsonObject[] {
  const normalized: Record<string, JsonValue[]> = {};
  let maxLength = 0;

  for (const [key, value] of Object.entries(repoFields)) {
    const values = normalizeRepositoryValue(value);
    if (values.length === 0) {
      continue;
    }
    normalized[key] = values;
    if (values.length > maxLength) {
      maxLength = values.length;
    }
  }

  if (maxLength === 0) {
    return [];
  }

  const repositories: JsonObject[] = [];

  for (let index = 0; index < maxLength; index += 1) {
    const repository: JsonObject = {};

    for (const [key, values] of Object.entries(normalized)) {
      const value = values[index] ?? (values.length === 1 ? values[0] : undefined);
      if (value !== undefined) {
        repository[key] = cloneJsonValue(value);
      }
    }

    if (Object.keys(repository).length > 0) {
      repositories.push(repository);
    }
  }

  return repositories;
}

function normalizeRepositoryValue(value: JsonValue): JsonValue[] {
  if (Array.isArray(value)) {
    return value.filter((item) => !isMeaningless(item));
  }

  if (isMeaningless(value)) {
    return [];
  }

  return [value];
}

function mergeRepositories(existing: JsonValue | undefined, incoming: JsonObject[]): JsonValue {
  const byKey = new Map<string, JsonObject>();
  const order: string[] = [];

  const upsert = (value: JsonValue) => {
    if (!isJsonObject(value)) {
      return;
    }

    const sanitized = sanitizeRepositoryObject(value);
    if (Object.keys(sanitized).length === 0) {
      return;
    }

    const key = buildRepositoryKey(sanitized);
    const existingRepo = byKey.get(key);

    if (!existingRepo) {
      byKey.set(key, cloneJsonObject(sanitized));
      order.push(key);
      return;
    }

    for (const [field, entry] of Object.entries(sanitized)) {
      existingRepo[field] = mergeField(existingRepo[field], entry);
    }
  };

  if (existing !== undefined) {
    if (Array.isArray(existing)) {
      existing.forEach(upsert);
    } else {
      upsert(existing);
    }
  }

  incoming.forEach(upsert);

  return order.map((key) => cloneJsonObject(byKey.get(key)!));
}

function normalizeRepositoryCollection(value: JsonValue): JsonObject[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is JsonObject => isJsonObject(item))
      .map((item) => sanitizeRepositoryObject(item));
  }

  if (isJsonObject(value)) {
    return [sanitizeRepositoryObject(value)];
  }

  return [];
}

function sanitizeRepositoryObject(value: JsonObject): JsonObject {
  const sanitized: JsonObject = {};

  for (const [key, entry] of Object.entries(value)) {
    if (isInternalKey(key)) {
      continue;
    }

    sanitized[key] = cloneJsonValue(entry);
  }

  return sanitized;
}

function buildRepositoryKey(repository: JsonObject): string {
  const url = repository.url;
  if (typeof url === 'string' && url.trim().length > 0) {
    return `url:${url.trim()}`;
  }

  const id = repository.id;
  if (typeof id === 'string' && id.trim().length > 0) {
    return `id:${id.trim()}`;
  }

  const type = repository.type;
  if (typeof type === 'string' && type.trim().length > 0) {
    return `type:${type.trim()}`;
  }

  return `anon:${stableStringify(repository)}`;
}

function isInternalKey(key: string): boolean {
  return key.startsWith('_dlt');
}

function cloneJsonObject(value: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = cloneJsonValue(entry);
  }
  return result;
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item));
  }

  return cloneJsonObject(value);
}

function stableStringify(value: JsonValue): string {
  if (value === null) {
    return 'null';
  }

  const valueType = typeof value;
  if (valueType === 'number' || valueType === 'boolean') {
    return JSON.stringify(value);
  }

  if (valueType === 'string') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const entries = Object.entries(value)
    .map(([key, entry]) => [key, entry] as const)
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB));

  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

function buildIdKey(value: JsonValue): string {
  if (value === null) {
    return 'null';
  }

  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
    return String(value);
  }

  return stableStringify(value);
}

function isMeaninglessMetadata(value: JsonValue): boolean {
  if (value === null) {
    return true;
  }

  if (typeof value === 'string') {
    return value.trim().length === 0;
  }

  return false;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMeaningless(value: JsonValue): boolean {
  if (value === null) {
    return true;
  }

  if (typeof value === 'string') {
    return value.trim().length === 0;
  }

  return false;
}

function logSummary(
  summary: CollapseSummary & { outputPath: string; idField: string; metadataField: string },
) {
  const {
    totalRecords,
    uniqueIds,
    usedRecords,
    mergedRecords,
    missingId,
    missingMetadata,
    olderRecordsSkipped,
    outputPath,
    idField,
    metadataField,
  } = summary;

  const lines = [
    `Collapsed records written to ${outputPath}`,
    `  Total input records: ${totalRecords}`,
    `  Unique ids: ${uniqueIds}`,
    `  Records used (latest ${metadataField}): ${usedRecords}`,
    `  Records merged: ${mergedRecords}`,
    `  Records skipped (missing ${idField}): ${missingId}`,
    `  Records skipped (missing ${metadataField}): ${missingMetadata}`,
    `  Records skipped (older ${metadataField}): ${olderRecordsSkipped}`,
  ];
  console.log(lines.join('\n'));
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exitCode = 1;
});

