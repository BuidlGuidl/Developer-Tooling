import { BigQuery } from "@google-cloud/bigquery";
import { config } from "dotenv";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as readline from "readline";

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ID = "sylvan-mode-443511-h0";
const DATASET = "op_atlas";

interface RoundProject {
  op_atlas_id: string;
  display_name: string;
  [key: string]: any;
}

interface OpAtlasProject {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  thumbnail_url: string | null;
  banner_url: string | null;
  twitter: string | null;
  repo_url: string | null;
}

interface CombinedProject {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  thumbnail_url: string | null;
  banner_url: string | null;
  twitter: string | null;
  repos: string[];
}

function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function fetchRoundData(month: string): Promise<RoundProject[]> {
  const url = `https://raw.githubusercontent.com/ethereum-optimism/Retro-Funding/refs/heads/main/results/S7/${month}/outputs/devtooling__results.json`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch ${month}: ${response.status} ${response.statusText}`
      );
    }
    const data: RoundProject[] = await response.json();
    console.log(`✓ Fetched ${month}: ${data.length} projects`);
    return data;
  } catch (error) {
    console.error(`✗ Error fetching ${month}:`, error);
    return [];
  }
}

async function fetchOpAtlasIdsFromGitHub(
  lastMonth: number
): Promise<Set<string>> {
  console.log("\n--- Fetching OP Atlas IDs from GitHub Rounds ---");
  console.log(`Fetching rounds M1 to M${lastMonth}...`);

  const opAtlasIds = new Set<string>();
  const months = [];

  for (let i = 1; i <= lastMonth; i++) {
    months.push(`M${i}`);
  }

  for (const month of months) {
    const projects = await fetchRoundData(month);
    for (const project of projects) {
      if (project.op_atlas_id && project.op_atlas_id.length > 0) {
        opAtlasIds.add(project.op_atlas_id);
      }
    }
  }

  console.log(`\n✓ Found ${opAtlasIds.size} unique OP Atlas IDs across ${months.length} rounds`);
  console.log(`  Rounds processed: ${months.join(", ")}`);

  return opAtlasIds;
}

async function fetchOpAtlasProjects(
  opAtlasIds: Set<string>
): Promise<OpAtlasProject[]> {
  console.log("\n--- Fetching Projects from BigQuery ---");
  console.log(`Querying BigQuery for ${opAtlasIds.size} specific project IDs...`);

  const bigquery = new BigQuery({
    projectId: PROJECT_ID,
  });

  const idsArray = Array.from(opAtlasIds);
  
  const query = `
    SELECT
      p.id,
      p.name,
      p.description,
      p.category,
      p.thumbnail_url,
      p.banner_url,
      p.twitter,
      r.url AS repo_url
    FROM \`${PROJECT_ID}.${DATASET}.project\` AS p
    LEFT JOIN \`${PROJECT_ID}.${DATASET}.project_repository\` AS r
      ON p.id = r.project_id
    WHERE p.id IN UNNEST(@projectIds)
    ORDER BY p.name
  `;

  console.log("\n--- Running BigQuery Query ---");
  console.log("Query:");
  console.log(query.replace("@projectIds", `[${idsArray.slice(0, 3).map(id => `"${id}"`).join(", ")}...]`));
  console.log();

  try {
    console.log("Estimating query cost...");
    const [dryRunJob] = await bigquery.createQueryJob({
      query,
      location: "US",
      dryRun: true,
      params: { projectIds: idsArray },
    });

    const bytesProcessed = parseInt(
      dryRunJob.metadata.statistics.totalBytesProcessed
    );
    const gbProcessed = bytesProcessed / 1024 ** 3;
    const estimatedCost = (gbProcessed / 1024) * 5;

    console.log(
      `Estimated bytes to process: ${bytesProcessed.toLocaleString()}`
    );
    console.log(`Estimated GB: ${gbProcessed.toFixed(4)}`);
    console.log(`Estimated cost: $${estimatedCost.toFixed(6)}`);
    console.log();

    console.log("Executing query...");
    const [rows] = await bigquery.query({
      query,
      location: "US",
      params: { projectIds: idsArray },
      maxResults: 100000,
    });

    console.log(`✓ Query complete: Fetched ${rows.length} rows`);

    if (rows.length >= 100000) {
      console.warn("⚠️  Warning: Result set may be truncated at 100,000 rows.");
    }

    return rows as OpAtlasProject[];
  } catch (error: any) {
    if (error.code === 403) {
      console.error(
        "❌ Permission denied. Check your service account permissions."
      );
      console.error(
        "   Make sure you have subscribed to the OP Atlas dataset and have BigQuery User role."
      );
    } else if (error.code === 404) {
      console.error("❌ Dataset or table not found.");
      console.error(
        "   Verify you have subscribed to the OP Atlas dataset via Analytics Hub."
      );
    } else if (error.code === 400) {
      console.error("❌ Invalid query:", error.message);
    } else {
      console.error("❌ Unexpected error:", error);
    }
    throw error;
  }
}

function combineProjectRepos(
  rows: OpAtlasProject[]
): Map<string, CombinedProject> {
  console.log("\n--- Combining Projects and Repositories ---");

  const projectsMap = new Map<string, CombinedProject>();

  for (const row of rows) {
    if (projectsMap.has(row.id)) {
      const existing = projectsMap.get(row.id)!;
      if (row.repo_url && !existing.repos.includes(row.repo_url)) {
        existing.repos.push(row.repo_url);
      }
    } else {
      projectsMap.set(row.id, {
        id: row.id,
        name: row.name,
        description: row.description,
        category: row.category,
        thumbnail_url: row.thumbnail_url,
        banner_url: row.banner_url,
        twitter: row.twitter,
        repos: row.repo_url ? [row.repo_url] : [],
      });
    }
  }

  const projectsWithRepos = Array.from(projectsMap.values()).filter(
    (p) => p.repos.length > 0
  ).length;
  const totalRepos = Array.from(projectsMap.values()).reduce(
    (sum, p) => sum + p.repos.length,
    0
  );

  console.log(`✓ Combined data`);
  console.log(`  Unique projects: ${projectsMap.size}`);
  console.log(`  Projects with repos: ${projectsWithRepos}`);
  console.log(`  Total repositories: ${totalRepos}`);

  return projectsMap;
}

async function main() {
  console.log("=".repeat(60));
  console.log("OP Atlas BigQuery Fetcher (Filtered by GitHub Rounds)");
  console.log(`Project: ${PROJECT_ID}`);
  console.log(`Dataset: ${DATASET}`);
  console.log("=".repeat(60));
  console.log();

  let lastMonth: number;
  
  const args = process.argv.slice(2);
  if (args.length > 0) {
    lastMonth = parseInt(args[0]);
  } else {
    const answer = await promptUser(
      "Enter the last month to include (1-6) [default: 6]: "
    );
    lastMonth = answer ? parseInt(answer) : 6;
  }

  if (isNaN(lastMonth) || lastMonth < 1 || lastMonth > 6) {
    console.error("❌ Invalid month. Must be between 1 and 6.");
    process.exit(1);
  }

  console.log(`\n📅 Processing rounds M1 through M${lastMonth}`);

  const opAtlasIds = await fetchOpAtlasIdsFromGitHub(lastMonth);

  if (opAtlasIds.size === 0) {
    console.error("❌ No OP Atlas IDs found in GitHub rounds!");
    process.exit(1);
  }

  const rawData = await fetchOpAtlasProjects(opAtlasIds);

  const projectsMap = combineProjectRepos(rawData);
  const projectsArray = Array.from(projectsMap.values());

  projectsArray.sort((a, b) => a.name.localeCompare(b.name));

  console.log("\n--- Sample Projects (First 5) ---");
  projectsArray.slice(0, 5).forEach((project, index) => {
    console.log(`${index + 1}. ${project.name}`);
    console.log(`   Category: ${project.category || "N/A"}`);
    console.log(`   Repos: ${project.repos.length}`);
    if (project.description) {
      const truncated =
        project.description.length > 80
          ? project.description.substring(0, 77) + "..."
          : project.description;
      console.log(`   Description: ${truncated}`);
    }
    console.log();
  });

  console.log("\n--- Statistics ---");
  const projectsWithDescriptions = projectsArray.filter(
    (p) => p.description && p.description.length > 0
  ).length;
  const projectsWithCategory = projectsArray.filter(
    (p) => p.category && p.category.length > 0
  ).length;
  const projectsWithTwitter = projectsArray.filter(
    (p) => p.twitter && p.twitter.length > 0
  ).length;
  const projectsWithThumbnail = projectsArray.filter(
    (p) => p.thumbnail_url && p.thumbnail_url.length > 0
  ).length;

  console.log(`Total projects: ${projectsArray.length}`);
  console.log(`Projects with description: ${projectsWithDescriptions}`);
  console.log(`Projects with category: ${projectsWithCategory}`);
  console.log(`Projects with Twitter: ${projectsWithTwitter}`);
  console.log(`Projects with thumbnail: ${projectsWithThumbnail}`);

  const categoryCount = new Map<string, number>();
  for (const project of projectsArray) {
    const cat = project.category || "Uncategorized";
    categoryCount.set(cat, (categoryCount.get(cat) || 0) + 1);
  }

  console.log("\n--- Projects by Category ---");
  const sortedCategories = Array.from(categoryCount.entries()).sort(
    (a, b) => b[1] - a[1]
  );
  sortedCategories.forEach(([category, count]) => {
    console.log(`${category}: ${count}`);
  });

  const outputDir = join(__dirname, "..", "output");
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
    console.log(`\n✓ Created output directory: ${outputDir}`);
  }

  console.log("\n--- Saving Files ---");
  const fullJson = JSON.stringify(projectsArray, null, 2);
  const fullPath = join(outputDir, "op-atlas-projects-full.json");
  writeFileSync(fullPath, fullJson);
  console.log(
    `✓ Saved full dataset: ${fullPath} (${(
      fullJson.length /
      1024 /
      1024
    ).toFixed(2)} MB)`
  );

  const categoriesData = {
    total_projects: projectsArray.length,
    rounds_included: `M1-M${lastMonth}`,
    categories: Object.fromEntries(sortedCategories),
  };
  const categoriesPath = join(outputDir, "op-atlas-categories.json");
  writeFileSync(categoriesPath, JSON.stringify(categoriesData, null, 2));
  console.log(`✓ Saved categories: ${categoriesPath}`);

  console.log("\n" + "=".repeat(60));
  console.log("✓ Complete! Full dataset saved.");
  console.log();
  console.log("📝 Next Steps:");
  console.log("   1. Run the tagging script to add tags:");
  console.log("      npm run tag");
  console.log();
  console.log("   2. The tagging script will:");
  console.log("      - Read op-atlas-projects-full.json");
  console.log("      - Add AI-generated tags to each project");
  console.log("      - Save op-atlas-projects-full-tagged.json");
  console.log("      - Generate op-atlas-projects-simplified-tagged.json");
  console.log("=".repeat(60));

  return {
    projects: projectsArray,
    stats: {
      total: projectsArray.length,
      roundsIncluded: `M1-M${lastMonth}`,
      opAtlasIdsFromGitHub: opAtlasIds.size,
      withDescriptions: projectsWithDescriptions,
      withCategory: projectsWithCategory,
      withTwitter: projectsWithTwitter,
      withThumbnail: projectsWithThumbnail,
      categories: Object.fromEntries(categoryCount),
    },
  };
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});