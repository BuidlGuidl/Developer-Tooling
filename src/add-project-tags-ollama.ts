import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OLLAMA_API_URL =
  process.env.OLLAMA_API_URL || "http://localhost:11434/api/generate";
const MODEL = process.env.OLLAMA_MODEL || "llama3.2";

const BATCH_SIZE = 50;
const CHECKPOINT_FILE = join(
  __dirname,
  "..",
  "output",
  "tagging-checkpoint-ollama.json"
);
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;

interface Project {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  thumbnail_url: string | null;
  banner_url: string | null;
  twitter: string | null;
  repos: string[];
  tags?: string[];
}

interface SimplifiedProject {
  name: string;
  repos: string[];
  description: string | null;
  tags?: string[];
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

async function generateTagsWithOllama(
  project: Project,
  retryCount = 0
): Promise<TaggingResult> {
  const prompt = `You are a categorization expert. Analyze this blockchain/crypto project and generate 3-10 relevant tags.

Project Name: ${project.name}
Category: ${project.category || "Unknown"}
Description: ${project.description || "No description available"}
Repository Count: ${project.repos.length}

Generate tags that describe:
1. Programming languages (if identifiable from description)
2. Technology stack (blockchain, smart contracts, web3, etc.)
3. Project type (dApp, tool, library, protocol, NFT platform, DeFi, bridge, wallet, etc.)
4. Interface type (web interface, CLI, API, mobile app, etc.)
5. Ecosystem (Ethereum, Base, Optimism, etc.)

Return ONLY a JSON object with this exact format:
{
  "tags": ["tag1", "tag2", "tag3"]
}

Rules:
- Use lowercase for all tags
- Be specific but concise
- Include 3-10 tags
- No explanations, only the JSON object
- Use standard Web3 abbreviations: "defi" not "decentralized finance", "dapp" not "decentralized application"
- Avoid redundant or overly verbose tags

- Common tags: typescript, javascript, solidity, rust, python, web3, defi, nft, dapp, smart-contracts, cli, web-interface, mobile, api, library, protocol, bridge, wallet, ethereum, base, optimism, layer2, nextjs, utility`;

  try {
    const response = await fetch(OLLAMA_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.3,
          num_predict: 150,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const content = data.response.trim();

    let result: TaggingResult;
    try {
      const jsonMatch =
        content.match(/```json\s*([\s\S]*?)\s*```/) ||
        content.match(/```\s*([\s\S]*?)\s*```/) ||
        content.match(/\{[\s\S]*"tags"[\s\S]*\}/);

      const jsonStr = jsonMatch ? jsonMatch[1] || jsonMatch[0] : content;
      result = JSON.parse(jsonStr);
    } catch (parseError) {
      console.log(`  ⚠️  Failed to parse JSON response, trying extraction...`);
      const tagMatches = content.match(/"tags"\s*:\s*\[(.*?)\]/s);
      if (tagMatches) {
        const tagsStr = tagMatches[1];
        const tags = tagsStr
          .split(",")
          .map((t) => t.trim().replace(/['"]/g, ""))
          .filter((t) => t.length > 0);
        result = { tags };
      } else {
        const words = content.toLowerCase().match(/\b[a-z][a-z0-9-]{2,20}\b/g);
        result = { tags: words ? words.slice(0, 5) : ["general"] };
      }
    }

    if (!result.tags || !Array.isArray(result.tags)) {
      result.tags = ["general"];
    }

    result.tags = result.tags
      .map((tag) => tag.toLowerCase().trim())
      .filter((tag) => tag.length > 0 && tag.length < 30)
      .slice(0, 10);

    if (result.tags.length === 0) {
      result.tags = ["general"];
    }

    return result;
  } catch (error: any) {
    if (retryCount < MAX_RETRIES) {
      console.log(
        `  ⚠️  Error: ${error.message}. Retrying in ${RETRY_DELAY / 1000}s (${
          retryCount + 1
        }/${MAX_RETRIES})...`
      );
      await sleep(RETRY_DELAY);
      return generateTagsWithOllama(project, retryCount + 1);
    }
    throw error;
  }
}

function generateDefaultTags(project: Project): string[] {
  const tags: string[] = [];

  if (project.category) {
    tags.push(project.category.toLowerCase().replace(/\s+/g, "-"));
  }

  if (project.repos.length > 0) {
    tags.push("open-source");
    if (project.repos.length > 1) {
      tags.push("multi-repo");
    }
  }

  if (project.description && project.description.length > 100) {
    tags.push("documented");
  }

  if (tags.length === 0) {
    tags.push("general");
  }

  return tags;
}

async function processProject(
  project: Project,
  index: number,
  total: number
): Promise<Project> {
  console.log(
    `[${index + 1}/${total}] Processing: ${project.name.substring(0, 50)}...`
  );

  try {
    if (!project.description || project.description.length < 20) {
      console.log(`  ℹ️  No meaningful description, using default tags`);
      const tags = generateDefaultTags(project);
      console.log(`  ✓ Tags: ${tags.join(", ")}`);
      return { ...project, tags };
    }

    const result = await generateTagsWithOllama(project);
    console.log(`  ✓ Tags: ${result.tags.join(", ")}`);

    return { ...project, tags: result.tags };
  } catch (error: any) {
    console.error(`  ❌ Error: ${error.message}`);
    console.log(`  ℹ️  Using default tags as fallback`);
    const tags = generateDefaultTags(project);
    return { ...project, tags };
  }
}

async function checkOllamaConnection(): Promise<boolean> {
  try {
    const response = await fetch(
      OLLAMA_API_URL.replace("/api/generate", "/api/tags")
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log("=".repeat(70));
  console.log("OP Atlas Project Tagging Script (Ollama)");
  console.log("=".repeat(70));
  console.log();

  console.log("🔌 Checking Ollama connection...");
  const isConnected = await checkOllamaConnection();
  if (!isConnected) {
    console.error("❌ Cannot connect to Ollama!");
    console.error("   Make sure Ollama is running: ollama serve");
    console.error(`   API URL: ${OLLAMA_API_URL}`);
    process.exit(1);
  }
  console.log(`✓ Connected to Ollama at ${OLLAMA_API_URL}`);
  console.log();

  const inputPath = join(
    __dirname,
    "..",
    "output",
    "op-atlas-projects-full.json"
  );
  if (!existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  console.log(`📂 Loading projects from: ${inputPath}`);
  const projects: Project[] = JSON.parse(readFileSync(inputPath, "utf-8"));
  console.log(`✓ Loaded ${projects.length} projects`);
  console.log();

  let checkpoint = loadCheckpoint();
  let startIndex = 0;
  const processedIds = new Set<string>();

  if (checkpoint) {
    console.log(`📍 Checkpoint found from ${checkpoint.timestamp}`);
    console.log(`   Resuming from index ${checkpoint.lastProcessedIndex + 1}`);
    startIndex = checkpoint.lastProcessedIndex + 1;
    checkpoint.processedIds.forEach((id) => processedIds.add(id));
    console.log();
  }

  const taggedProjects: Project[] = [];
  for (let i = 0; i < startIndex; i++) {
    taggedProjects.push(projects[i]);
  }

  console.log("⚙️  Configuration:");
  console.log(`   Model: ${MODEL}`);
  console.log(`   API URL: ${OLLAMA_API_URL}`);
  console.log(`   Batch size: ${BATCH_SIZE}`);
  console.log(`   Starting from: ${startIndex}`);
  console.log(`   Projects to process: ${projects.length - startIndex}`);
  console.log();
  console.log("💡 Tip: Ollama runs locally with no rate limits!");
  console.log("   This will be much faster than cloud APIs.");
  console.log();

  const startTime = Date.now();
  let processedCount = 0;

  for (let i = startIndex; i < projects.length; i++) {
    const project = projects[i];

    if (processedIds.has(project.id)) {
      console.log(
        `[${i + 1}/${projects.length}] Skipping duplicate: ${project.name}`
      );
      taggedProjects.push(project);
      continue;
    }

    const taggedProject = await processProject(project, i, projects.length);
    taggedProjects.push(taggedProject);
    processedIds.add(project.id);
    processedCount++;

    if ((i + 1) % BATCH_SIZE === 0 || i === projects.length - 1) {
      console.log();
      console.log(
        `💾 Saving checkpoint at project ${i + 1}/${projects.length}...`
      );

      saveCheckpoint({
        lastProcessedIndex: i,
        processedIds: processedIds,
        timestamp: new Date().toISOString(),
      });

      const tempFullPath = join(
        __dirname,
        "..",
        "output",
        "op-atlas-projects-full-tagged-ollama.json"
      );
      writeFileSync(tempFullPath, JSON.stringify(taggedProjects, null, 2));
      console.log(`✓ Saved intermediate progress to: ${tempFullPath}`);

      const elapsed = Date.now() - startTime;
      const rate = processedCount / (elapsed / 1000);
      const remaining = projects.length - i - 1;
      const estimatedTime = remaining > 0 ? remaining / rate : 0;

      console.log(
        `   Progress: ${i + 1}/${projects.length} (${(
          ((i + 1) / projects.length) *
          100
        ).toFixed(1)}%)`
      );
      console.log(`   Processing rate: ${rate.toFixed(2)} projects/second`);
      console.log(
        `   Estimated time remaining: ${Math.ceil(estimatedTime / 60)} minutes`
      );
      console.log();
    }
  }

  console.log();
  console.log("=".repeat(70));
  console.log("✓ All projects processed!");
  console.log("=".repeat(70));
  console.log();

  console.log("📝 Generating simplified output...");
  const simplifiedProjects: SimplifiedProject[] = taggedProjects.map((p) => ({
    name: p.name,
    repos: p.repos,
    description: p.description,
    tags: p.tags,
  }));

  console.log("💾 Saving final files...");
  const outputDir = join(__dirname, "..", "output");

  const fullPath = join(outputDir, "op-atlas-projects-full-tagged-ollama.json");
  const simplifiedPath = join(
    outputDir,
    "op-atlas-projects-simplified-tagged-ollama.json"
  );

  writeFileSync(fullPath, JSON.stringify(taggedProjects, null, 2));
  writeFileSync(simplifiedPath, JSON.stringify(simplifiedProjects, null, 2));

  console.log(`✓ Full output: ${fullPath}`);
  console.log(`✓ Simplified output: ${simplifiedPath}`);
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

  if (existsSync(CHECKPOINT_FILE)) {
    console.log("🧹 Cleaning up checkpoint file...");
    const archivePath = CHECKPOINT_FILE.replace(".json", "-completed.json");
    writeFileSync(archivePath, readFileSync(CHECKPOINT_FILE));
    console.log(`✓ Checkpoint archived to: ${archivePath}`);
  }

  console.log();
  console.log("=".repeat(70));
  console.log("✨ Tagging complete! Your files are ready.");
  console.log("=".repeat(70));
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
