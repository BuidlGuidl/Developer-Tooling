import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { config as loadEnvFile } from "dotenv";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";

interface ProjectEntry {
  id: string;
  name: string;
  description: string;
  website: string | null;
  thumbnail_url: string | null;
  banner_url: string | null;
  twitter: string | null;
  repos: string[];
  tags: string[];
}

interface TagConfigFile {
  allowedTags: string[];
}

type LLMProvider = "openai" | "groq";

interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RESULTS_PATH = join(__dirname, "..", "output", "results.json");
const TAG_TAXONOMY_PATH = join(__dirname, "..", "config", "tag-taxonomy.json");
const ENV_CANDIDATES = [
  join(__dirname, "..", ".env.local"),
  join(__dirname, "..", ".env"),
];

const rl = createInterface({ input, output });

function loadEnv(): void {
  for (const envFile of ENV_CANDIDATES) {
    if (existsSync(envFile)) {
      loadEnvFile({ path: envFile, override: true });
    }
  }
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

function slugifyName(name: string): string {
  return canonicalizeTag(name);
}

function loadAllowedTags(): { list: string[]; set: Set<string> } {
  if (!existsSync(TAG_TAXONOMY_PATH)) {
    throw new Error(`Tag taxonomy file not found at ${TAG_TAXONOMY_PATH}`);
  }
  const data = JSON.parse(
    readFileSync(TAG_TAXONOMY_PATH, "utf-8")
  ) as TagConfigFile;
  const list = (data.allowedTags || []).map(canonicalizeTag).filter(Boolean);
  return {
    list,
    set: new Set(list),
  };
}

async function promptRequired(message: string): Promise<string> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = (await rl.question(message)).trim();
    if (answer.length > 0) {
      return answer;
    }
    console.log("  Please provide a value.");
  }
}

async function promptOptional(message: string): Promise<string | null> {
  const answer = (await rl.question(message)).trim();
  return answer.length > 0 ? answer : null;
}

async function promptYesNo(
  message: string,
  defaultYes = true
): Promise<boolean> {
  const suffix = defaultYes ? "(Y/n)" : "(y/N)";
  const answer = (await rl.question(`  ${message} ${suffix} `)).trim().toLowerCase();
  if (!answer) {
    return defaultYes;
  }
  return ["y", "yes"].includes(answer);
}

function maybeLoadLLMConfig(): LLMConfig | null {
  const providerEnv = (process.env.LLM_PROVIDER || "").toLowerCase();
  const provider: LLMProvider =
    providerEnv === "openai" ? "openai" : providerEnv === "groq" ? "groq" : (process.env.OPENAI_API_KEY ? "openai" : "groq");

  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return null;
    }
    return {
      provider,
      apiKey,
      baseUrl:
        process.env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions",
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: Number.parseFloat(process.env.OPENAI_TEMPERATURE || "0.2"),
      maxTokens: Number.parseInt(process.env.OPENAI_MAX_TOKENS || "200", 10),
    };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return null;
  }
  return {
    provider,
    apiKey,
    baseUrl:
      process.env.GROQ_API_URL || "https://api.groq.com/openai/v1/chat/completions",
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    temperature: Number.parseFloat(process.env.GROQ_TEMPERATURE || "0.2"),
    maxTokens: Number.parseInt(process.env.GROQ_MAX_TOKENS || "200", 10),
  };
}

async function fetchLLMSuggestions(
  llm: LLMConfig,
  allowedTags: string[],
  project: { name: string; description: string }
): Promise<string[]> {
  const prompt = `You are assisting with labeling a blockchain developer tooling project.
Select up to 10 tags from the allowed list that best match the project description.

Allowed tags:
${allowedTags.map((tag) => `- ${tag}`).join("\n")}

Project name: ${project.name}
Description: ${project.description}

Respond ONLY with JSON in this exact format:
{"tags":["tag-one","tag-two"]}`;

  try {
    const response = await fetch(llm.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          {
            role: "system",
            content:
              "You are a precise assistant. Return valid JSON only. Use only provided tag slugs.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: llm.temperature,
        max_tokens: llm.maxTokens,
        top_p: 1,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`⚠️  LLM request failed (${response.status}): ${errText}`);
      return [];
    }

    const data = await response.json();
    const rawContent = data?.choices?.[0]?.message?.content;
    if (!rawContent || typeof rawContent !== "string") {
      console.warn("⚠️  LLM returned no content.");
      return [];
    }

    const match =
      rawContent.match(/```json\s*([\s\S]*?)\s*```/) ||
      rawContent.match(/```\s*([\s\S]*?)\s*```/);
    const jsonText = match ? match[1] : rawContent;
    const parsed = JSON.parse(jsonText);
    if (!parsed?.tags || !Array.isArray(parsed.tags)) {
      return [];
    }

    return parsed.tags
      .map((tag: unknown) => (typeof tag === "string" ? canonicalizeTag(tag) : ""))
      .filter((tag: string) => tag.length > 0);
  } catch (error) {
    console.warn("⚠️  Failed to fetch tag suggestions:", error);
    return [];
  }
}

async function main(): Promise<void> {
  loadEnv();

  if (!existsSync(RESULTS_PATH)) {
    throw new Error(`Results file not found at ${RESULTS_PATH}`);
  }

  const existingRaw = JSON.parse(readFileSync(RESULTS_PATH, "utf-8"));
  if (!Array.isArray(existingRaw)) {
    throw new Error("Results file is not an array.");
  }

  const { list: allowedTags, set: allowedTagSet } = loadAllowedTags();

  console.log("Add a new project to results.json");
  console.log("--------------------------------");

  const name = await promptRequired("Project name (required): ");
  const description = await promptRequired("Project description (required): ");
  const website = await promptOptional("Website URL (optional): ");
  const twitter = await promptOptional("Twitter URL (optional): ");
  const reposInput = await promptOptional(
    "Repository URLs (comma or newline separated, optional): "
  );
  const thumbnail = await promptOptional("Thumbnail URL (optional): ");
  const banner = await promptOptional("Banner URL (optional): ");

  const repos = reposInput
    ? reposInput
        .split(/[\s,]+/)
        .map((repo) => repo.trim())
        .filter((repo) => repo.length > 0)
    : [];

  const llmConfig = maybeLoadLLMConfig();
  let suggestedTags: string[] = [];
  if (llmConfig) {
    suggestedTags = await fetchLLMSuggestions(llmConfig, allowedTags, {
      name,
      description,
    });
  } else {
    console.log(
      "ℹ️  No LLM configuration found (missing OPENAI_API_KEY or GROQ_API_KEY). Skipping automatic tag suggestions."
    );
  }

  if (suggestedTags.length === 0) {
    console.log("No automatic tag suggestions available.");
  } else {
    const uniqueSuggested = Array.from(
      new Set(suggestedTags.filter((tag) => allowedTagSet.has(tag)))
    ).slice(0, 10);
    console.log("\nSuggested tags:");
    uniqueSuggested.forEach((tag, index) => {
      console.log(`  ${index + 1}. ${tag}`);
    });
    suggestedTags = uniqueSuggested;
  }

  const selectedTags: string[] = [];

  for (const tag of suggestedTags) {
    const shouldAdd = await promptYesNo(`Add suggested tag "${tag}"?`);
    if (shouldAdd && !selectedTags.includes(tag)) {
      selectedTags.push(tag);
    }
  }

  console.log("\nAdd additional tags manually (from allowed taxonomy). Leave blank to finish.");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const manualTagInput = await promptOptional("  Tag: ");
    if (!manualTagInput) {
      break;
    }
    const manualTag = canonicalizeTag(manualTagInput);
    if (!allowedTagSet.has(manualTag)) {
      console.log(`  ⚠️  "${manualTagInput}" is not in the allowed taxonomy.`);
      continue;
    }
    if (selectedTags.includes(manualTag)) {
      console.log("  ⚠️  Tag already selected.");
      continue;
    }
    selectedTags.push(manualTag);
    console.log(`  ✓ Added "${manualTag}".`);
  }

  const slug = slugifyName(name);
  const id = `manually-added:${slug}`;

  const duplicate = existingRaw.some(
    (entry: any) => typeof entry?.id === "string" && entry.id === id
  );
  if (duplicate) {
    const proceed = await promptYesNo(
      `⚠️  A project with id "${id}" already exists. Overwrite anyway?`,
      false
    );
    if (!proceed) {
      console.log("Aborting without changes.");
      await rl.close();
      return;
    }
  }

  const newEntry: ProjectEntry = {
    id,
    name,
    description,
    website: website || null,
    thumbnail_url: thumbnail || null,
    banner_url: banner || null,
    twitter: twitter || null,
    repos,
    tags: selectedTags,
  };

  if (duplicate) {
    const idx = existingRaw.findIndex(
      (entry: any) => typeof entry?.id === "string" && entry.id === id
    );
    existingRaw[idx] = newEntry;
  } else {
    existingRaw.push(newEntry);
  }

  writeFileSync(RESULTS_PATH, JSON.stringify(existingRaw, null, 2));

  console.log("\n✅ Project added to results.json");
  console.log(`   ID: ${newEntry.id}`);
  console.log(`   Tags: ${newEntry.tags.join(", ") || "(none)"}`);

  await rl.close();
}

main().catch(async (error) => {
  console.error("Fatal error:", error);
  await rl.close();
  process.exit(1);
});

