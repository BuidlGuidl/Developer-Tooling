import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { config as loadEnvFile } from "dotenv";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { CATEGORIES, UNCATEGORIZED, suggestCategory } from "./categories.js";

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
  category?: string;
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

interface GitHubRepoRef {
  owner: string;
  repo: string;
  url: string;
}

interface GitHubRepoInfo {
  html_url?: string;
  name?: string;
  full_name?: string;
  description?: string | null;
  homepage?: string | null;
  topics?: string[];
}

interface WebsiteMetadata {
  url: string;
  title: string | null;
  description: string | null;
  ogImage: string | null;
  twitterUrl: string | null;
}

interface GitHubHtmlHints {
  defaultBranch: string | null;
  description: string | null;
  topics: string[];
  ogImage: string | null;
  title: string | null;
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

function normalizeUrl(inputUrl: string | null | undefined): string | null {
  if (!inputUrl) return null;
  const raw = inputUrl.trim();
  if (!raw) return null;

  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    // allow "example.com" style
    try {
      const u = new URL(`https://${raw.replace(/^\/+/, "")}`);
      return u.toString();
    } catch {
      return null;
    }
  }
}

function truncateOneLine(text: string, max = 140): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    const t = v.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function parseGitHubRepoRef(inputText: string): GitHubRepoRef | null {
  const raw = inputText.trim();
  if (!raw) return null;

  // owner/repo
  const simpleMatch = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (simpleMatch) {
    const owner = simpleMatch[1];
    const repo = simpleMatch[2].replace(/\.git$/i, "");
    return { owner, repo, url: `https://github.com/${owner}/${repo}` };
  }

  // git@github.com:owner/repo(.git)
  const sshMatch = raw.match(
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/
  );
  if (sshMatch) {
    const owner = sshMatch[1];
    const repo = sshMatch[2];
    return { owner, repo, url: `https://github.com/${owner}/${repo}` };
  }

  // URL-ish
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    if (u.hostname !== "github.com") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, "");
    return { owner, repo, url: `https://github.com/${owner}/${repo}` };
  } catch {
    return null;
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 12_000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": "Developer-Tooling/add-manual-project",
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function getGitHubToken(): string | null {
  return (
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_API_TOKEN ||
    null
  );
}

async function fetchGitHubRepoInfo(ref: GitHubRepoRef): Promise<GitHubRepoInfo | null> {
  const token = getGitHubToken();
  const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      const txt = await res.text();
      console.warn(`⚠️  GitHub repo lookup failed (${res.status}): ${txt}`);
      return null;
    }
    return (await res.json()) as GitHubRepoInfo;
  } catch (e) {
    console.warn("⚠️  GitHub repo lookup failed:", e);
    return null;
  }
}

async function fetchGitHubReadme(ref: GitHubRepoRef): Promise<string | null> {
  const token = getGitHubToken();
  const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/readme`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        Accept: "application/vnd.github.raw",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      return null;
    }
    const text = await res.text();
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

function extractReadmeSummary(markdown: string, maxChars = 900): string | null {
  const lines = markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    // drop badges / images / headings at top
    .filter((l) => !l.trim().startsWith("![]("))
    .filter((l) => !l.trim().startsWith("[!"))
    .filter((l) => !l.trim().startsWith("#"));

  const text = lines.join("\n").trim();
  if (!text) return null;

  // naive: first paragraph
  const para = text.split(/\n\s*\n/)[0]?.trim() || "";
  const cleaned = para
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return null;
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function extractMetaContent(html: string, key: string): string | null {
  // key can be name="description" or property="og:description" etc.
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<meta\\s+[^>]*?(?:name|property)=["']${esc}["'][^>]*?>`,
    "i"
  );
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  const content = tag.match(/content=["']([^"']+)["']/i)?.[1];
  return content ? content.trim() : null;
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  const title = match[1].replace(/\s+/g, " ").trim();
  return title || null;
}

function extractFirstTwitterUrl(html: string): string | null {
  const match = html.match(
    /(https?:\/\/(?:twitter\.com|x\.com)\/[A-Za-z0-9_]{1,32})/i
  );
  return match ? match[1] : null;
}

async function fetchWebsiteMetadata(websiteUrl: string): Promise<WebsiteMetadata | null> {
  try {
    const res = await fetchWithTimeout(websiteUrl, {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) {
      const txt = await res.text();
      console.warn(`⚠️  Website fetch failed (${res.status}): ${txt}`);
      return null;
    }
    const html = await res.text();

    const title = extractTitle(html);
    const description =
      extractMetaContent(html, "description") ||
      extractMetaContent(html, "og:description") ||
      extractMetaContent(html, "twitter:description");

    const ogImageRaw =
      extractMetaContent(html, "og:image") || extractMetaContent(html, "twitter:image");

    let ogImage: string | null = null;
    if (ogImageRaw) {
      try {
        ogImage = new URL(ogImageRaw, websiteUrl).toString();
      } catch {
        ogImage = null;
      }
    }

    const twitterUrlRaw = extractFirstTwitterUrl(html);
    const twitterUrl = normalizeUrl(twitterUrlRaw);

    return {
      url: websiteUrl,
      title,
      description,
      ogImage,
      twitterUrl,
    };
  } catch (e) {
    console.warn("⚠️  Website fetch failed:", e);
    return null;
  }
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

async function promptPickFromCandidates(options: {
  fieldLabel: string;
  required: boolean;
  candidates: Array<{ label: string; value: string | null }>;
  allowNone?: boolean;
  manualPrompt: string;
}): Promise<string | null> {
  const { fieldLabel, required, candidates, manualPrompt, allowNone } = options;
  const validCandidates = uniqueStrings(candidates.map((c) => c.value)).map((v) => {
    const source =
      candidates.find((c) => (c.value || "").trim() === v)?.label || "suggested";
    return { label: source, value: v };
  });

  if (validCandidates.length === 0) {
    if (required) return await promptRequired(manualPrompt);
    const ans = await promptOptional(manualPrompt);
    return ans;
  }

  console.log(`\n${fieldLabel}: choose a value`);
  validCandidates.forEach((c, idx) => {
    console.log(`  ${idx + 1}. (${c.label}) ${truncateOneLine(c.value, 160)}`);
  });
  console.log("  0. Enter manually");
  if (allowNone) {
    console.log("  -. Leave blank / none");
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const raw = (await rl.question("  Select option: ")).trim();
    if (allowNone && (raw === "-" || raw.toLowerCase() === "none")) {
      return null;
    }
    if (raw === "0") {
      if (required) return await promptRequired(manualPrompt);
      return await promptOptional(manualPrompt);
    }
    const num = Number.parseInt(raw, 10);
    if (Number.isFinite(num) && num >= 1 && num <= validCandidates.length) {
      return validCandidates[num - 1].value;
    }
    console.log("  Invalid selection.");
  }
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
  project: { name: string; description: string; context?: string }
): Promise<string[]> {
  const extraContext = project.context?.trim();
  const prompt = `You are assisting with labeling a blockchain developer tooling project.
Select up to 10 tags from the allowed list that best match the project description.

Allowed tags:
${allowedTags.map((tag) => `- ${tag}`).join("\n")}

Project name: ${project.name}
Description: ${project.description}
${extraContext ? `\nExtra context (repo README / website metadata):\n${extraContext}\n` : ""}

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

async function fetchGitHubRepoPageHtml(ref: GitHubRepoRef): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(ref.url, {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    return html.trim().length > 0 ? html : null;
  } catch {
    return null;
  }
}

function parseGitHubHtmlHints(html: string, repoPageUrl: string): GitHubHtmlHints {
  const title = extractTitle(html);
  const description =
    extractMetaContent(html, "og:description") ||
    extractMetaContent(html, "twitter:description") ||
    extractMetaContent(html, "description");

  const defaultBranch =
    extractMetaContent(html, "octolytics-dimension-repository_default_branch") ||
    extractMetaContent(html, "octolytics-dimension-repository_default_branch_name") ||
    null;

  const topicsRaw =
    extractMetaContent(html, "octolytics-dimension-repository_topics") ||
    extractMetaContent(html, "octolytics-dimension-repository_topic") ||
    null;
  const topics = topicsRaw
    ? topicsRaw
        .split(/[,\s]+/)
        .map((t) => canonicalizeTag(t))
        .filter(Boolean)
    : [];

  const ogImageRaw =
    extractMetaContent(html, "og:image") || extractMetaContent(html, "twitter:image");
  let ogImage: string | null = null;
  if (ogImageRaw) {
    try {
      ogImage = new URL(ogImageRaw, repoPageUrl).toString();
    } catch {
      ogImage = null;
    }
  }

  return { defaultBranch, description, topics, ogImage, title };
}

async function fetchGitHubReadmeViaRaw(
  ref: GitHubRepoRef,
  defaultBranch: string | null
): Promise<string | null> {
  const branchesToTry = uniqueStrings([defaultBranch, "main", "master"]);
  const readmePaths = ["README.md", "README.MD", "Readme.md"];

  for (const branch of branchesToTry) {
    for (const path of readmePaths) {
      const url = `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${branch}/${path}`;
      try {
        const res = await fetchWithTimeout(url, {
          headers: { Accept: "text/plain" },
        });
        if (!res.ok) continue;
        const txt = (await res.text()).trim();
        if (txt) return txt;
      } catch {
        // continue
      }
    }
  }
  return null;
}

async function promptSelectCategory(suggested: string): Promise<string> {
  console.log("\nCategory");
  console.log(`  Suggested: ${suggested}`);
  const accept = await promptYesNo("Use suggested category?", true);
  if (accept) return suggested;

  const all = [...CATEGORIES.map((c) => c.name), UNCATEGORIZED];
  console.log("\nSelect a category:");
  all.forEach((name, idx) => {
    const desc = CATEGORIES.find((c) => c.name === name)?.description || "";
    console.log(`  ${idx + 1}. ${name}${desc ? ` — ${desc}` : ""}`);
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const raw = (await rl.question("  Select option: ")).trim();
    const num = Number.parseInt(raw, 10);
    if (Number.isFinite(num) && num >= 1 && num <= all.length) {
      return all[num - 1];
    }
    console.log("  Invalid selection.");
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

  const ghRepoInput = await promptRequired("GitHub repo (required, URL or owner/repo): ");
  const websiteInput = await promptOptional(
    "Project website (recommended, URL; leave blank if none): "
  );

  const ghRef = parseGitHubRepoRef(ghRepoInput);
  if (!ghRef) {
    throw new Error(
      `Could not parse GitHub repo "${ghRepoInput}". Expected owner/repo or a GitHub URL.`
    );
  }

  const normalizedWebsite = normalizeUrl(websiteInput);
  if (websiteInput && !normalizedWebsite) {
    console.warn(`⚠️  Could not parse website URL "${websiteInput}". Ignoring.`);
  }

  console.log(`\nLooking up GitHub repo: ${ghRef.url}`);
  const repoInfoFromApi = await fetchGitHubRepoInfo(ghRef);
  const repoHtml = await fetchGitHubRepoPageHtml(ghRef);
  const htmlHints = repoHtml ? parseGitHubHtmlHints(repoHtml, ghRef.url) : null;

  // Prefer API when available, but fall back to HTML-derived values when unauthenticated/rate-limited.
  const repoInfo: GitHubRepoInfo | null = repoInfoFromApi || (htmlHints ? {
    html_url: ghRef.url,
    name: ghRef.repo,
    full_name: `${ghRef.owner}/${ghRef.repo}`,
    description: htmlHints.description,
    topics: htmlHints.topics,
  } : null);

  // README: try API first; if it fails (often due to rate limiting), fall back to raw.githubusercontent.com using default branch from HTML.
  const readmeFromApi = await fetchGitHubReadme(ghRef);
  const readme =
    readmeFromApi ||
    (await fetchGitHubReadmeViaRaw(ghRef, htmlHints?.defaultBranch || null));

  const readmeSummary = readme ? extractReadmeSummary(readme) : null;

  let websiteMeta: WebsiteMetadata | null = null;
  if (normalizedWebsite) {
    console.log(`Looking up website metadata: ${normalizedWebsite}`);
    websiteMeta = await fetchWebsiteMetadata(normalizedWebsite);
  }

  const candidateNameFromRepo =
    repoInfo?.name ? repoInfo.name.replace(/[-_]+/g, " ").trim() : null;
  const candidateNameFromWebsiteTitle = websiteMeta?.title
    ? websiteMeta.title.split("|")[0].split("—")[0].split("-")[0].trim()
    : null;

  const name =
    (await promptPickFromCandidates({
      fieldLabel: "Project name",
      required: true,
      candidates: [
        { label: "GitHub repo name", value: candidateNameFromRepo },
        { label: "Website title", value: candidateNameFromWebsiteTitle },
      ],
      manualPrompt: "Project name (required): ",
    })) || "";

  const candidateDescriptionFromRepo = repoInfo?.description?.trim() || null;
  const candidateDescriptionFromWebsite = websiteMeta?.description?.trim() || null;
  const candidateDescriptionFromReadme = readmeSummary;

  const description =
    (await promptPickFromCandidates({
      fieldLabel: "Project description",
      required: true,
      candidates: [
        { label: "GitHub repo description", value: candidateDescriptionFromRepo },
        { label: "Website meta description", value: candidateDescriptionFromWebsite },
        { label: "README summary", value: candidateDescriptionFromReadme },
      ],
      manualPrompt: "Project description (required): ",
    })) || "";

  const candidateWebsiteFromInput = normalizedWebsite;
  const candidateWebsiteFromRepoHomepage = normalizeUrl(repoInfo?.homepage || null);

  const website =
    (await promptPickFromCandidates({
      fieldLabel: "Website URL",
      required: false,
      allowNone: true,
      candidates: [
        { label: "Provided website", value: candidateWebsiteFromInput },
        { label: "GitHub repo homepage", value: candidateWebsiteFromRepoHomepage },
      ],
      manualPrompt: "Website URL (optional): ",
    })) || null;

  const candidateTwitterFromWebsite = websiteMeta?.twitterUrl || null;
  const twitter =
    (await promptPickFromCandidates({
      fieldLabel: "Twitter / X URL",
      required: false,
      allowNone: true,
      candidates: [{ label: "Found on website", value: candidateTwitterFromWebsite }],
      manualPrompt: "Twitter URL (optional): ",
    })) || null;

  const candidateThumbnail = websiteMeta?.ogImage || htmlHints?.ogImage || null;
  const thumbnail =
    (await promptPickFromCandidates({
      fieldLabel: "Thumbnail URL",
      required: false,
      allowNone: true,
      candidates: [{ label: "Website og:image", value: candidateThumbnail }],
      manualPrompt: "Thumbnail URL (optional): ",
    })) || null;

  const banner =
    (await promptPickFromCandidates({
      fieldLabel: "Banner URL",
      required: false,
      allowNone: true,
      candidates: [{ label: "Website og:image", value: candidateThumbnail }],
      manualPrompt: "Banner URL (optional): ",
    })) || null;

  const reposInput = await promptOptional(
    "Additional repository URLs (comma or newline separated, optional): "
  );

  const repos = reposInput
    ? reposInput
        .split(/[\s,]+/)
        .map((repo) => repo.trim())
        .filter((repo) => repo.length > 0)
    : [];

  const finalRepos = uniqueStrings([ghRef.url, ...repos]).filter(Boolean);

  const llmConfig = maybeLoadLLMConfig();
  let suggestedTags: string[] = [];

  const topicSuggestions = (repoInfo?.topics || [])
    .map((t) => canonicalizeTag(t))
    .filter((t) => allowedTagSet.has(t));

  if (llmConfig) {
    const contextParts = [
      repoInfo?.full_name ? `GitHub: ${repoInfo.full_name}` : null,
      repoInfo?.html_url ? `Repo: ${repoInfo.html_url}` : null,
      repoInfo?.homepage ? `Repo homepage: ${repoInfo.homepage}` : null,
      (repoInfo?.topics || []).length > 0 ? `GitHub topics: ${(repoInfo?.topics || []).join(", ")}` : null,
      websiteMeta?.title ? `Website title: ${websiteMeta.title}` : null,
      websiteMeta?.description ? `Website description: ${websiteMeta.description}` : null,
      readmeSummary ? `README summary: ${readmeSummary}` : null,
    ].filter(Boolean) as string[];

    suggestedTags = await fetchLLMSuggestions(llmConfig, allowedTags, {
      name,
      description,
      context: contextParts.join("\n"),
    });
  } else {
    console.log(
      "ℹ️  No LLM configuration found (missing OPENAI_API_KEY or GROQ_API_KEY). Skipping automatic tag suggestions."
    );
  }

  suggestedTags = uniqueStrings([
    ...topicSuggestions,
    ...suggestedTags.map(canonicalizeTag),
  ]).filter((t) => allowedTagSet.has(t));

  if (suggestedTags.length === 0) {
    console.log("No automatic tag suggestions available.");
  } else {
    const uniqueSuggested = suggestedTags.slice(0, 10);
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

  const suggestedCategory = suggestCategory({
    name,
    description,
    tags: selectedTags,
  });
  const category = await promptSelectCategory(suggestedCategory);

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
    repos: finalRepos,
    tags: selectedTags,
    category,
  };

  console.log("\nReview entry to be added:");
  console.log(`  Name: ${newEntry.name}`);
  console.log(`  Description: ${truncateOneLine(newEntry.description, 220)}`);
  console.log(`  Website: ${newEntry.website || "(none)"}`);
  console.log(`  Twitter: ${newEntry.twitter || "(none)"}`);
  console.log(`  Thumbnail: ${newEntry.thumbnail_url || "(none)"}`);
  console.log(`  Banner: ${newEntry.banner_url || "(none)"}`);
  console.log(`  Repos: ${newEntry.repos.join(", ") || "(none)"}`);
  console.log(`  Tags: ${newEntry.tags.join(", ") || "(none)"}`);
  console.log(`  Category: ${newEntry.category || UNCATEGORIZED}`);

  const shouldWrite = await promptYesNo("Write this entry to results.json?", true);
  if (!shouldWrite) {
    console.log("Aborting without changes.");
    await rl.close();
    return;
  }

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

