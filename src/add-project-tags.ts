import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";
import { config as loadEnvFile } from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const loadedEnvFiles: string[] = [];
const envFileCandidates = [
  join(__dirname, "..", ".env.local"),
  join(__dirname, "..", ".env"),
];

for (const envPath of envFileCandidates) {
  if (existsSync(envPath)) {
    loadEnvFile({ path: envPath, override: true });
    loadedEnvFiles.push(envPath);
  }
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_USER_AGENT =
  process.env.GITHUB_USER_AGENT || "developer-tooling-tagging-script/1.0";
const TAG_TAXONOMY_PATH = join(
  __dirname,
  "..",
  "config",
  "tag-taxonomy.json"
);
const LANGUAGE_CACHE_PATH = join(
  __dirname,
  "..",
  "output",
  "github-language-cache.json"
);

const REQUESTS_PER_MINUTE = 30;
const DELAY_BETWEEN_REQUESTS = Math.ceil(60000 / REQUESTS_PER_MINUTE); // ~2 seconds
const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY = 2000;
const CHECKPOINT_FILE = join(
  __dirname,
  "..",
  "output",
  "tagging-checkpoint.json"
);

type JsonObject = Record<string, unknown>;

interface RawRepository extends JsonObject {
  url?: unknown;
}

interface RawProject extends JsonObject {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  category?: unknown;
  repositories?: unknown;
  tags?: unknown;
}

interface Project {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  repos: string[];
  tags?: string[];
  languages?: string[];
}

interface Checkpoint {
  lastProcessedIndex: number;
  processedIds: Set<string>;
  timestamp: string;
}

interface TaggingResult {
  tags: string[];
  reasoning?: string;
}

interface TagConfigFile {
  allowedTags: string[];
  aliases?: Record<string, string>;
  fallbackTag?: string;
}

interface TagRuntimeConfig {
  allowedTags: string[];
  allowedTagSet: Set<string>;
  aliasMap: Map<string, string>;
  fallbackTag: string;
}

interface RepoLanguageCacheEntry {
  fetchedAt: string;
  languages: Record<string, number>;
}

interface ProjectLanguageSummary {
  hasData: boolean;
  languagePercentages: Record<string, number>;
  perRepoSummaries: string[];
}

interface CliOptions {
  restart: boolean;
  limit?: number;
  startIndex?: number;
  batchSize: number;
}

type LLMProvider = "groq" | "openai";

interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

const MAX_TAGS = 10;
const DEFAULT_BATCH_SIZE = 50;

function canonicalizeTagString(tag: string): string {
  return tag
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9+-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function loadTagConfig(): TagRuntimeConfig {
  if (!existsSync(TAG_TAXONOMY_PATH)) {
    throw new Error(`Tag taxonomy file not found: ${TAG_TAXONOMY_PATH}`);
  }

  try {
    const raw = JSON.parse(
      readFileSync(TAG_TAXONOMY_PATH, "utf-8")
    ) as TagConfigFile;

    const allowedTags = (raw.allowedTags || [])
      .map((tag) => canonicalizeTagString(tag))
      .filter((tag) => tag.length > 0);

    const allowedTagSet = new Set<string>(allowedTags);

    const aliasMap = new Map<string, string>();
    if (raw.aliases) {
      Object.entries(raw.aliases).forEach(([alias, target]) => {
        const canonicalAlias = canonicalizeTagString(alias);
        const canonicalTarget = canonicalizeTagString(target);
        if (!canonicalAlias || !canonicalTarget) {
          return;
        }
        aliasMap.set(canonicalAlias, canonicalTarget);
      });
    }

    const fallbackTag =
      canonicalizeTagString(raw.fallbackTag || "general") || "general";

    if (!allowedTagSet.has(fallbackTag)) {
      allowedTagSet.add(fallbackTag);
      allowedTags.push(fallbackTag);
    }

    return {
      allowedTags,
      allowedTagSet,
      aliasMap,
      fallbackTag,
    };
  } catch (error: any) {
    throw new Error(`Failed to load tag taxonomy: ${error.message || error}`);
  }
}

function parseFloatWithDefault(
  value: string | undefined,
  defaultValue: number
): number {
  if (!value) {
    return defaultValue;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseIntWithDefault(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function loadLLMConfig(): LLMConfig {
  const defaultProvider: LLMProvider = process.env.OPENAI_API_KEY
    ? "openai"
    : "groq";
  const providerEnv = (process.env.LLM_PROVIDER || defaultProvider).toLowerCase();
  const provider: LLMProvider = providerEnv === "openai" ? "openai" : "groq";

  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }

    return {
      provider,
      apiKey,
      baseUrl:
        process.env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions",
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: parseFloatWithDefault(process.env.OPENAI_TEMPERATURE, 0.2),
      maxTokens: parseIntWithDefault(process.env.OPENAI_MAX_TOKENS, 200),
    };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY environment variable is not set");
  }

  return {
    provider,
    apiKey,
    baseUrl:
      process.env.GROQ_API_URL ||
      "https://api.groq.com/openai/v1/chat/completions",
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    temperature: parseFloatWithDefault(process.env.GROQ_TEMPERATURE, 0.2),
    maxTokens: parseIntWithDefault(process.env.GROQ_MAX_TOKENS, 200),
  };
}

function resolveCliArgs(): string[] {
  const directArgs = process.argv.slice(2);
  if (directArgs.length > 0) {
    return directArgs;
  }

  const envArgvRaw =
    process.env.npm_config_argv || process.env.NPM_CONFIG_ARGV || "";
  if (!envArgvRaw) {
    return directArgs;
  }

  try {
    const parsed = JSON.parse(envArgvRaw);
    const cooked: string[] = Array.isArray(parsed?.cooked)
      ? parsed.cooked
      : [];
    if (cooked.length === 0) {
      return directArgs;
    }

    const doubleDashIndex = cooked.indexOf("--");
    if (doubleDashIndex >= 0 && doubleDashIndex < cooked.length - 1) {
      return cooked.slice(doubleDashIndex + 1);
    }

    if (cooked[0] === "run" || cooked[0] === "exec") {
      return cooked.slice(2);
    }

    return cooked.slice(1);
  } catch (error) {
    console.warn("⚠️  Failed to parse npm_config_argv:", error);
    return directArgs;
  }
}

function parseCliArgs(): CliOptions {
  const args = resolveCliArgs();
  const envBatchSize = parseIntWithDefault(
    process.env.TAG_BATCH_SIZE || process.env.BATCH_SIZE,
    DEFAULT_BATCH_SIZE
  );

  const options: CliOptions = {
    restart: false,
    batchSize: envBatchSize > 0 ? envBatchSize : DEFAULT_BATCH_SIZE,
  };

  const requireValue = (
    flag: string,
    value: string | undefined
  ): string => {
    if (value && value.length > 0) {
      return value;
    }
    console.error(`❌ Missing value for ${flag}`);
    process.exit(1);
  };

  const parsePositiveInt = (flag: string, raw: string | undefined): number => {
    const value = Number.parseInt(requireValue(flag, raw), 10);
    if (!Number.isFinite(value) || value <= 0) {
      console.error(`❌ ${flag} expects a positive integer value.`);
      process.exit(1);
    }
    return value;
  };

  const parsePositiveIntValue = (flag: string, raw: string): number => {
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value <= 0) {
      console.error(`❌ ${flag} expects a positive integer value.`);
      process.exit(1);
    }
    return value;
  };

  const parseNonNegativeInt = (
    flag: string,
    raw: string | undefined
  ): number => {
    const value = Number.parseInt(requireValue(flag, raw), 10);
    if (!Number.isFinite(value) || value < 0) {
      console.error(`❌ ${flag} expects a non-negative integer value.`);
      process.exit(1);
    }
    return value;
  };

  const takeValue = (
    current: string,
    next: string | undefined
  ): { value: string; consumedNext: boolean } => {
    if (current.includes("=")) {
      const value = current.split("=").slice(1).join("=");
      return { value, consumedNext: false };
    }
    if (next && !next.startsWith("-")) {
      return { value: next, consumedNext: true };
    }
    return { value: requireValue(current, next), consumedNext: false };
  };

  const envLimitRaw = process.env.TAG_LIMIT || process.env.LIMIT;
  if (envLimitRaw) {
    options.limit = parsePositiveIntValue("TAG_LIMIT", envLimitRaw);
  }

  const envStartRaw = process.env.TAG_START || process.env.START_INDEX;
  if (envStartRaw) {
    const value = Number.parseInt(envStartRaw, 10);
    if (!Number.isFinite(value) || value < 0) {
      console.error("❌ TAG_START/START_INDEX expects a non-negative integer value.");
      process.exit(1);
    }
    options.startIndex = value;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--restart") {
      options.restart = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node add-project-tags.js [options]

Options:
  --limit <n>           Process only <n> new projects this run
  --start <index>       Start processing from the given project index (0-based)
  --batch-size <n>      Override checkpoint batch size for this run
  --restart             Ignore any existing checkpoint and start fresh
  -h, --help            Show this help message`);
      process.exit(0);
    }

    if (arg === "--limit" || arg === "-n" || arg.startsWith("--limit=")) {
      const { value, consumedNext } = takeValue(arg, args[i + 1]);
      options.limit = parsePositiveInt("--limit", value);
      if (consumedNext) {
        i++;
      }
      continue;
    }

    if (
      arg === "--start" ||
      arg === "--start-index" ||
      arg.startsWith("--start=")
    ) {
      const { value, consumedNext } = takeValue(arg, args[i + 1]);
      options.startIndex = parseNonNegativeInt("--start", value);
      if (consumedNext) {
        i++;
      }
      continue;
    }

    if (arg === "--batch-size" || arg.startsWith("--batch-size=")) {
      const { value, consumedNext } = takeValue(arg, args[i + 1]);
      options.batchSize = parsePositiveInt("--batch-size", value);
      if (consumedNext) {
        i++;
      }
      continue;
    }

    console.warn(`⚠️  Unrecognized argument ignored: ${arg}`);
  }

  return options;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceOptionalString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? value : null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        return entry;
      }
    }
  }

  return null;
}

function extractRepositoryUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const urls = new Set<string>();

  for (const entry of raw) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed.length > 0) {
        urls.add(entry);
      }
      continue;
    }

    if (isRecord(entry)) {
      const urlValue = (entry as RawRepository).url;
      if (typeof urlValue === "string" && urlValue.trim().length > 0) {
        urls.add(urlValue);
      }
    }
  }

  return Array.from(urls);
}

function normalizeProject(raw: RawProject, index: number): Project {
  const rawId = raw.id;
  const rawName = raw.name;

  const id =
    typeof rawId === "string"
      ? rawId
      : typeof rawId === "number" || typeof rawId === "bigint"
      ? rawId.toString()
      : null;
  if (!id) {
    throw new Error(`Project at index ${index} is missing a valid id field.`);
  }

  const name =
    typeof rawName === "string"
      ? rawName
      : typeof rawName === "number" || typeof rawName === "bigint"
      ? rawName.toString()
      : null;
  if (!name) {
    throw new Error(`Project at index ${index} is missing a valid name field.`);
  }

  const description = coerceOptionalString(raw.description) ?? null;
  const category = coerceOptionalString(raw.category) ?? null;
  const repos = extractRepositoryUrls(raw.repositories);

  let existingTags: string[] | undefined;
  if (Array.isArray(raw.tags)) {
    const tags = raw.tags.filter((tag) => typeof tag === "string") as string[];
    existingTags = tags.length > 0 ? tags : undefined;
  }

  return {
    id,
    name,
    description,
    category,
    repos,
    tags: existingTags,
  };
}

function mergeProjectsWithTags(
  rawProjects: JsonObject[],
  taggedProjects: Project[]
): JsonObject[] {
  return rawProjects.map((rawProject, index) => {
    const merged: JsonObject = { ...rawProject };
    const tagged = taggedProjects[index];

    if (tagged?.tags) {
      merged["tags"] = tagged.tags;
    }

    return merged;
  });
}

function normalizeTag(tag: string, config: TagRuntimeConfig): string | null {
  const canonical = canonicalizeTagString(tag);
  if (!canonical) {
    return null;
  }

  const aliasTarget = config.aliasMap.get(canonical) || canonical;
  if (config.allowedTagSet.has(aliasTarget)) {
    return aliasTarget;
  }

  return null;
}

function normalizeTags(
  tags: string[] | undefined,
  config: TagRuntimeConfig
): string[] {
  if (!tags || tags.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  tags.forEach((tag) => {
    const normalizedTag = normalizeTag(tag, config);
    if (normalizedTag && !seen.has(normalizedTag)) {
      seen.add(normalizedTag);
      normalized.push(normalizedTag);
    }
  });

  return normalized;
}

function clampTags(tags: string[], max = MAX_TAGS): string[] {
  return tags.slice(0, max);
}

function ensureFallback(tags: string[], fallback: string): string[] {
  if (tags.length === 0) {
    return [fallback];
  }
  return tags;
}

function loadLanguageCache(): Map<string, RepoLanguageCacheEntry> {
  if (!existsSync(LANGUAGE_CACHE_PATH)) {
    return new Map();
  }

  try {
    const raw = JSON.parse(
      readFileSync(LANGUAGE_CACHE_PATH, "utf-8")
    ) as Record<string, RepoLanguageCacheEntry>;
    const cache = new Map<string, RepoLanguageCacheEntry>();
    Object.entries(raw).forEach(([slug, entry]) => {
      if (entry && entry.languages) {
        cache.set(slug, entry);
      }
    });
    return cache;
  } catch (error) {
    console.warn("⚠️  Error loading GitHub language cache:", error);
    return new Map();
  }
}

function saveLanguageCache(cache: Map<string, RepoLanguageCacheEntry>): void {
  const data = Object.fromEntries(cache.entries());
  writeFileSync(LANGUAGE_CACHE_PATH, JSON.stringify(data, null, 2));
}

function repoSlugFromUrl(repoUrl: string): string | null {
  if (!repoUrl) {
    return null;
  }

  if (repoUrl.startsWith("git@github.com:")) {
    const path = repoUrl
      .replace("git@github.com:", "")
      .replace(/\.git$/, "")
      .trim();
    return path;
  }

  try {
    const url = new URL(repoUrl);
    if (url.hostname !== "github.com") {
      return null;
    }
    const segments = url.pathname
      .split("/")
      .filter((segment) => segment.length > 0);
    if (segments.length < 2) {
      return null;
    }
    const owner = segments[0];
    const repo = segments[1].replace(/\.git$/, "");
    return `${owner}/${repo}`;
  } catch {
    return null;
  }
}

const cliOptions = parseCliArgs();
const tagConfig = loadTagConfig();
const llmConfig = loadLLMConfig();
const languageCache = loadLanguageCache();
const BATCH_SIZE = cliOptions.batchSize;
let languageCacheDirty = false;

async function fetchRepoLanguages(
  repoSlug: string
): Promise<Record<string, number> | null> {
  const cached = languageCache.get(repoSlug);
  if (cached) {
    return cached.languages;
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": GITHUB_USER_AGENT,
  };

  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  try {
    const response = await fetch(
      `${GITHUB_API_BASE}/repos/${repoSlug}/languages`,
      {
        headers,
        method: "GET",
      }
    );

    if (response.status === 404) {
      console.warn(`  ⚠️  GitHub repo not found: ${repoSlug}`);
      return null;
    }

    if (response.status === 403) {
      console.warn(
        `  ⚠️  GitHub API rate limit or forbidden for ${repoSlug} (status 403)`
      );
      return null;
    }

    if (!response.ok) {
      console.warn(
        `  ⚠️  GitHub API error for ${repoSlug}: ${response.status}`
      );
      return null;
    }

    const languages = (await response.json()) as Record<string, number>;

    languageCache.set(repoSlug, {
      fetchedAt: new Date().toISOString(),
      languages,
    });
    languageCacheDirty = true;

    return languages;
  } catch (error) {
    console.warn(`  ⚠️  Failed to fetch languages for ${repoSlug}:`, error);
    return null;
  }
}

function persistLanguageCache(): void {
  if (!languageCacheDirty) {
    return;
  }

  try {
    saveLanguageCache(languageCache);
    languageCacheDirty = false;
  } catch (error) {
    console.warn("⚠️  Failed to persist GitHub language cache:", error);
  }
}

async function buildProjectLanguageSummary(
  project: Project,
  config: TagRuntimeConfig
): Promise<ProjectLanguageSummary> {
  const rawTotals = new Map<string, number>();
  const perRepoSummaries: string[] = [];

  for (const repoUrl of project.repos) {
    const slug = repoSlugFromUrl(repoUrl);
    if (!slug) {
      continue;
    }

    const languages = await fetchRepoLanguages(slug);
    if (!languages) {
      continue;
    }

    const entries = Object.entries(languages);
    if (entries.length === 0) {
      continue;
    }

    const repoTotal = entries.reduce((sum, [, value]) => sum + value, 0);
    if (repoTotal === 0) {
      continue;
    }

    entries.forEach(([name, bytes]) => {
      rawTotals.set(name, (rawTotals.get(name) || 0) + bytes);
    });

    const topLanguages = [...entries]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, bytes]) => `${name} (${((bytes / repoTotal) * 100).toFixed(1)}%)`)
      .join(", ");

    if (perRepoSummaries.length < 5) {
      perRepoSummaries.push(`${slug}: ${topLanguages}`);
    }
  }

  const totalBytes = Array.from(rawTotals.values()).reduce(
    (sum, value) => sum + value,
    0
  );

  const languagePercentages: Record<string, number> = {};
  if (totalBytes > 0) {
    Array.from(rawTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .forEach(([name, bytes]) => {
        const percent = (bytes / totalBytes) * 100;
        languagePercentages[name] = parseFloat(percent.toFixed(2));
      });
  }

  return {
    hasData: totalBytes > 0,
    languagePercentages,
    perRepoSummaries,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadCheckpoint(): Checkpoint | null {
  if (!existsSync(CHECKPOINT_FILE)) {
    return null;
  }

  try {
    const data = JSON.parse(readFileSync(CHECKPOINT_FILE, "utf-8"));
    return {
      lastProcessedIndex: data.lastProcessedIndex,
      processedIds: new Set(data.processedIds),
      timestamp: data.timestamp,
    };
  } catch (error) {
    console.error("Error loading checkpoint:", error);
    return null;
  }
}

function saveCheckpoint(checkpoint: Checkpoint): void {
  const data = {
    lastProcessedIndex: checkpoint.lastProcessedIndex,
    processedIds: Array.from(checkpoint.processedIds),
    timestamp: checkpoint.timestamp,
  };
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(data, null, 2));
}

async function generateTagsWithLLM(
  project: Project,
  tagConfig: TagRuntimeConfig,
  languageSummary: ProjectLanguageSummary,
  retryCount = 0
): Promise<TaggingResult> {
  const allowedTagList = tagConfig.allowedTags.map((tag) => `- ${tag}`).join("\n");
  const languagePercentEntries = Object.entries(
    languageSummary.languagePercentages
  )
    .sort((a, b) => b[1] - a[1])
    .map(([name, percent]) => `${name}: ${percent.toFixed(1)}%`);
  const languageSummaryLines = languageSummary.hasData
    ? [
        `GitHub language percentages: ${
          languagePercentEntries.slice(0, 5).join(", ") || "None"
        }`,
        ...(languageSummary.perRepoSummaries.length > 0
          ? languageSummary.perRepoSummaries.map((line) => `- ${line}`)
          : []),
      ].join("\n")
    : "GitHub language percentages: unavailable (no usable GitHub data).";

  const normalizedLanguageHints = Object.keys(
    languageSummary.languagePercentages
  )
    .sort((a, b) =>
      languageSummary.languagePercentages[b] -
      languageSummary.languagePercentages[a]
    )
    .slice(0, 3)
    .join(", ");

  const prompt = `You are a categorization expert. Choose 3-8 tags that best describe the following blockchain/crypto project.

Allowed tags (use ONLY these slugs):
${allowedTagList}

Project details:
- Name: ${project.name}
- Category: ${project.category || "Unknown"}
- Description: ${project.description || "No description available"}
- Repository count: ${project.repos.length}

${languageSummaryLines}
- Normalized language hints: ${normalizedLanguageHints}

Return ONLY valid JSON exactly in this format:
{
  "tags": ["tag1", "tag2", "tag3"]
}

Rules:
- Pick 3-8 tags from the allowed list; do not invent new tags
- Use the provided slugs exactly as written (lowercase, hyphenated)
- Prefer tags that reflect languages, tech stack, project type, interface, and ecosystem
- If no allowed tag applies, respond with ["${tagConfig.fallbackTag}"]
- Do not include explanations or additional keys`;

  try {
    const response = await fetch(llmConfig.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llmConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: llmConfig.model,
        messages: [
          {
            role: "system",
            content:
              "You are a technical categorization expert. Always respond with valid JSON only.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: llmConfig.temperature,
        max_tokens: llmConfig.maxTokens,
        top_p: 1,
      }),
    });

    if (response.status === 429) {
      const retryDelay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
      console.log(
        `  ⚠️  ${llmConfig.provider.toUpperCase()} rate limited (429). Waiting ${
          retryDelay / 1000
        }s before retry ${
          retryCount + 1
        }/${MAX_RETRIES}...`
      );
      await sleep(retryDelay);

      if (retryCount < MAX_RETRIES) {
        return generateTagsWithLLM(
          project,
          tagConfig,
          languageSummary,
          retryCount + 1
        );
      }
      throw new Error("Max retries reached after rate limiting");
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `${llmConfig.provider.toUpperCase()} API error (${response.status}): ${errorText}`
      );
    }

    const data = await response.json();
    const content = data.choices[0].message.content.trim();

    let result: TaggingResult;
    try {
      const jsonMatch =
        content.match(/```json\s*([\s\S]*?)\s*```/) ||
        content.match(/```\s*([\s\S]*?)\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content;
      result = JSON.parse(jsonStr);
    } catch (parseError) {
      console.log(`  ⚠️  Failed to parse JSON response: ${content}`);
      const tagMatches = content.match(/"tags"\s*:\s*\[(.*?)\]/s);
      if (tagMatches) {
        const tagsStr = tagMatches[1];
        const tags = tagsStr
          .split(",")
          .map((t: string) => t.trim().replace(/['"]/g, ""))
          .filter((t: string) => t.length > 0);
        result = { tags };
      } else {
        result = { tags: [tagConfig.fallbackTag] };
      }
    }

    if (!result.tags || !Array.isArray(result.tags)) {
      result.tags = [tagConfig.fallbackTag];
    }

    result.tags = clampTags(normalizeTags(result.tags, tagConfig));

    if (result.tags.length === 0) {
      result.tags = [tagConfig.fallbackTag];
    }

    return result;
  } catch (error: any) {
    if (retryCount < MAX_RETRIES && error?.message?.includes("fetch")) {
      const retryDelay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
      console.log(
        `  ⚠️  Network error. Waiting ${retryDelay / 1000}s before retry ${
          retryCount + 1
        }/${MAX_RETRIES}...`
      );
      await sleep(retryDelay);
      return generateTagsWithLLM(
        project,
        tagConfig,
        languageSummary,
        retryCount + 1
      );
    }
    throw error;
  }
}

function generateDefaultTags(
  project: Project,
  config: TagRuntimeConfig
): string[] {
  const tags: string[] = [];

  if (project.category) {
    const normalizedCategory = normalizeTag(project.category, config);
    if (normalizedCategory) {
      tags.push(normalizedCategory);
    }
  }

  return ensureFallback(clampTags(tags), config.fallbackTag);
}

async function processProject(
  project: Project,
  index: number,
  total: number,
  config: TagRuntimeConfig
): Promise<Project> {
  console.log(
    `[${index + 1}/${total}] Processing: ${project.name.substring(0, 50)}...`
  );

  const languageSummary = await buildProjectLanguageSummary(project, config);
  const languages = Object.keys(languageSummary.languagePercentages);

  if (languageSummary.hasData) {
    const detectedSummary = Object.entries(
      languageSummary.languagePercentages
    )
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, percent]) => `${name} ${percent.toFixed(1)}%`)
      .join(", ");
    console.log(`  🔤 Detected languages: ${detectedSummary}`);
  }

  try {
    if (!project.description || project.description.length < 20) {
      console.log(`  ℹ️  No meaningful description, using default tags`);
      let tags = generateDefaultTags(project, config);
      tags = ensureFallback(clampTags(tags), config.fallbackTag);
      console.log(`  ✓ Tags: ${tags.join(", ")}`);
      return { ...project, tags, languages };
    }

    const result = await generateTagsWithLLM(
      project,
      config,
      languageSummary
    );
    let tags = result.tags;
    tags = ensureFallback(clampTags(tags), config.fallbackTag);
    console.log(`  ✓ Tags: ${tags.join(", ")}`);

    return { ...project, tags, languages };
  } catch (error: any) {
    console.error(`  ❌ Error: ${error.message}`);
    console.log(`  ℹ️  Using default tags as fallback`);
    let tags = generateDefaultTags(project, config);
    tags = ensureFallback(clampTags(tags), config.fallbackTag);
    console.log(`  ✓ Tags: ${tags.join(", ")}`);
    return { ...project, tags, languages };
  }
}

async function main() {
  console.log("=".repeat(70));
  console.log("OP Atlas Project Tagging Script");
  console.log("=".repeat(70));
  console.log();

  const inputPath = join(
    __dirname,
    "..",
    "output",
    "hand-filtered-matched-results.json"
  );
  if (!existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  console.log(`📂 Loading projects from: ${inputPath}`);
  const parsed = JSON.parse(readFileSync(inputPath, "utf-8"));
  if (!Array.isArray(parsed)) {
    throw new Error("Expected input JSON to be an array of projects.");
  }

  const rawProjects: JsonObject[] = parsed.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Project at index ${index} is not a JSON object.`);
    }
    return entry;
  });

  const projects: Project[] = rawProjects.map((raw, index) =>
    normalizeProject(raw as RawProject, index)
  );

  console.log(`✓ Loaded ${projects.length} projects`);
  console.log();

  let checkpoint = loadCheckpoint();
  let startIndex = 0;
  const processedIds = new Set<string>();

  if (checkpoint && cliOptions.restart) {
    console.log(
      `♻️  Restart requested. Ignoring checkpoint from ${checkpoint.timestamp}.`
    );
    try {
      const archivePath = CHECKPOINT_FILE.replace(
        ".json",
        `-restart-${Date.now()}.json`
      );
      writeFileSync(archivePath, readFileSync(CHECKPOINT_FILE));
      console.log(`   Archived previous checkpoint to: ${archivePath}`);
    } catch (error) {
      console.warn("⚠️  Unable to archive previous checkpoint:", error);
    }
    checkpoint = null;
  }

  let resumedFromCheckpoint = false;
  if (checkpoint) {
    resumedFromCheckpoint = true;
    console.log(`📍 Checkpoint found from ${checkpoint.timestamp}`);
    console.log(`   Resuming from index ${checkpoint.lastProcessedIndex + 1}`);
    startIndex = checkpoint.lastProcessedIndex + 1;
    checkpoint.processedIds.forEach((id) => processedIds.add(id));
    console.log();
  }

  const defaultStartIndex = startIndex;
  if (cliOptions.startIndex !== undefined) {
    const sanitizedStart = Math.min(
      Math.max(cliOptions.startIndex, 0),
      projects.length
    );
    if (sanitizedStart !== startIndex) {
      console.log(
        `🎯 CLI start index override: using ${sanitizedStart} (was ${startIndex})`
      );
      if (sanitizedStart < defaultStartIndex && resumedFromCheckpoint) {
        processedIds.clear();
        console.log(
          "   Cleared checkpoint processed IDs to allow reprocessing earlier projects."
        );
      }
      startIndex = sanitizedStart;
    } else if (cliOptions.startIndex !== defaultStartIndex) {
      console.log(`🎯 CLI start index override: ${sanitizedStart}`);
    }
  }

  startIndex = Math.max(0, Math.min(startIndex, projects.length));

  const taggedProjects: Project[] = [];
  for (let i = 0; i < startIndex && i < projects.length; i++) {
    taggedProjects.push(projects[i]);
  }

  const plannedProjects =
    cliOptions.limit !== undefined
      ? Math.min(cliOptions.limit, Math.max(0, projects.length - startIndex))
      : Math.max(0, projects.length - startIndex);

  console.log("⚙️  Configuration:");
  console.log(`   LLM provider: ${llmConfig.provider}`);
  console.log(`   LLM model: ${llmConfig.model}`);
  console.log(`   Temperature: ${llmConfig.temperature}`);
  console.log(`   Max tokens: ${llmConfig.maxTokens}`);
  console.log(`   Allowed tags: ${tagConfig.allowedTags.length}`);
  const envFilesForLog =
    loadedEnvFiles.length > 0
      ? loadedEnvFiles
          .map((file) =>
            relative(process.cwd(), file).startsWith("..")
              ? file
              : relative(process.cwd(), file)
          )
          .join(", ")
      : "none";
  console.log(`   Env files loaded: ${envFilesForLog}`);
  console.log(
    `   OpenAI key: ${process.env.OPENAI_API_KEY ? "set" : "missing"}`
  );
  console.log(`   Groq key: ${process.env.GROQ_API_KEY ? "set" : "missing"}`);
  console.log(`   Rate limit: ${REQUESTS_PER_MINUTE} requests/minute`);
  console.log(`   Delay between requests: ${DELAY_BETWEEN_REQUESTS}ms`);
  console.log(`   Batch size: ${BATCH_SIZE}`);
  console.log(
    `   GitHub token: ${
      GITHUB_TOKEN ? "configured" : "missing (60 req/hr unauthenticated limit)"
    }`
  );
  console.log(`   Cached GitHub repos: ${languageCache.size}`);
  console.log(`   Fallback tag: ${tagConfig.fallbackTag}`);
  console.log(`   Restart mode: ${cliOptions.restart ? "yes" : "no"}`);
  console.log(`   Start index: ${startIndex}/${projects.length}`);
  console.log(`   Session limit: ${cliOptions.limit ?? "none"}`);
  console.log(`   Planned projects this run: ${plannedProjects}`);
  console.log(
    `   CLI args: ${resolveCliArgs().join(" ") || "(none)"}`
  );
  console.log();

  if (plannedProjects === 0) {
    console.log("ℹ️  Nothing new to process in this session.");
  }

  const taggedOutputPath = join(
    __dirname,
    "..",
    "output",
    "hand-filtered-matched-results-tagged.json"
  );

  const startTime = Date.now();
  let processedCount = 0;
  let processedThisRun = 0;
  let highestTaggedIndex = Math.min(startIndex - 1, projects.length - 1);
  let lastProcessedIndex = resumedFromCheckpoint
    ? checkpoint?.lastProcessedIndex ?? startIndex - 1
    : startIndex - 1;
  let lastCheckpointIndex = resumedFromCheckpoint
    ? checkpoint?.lastProcessedIndex ?? -1
    : -1;
  let reachedLimit = false;

  for (let i = startIndex; i < projects.length; i++) {
    if (cliOptions.limit !== undefined && processedThisRun >= cliOptions.limit) {
      reachedLimit = true;
      break;
    }

    const project = projects[i];

    if (processedIds.has(project.id)) {
      console.log(
        `[${i + 1}/${projects.length}] Skipping duplicate: ${project.name}`
      );
      taggedProjects.push(project);
      highestTaggedIndex = i;
      continue;
    }

    const taggedProject = await processProject(
      project,
      i,
      projects.length,
      tagConfig
    );
    taggedProjects.push(taggedProject);
    processedIds.add(project.id);
    processedCount++;
    processedThisRun++;
    lastProcessedIndex = i;
    highestTaggedIndex = i;

    if (i < projects.length - 1) {
      const limitReachedNext =
        cliOptions.limit !== undefined && processedThisRun >= cliOptions.limit;
      if (!limitReachedNext) {
        await sleep(DELAY_BETWEEN_REQUESTS);
      }
    }

    const shouldCheckpoint =
      processedThisRun > 0 &&
      (processedThisRun % BATCH_SIZE === 0 ||
        i === projects.length - 1 ||
        (cliOptions.limit !== undefined &&
          processedThisRun >= cliOptions.limit));

    if (shouldCheckpoint) {
      console.log();
      console.log(
        `💾 Saving checkpoint at project ${i + 1}/${projects.length}...`
      );

      saveCheckpoint({
        lastProcessedIndex: i,
        processedIds: processedIds,
        timestamp: new Date().toISOString(),
      });

      const intermediateOutput = mergeProjectsWithTags(rawProjects, taggedProjects);
      writeFileSync(taggedOutputPath, JSON.stringify(intermediateOutput, null, 2));
      console.log(`✓ Saved intermediate progress to: ${taggedOutputPath}`);
      persistLanguageCache();

      const elapsed = Date.now() - startTime;
      const rate =
        processedCount > 0
          ? (processedCount / Math.max(elapsed / 1000, 1)).toFixed(2)
          : "0.00";
      const rateNumber = Number.parseFloat(rate);
      const remaining = Math.max(0, projects.length - i - 1);
      const estimatedTime =
        processedCount > 0 && rateNumber > 0 ? remaining / rateNumber : 0;

      console.log(
        `   Progress: ${i + 1}/${projects.length} (${(
          ((i + 1) / projects.length) *
          100
        ).toFixed(1)}%)`
      );
      console.log(`   Processed this run: ${processedThisRun}`);
      console.log(`   Processing rate: ${rate} projects/second`);
      console.log(
        `   Estimated time remaining: ${Math.ceil(estimatedTime / 60)} minutes`
      );
      console.log();

      lastCheckpointIndex = i;
    }
  }

  if (cliOptions.limit !== undefined && processedThisRun >= cliOptions.limit) {
    reachedLimit = true;
  }

  const nextIndex = Math.max(highestTaggedIndex + 1, startIndex);
  for (let i = nextIndex; i < projects.length; i++) {
    taggedProjects.push(projects[i]);
  }

  if (
    processedThisRun > 0 &&
    lastProcessedIndex >= 0 &&
    lastCheckpointIndex !== lastProcessedIndex
  ) {
    console.log();
    console.log(
      `💾 Saving checkpoint at project ${lastProcessedIndex + 1}/${projects.length}...`
    );
    saveCheckpoint({
      lastProcessedIndex,
      processedIds,
      timestamp: new Date().toISOString(),
    });
    const intermediateOutput = mergeProjectsWithTags(rawProjects, taggedProjects);
    writeFileSync(taggedOutputPath, JSON.stringify(intermediateOutput, null, 2));
    console.log(`✓ Saved intermediate progress to: ${taggedOutputPath}`);
    persistLanguageCache();
  }

  if (reachedLimit) {
    console.log(
      `⏸️  Reached user-specified limit of ${cliOptions.limit} projects for this run.`
    );
  } else if (processedThisRun === 0) {
    console.log("ℹ️  No new projects processed in this run.");
  }

  const runComplete =
    processedThisRun > 0 && lastProcessedIndex === projects.length - 1;

  console.log();
  console.log("=".repeat(70));
  if (runComplete) {
    console.log("✓ All projects processed!");
  } else if (reachedLimit) {
    console.log("⏸️ Session paused after reaching requested limit.");
  } else {
    console.log("✓ Session complete.");
  }
  console.log("=".repeat(70));
  console.log();

  console.log("💾 Saving final file...");
  const finalOutput = mergeProjectsWithTags(rawProjects, taggedProjects);
  writeFileSync(taggedOutputPath, JSON.stringify(finalOutput, null, 2));

  console.log(`✓ Output: ${taggedOutputPath}`);
  console.log();

  const totalTags = taggedProjects.reduce(
    (sum, p) => sum + (p.tags?.length || 0),
    0
  );
  const avgTags = (totalTags / taggedProjects.length).toFixed(2);

  const allTags = new Set<string>();
  taggedProjects.forEach((p) => {
    p.tags?.forEach((tag) => allTags.add(tag));
  });

  const totalTime = (Date.now() - startTime) / 1000;
  const minutes = Math.floor(totalTime / 60);
  const seconds = Math.floor(totalTime % 60);

  console.log("📊 Statistics:");
  console.log(`   Total projects: ${taggedProjects.length}`);
  console.log(
    `   Projects with tags: ${
      taggedProjects.filter((p) => p.tags && p.tags.length > 0).length
    }`
  );
  console.log(`   Total tags assigned: ${totalTags}`);
  console.log(`   Average tags per project: ${avgTags}`);
  console.log(`   Unique tags: ${allTags.size}`);
  console.log(`   Total time: ${minutes}m ${seconds}s`);
  console.log();

  const tagCounts = new Map<string, number>();
  taggedProjects.forEach((p) => {
    p.tags?.forEach((tag) => {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    });
  });

  const topTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  console.log("🏆 Top 20 Tags:");
  topTags.forEach(([tag, count], index) => {
    console.log(`   ${index + 1}. ${tag}: ${count}`);
  });
  console.log();

  if (runComplete && existsSync(CHECKPOINT_FILE)) {
    console.log("🧹 Cleaning up checkpoint file...");
    const archivePath = CHECKPOINT_FILE.replace(".json", "-completed.json");
    writeFileSync(archivePath, readFileSync(CHECKPOINT_FILE));
    console.log(`✓ Checkpoint archived to: ${archivePath}`);
  } else if (!runComplete) {
    console.log(`📌 Checkpoint saved to: ${CHECKPOINT_FILE}`);
  }

  persistLanguageCache();

  console.log();
  console.log("=".repeat(70));
  console.log("✨ Tagging complete! Your files are ready.");
  console.log("=".repeat(70));
}

main().catch((error) => {
  console.error("Fatal error:", error);
  persistLanguageCache();
  process.exit(1);
});
