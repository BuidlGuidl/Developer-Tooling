import { config } from "dotenv";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Project {
  oso_project_id: string;
  op_atlas_id: string;
  display_name: string;
  is_eligible: boolean;
  star_count: number;
  fork_count: number;
  num_packages_in_deps_dev: number;
  package_connection_count: number;
  developer_connection_count: number;
  onchain_builder_oso_project_ids: string[];
  onchain_builder_project_names: string[];
  trusted_developer_usernames: string[];
  onchain_builder_op_atlas_names: string[];
  downstream_gas: number;
  op_reward: number;
  round_id: string;
}

interface RoundData {
  round: string;
  projects: Project[];
}

interface CombinedProject {
  oso_project_id: string;
  op_atlas_id: string;
  display_name: string;
  num_packages_in_deps_dev: number;
  package_connection_count: number;
  developer_connection_count: number;
  onchain_builder_oso_project_ids: string[];
  onchain_builder_project_names: string[];
  trusted_developer_usernames: string[];
  onchain_builder_op_atlas_names: string[];
  total_op_reward: number;
  latest_star_count: number;
  latest_fork_count: number;
  rounds: Record<string, RoundInfo>;
  oso_data?: any;
  description?: string | null;
  oso_project_name?: string | null;
  oso_display_name?: string;
}

interface RoundInfo {
  op_reward: number;
  downstream_gas: number;
  is_eligible: boolean;
  star_count: number;
  fork_count: number;
}

interface SimplifiedProject {
  name: string;
  oso_project_id: string;
  repos: string[];
  description?: string | null;
}

const OSO_API_URL = "https://www.opensource.observer/api/v1/graphql";
const DEVELOPER_API_KEY = process.env.DEVELOPER_API_KEY;

async function fetchRoundData(month: string): Promise<Project[]> {
  const url = `https://raw.githubusercontent.com/ethereum-optimism/Retro-Funding/refs/heads/main/results/S7/${month}/outputs/devtooling__results.json`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch ${month}: ${response.status} ${response.statusText}`
      );
    }
    const data: Project[] = await response.json();
    console.log(`✓ Fetched ${month}: ${data.length} projects`);
    return data;
  } catch (error) {
    console.error(`✗ Error fetching ${month}:`, error);
    return [];
  }
}

async function fetchAllRounds(): Promise<RoundData[]> {
  const months = ["M1", "M2", "M3", "M4", "M5", "M6"];
  console.log("Starting to fetch all rounds...\n");

  const roundsData: RoundData[] = [];

  for (const month of months) {
    const projects = await fetchRoundData(month);
    roundsData.push({
      round: month,
      projects: projects,
    });
  }

  return roundsData;
}

function combineRounds(roundsData: RoundData[]): Map<string, CombinedProject> {
  const projectsMap = new Map<string, CombinedProject>();

  for (const round of roundsData) {
    for (const project of round.projects) {
      const key = project.oso_project_id || project.op_atlas_id;

      if (projectsMap.has(key)) {
        const existing = projectsMap.get(key)!;
        existing.rounds[round.round] = {
          op_reward: project.op_reward,
          downstream_gas: project.downstream_gas,
          is_eligible: project.is_eligible,
          star_count: project.star_count,
          fork_count: project.fork_count,
        };

        existing.total_op_reward += project.op_reward;

        existing.latest_star_count = project.star_count;
        existing.latest_fork_count = project.fork_count;
      } else {
        projectsMap.set(key, {
          oso_project_id: project.oso_project_id,
          op_atlas_id: project.op_atlas_id,
          display_name: project.display_name,
          num_packages_in_deps_dev: project.num_packages_in_deps_dev,
          package_connection_count: project.package_connection_count,
          developer_connection_count: project.developer_connection_count,
          onchain_builder_oso_project_ids:
            project.onchain_builder_oso_project_ids,
          onchain_builder_project_names: project.onchain_builder_project_names,
          trusted_developer_usernames: project.trusted_developer_usernames,
          onchain_builder_op_atlas_names:
            project.onchain_builder_op_atlas_names,
          total_op_reward: project.op_reward,
          latest_star_count: project.star_count,
          latest_fork_count: project.fork_count,
          rounds: {
            [round.round]: {
              op_reward: project.op_reward,
              downstream_gas: project.downstream_gas,
              is_eligible: project.is_eligible,
              star_count: project.star_count,
              fork_count: project.fork_count,
            },
          },
        });
      }
    }
  }

  return projectsMap;
}

async function queryOSOProjects(
  projectIds: string[]
): Promise<Map<string, any>> {
  const query = `
    query GetProjects($projectIds: [String!]!) {
      oso_projectsV1(where: { projectId: { _in: $projectIds } }) {
        projectId
        projectName
        projectNamespace
        projectSource
        displayName
        description
      }
    }
  `;

  try {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEVELOPER_API_KEY}`,
    };

    const response = await fetch(OSO_API_URL, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        query: query,
        variables: {
          projectIds: projectIds,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `OSO API request failed: ${response.status} ${response.statusText}`
      );
    }

    const result = await response.json();
    const projectsMap = new Map<string, any>();

    if (result.data && result.data.oso_projectsV1) {
      for (const project of result.data.oso_projectsV1) {
        projectsMap.set(project.projectId, project);
      }
    }

    console.log(`✓ Successfully fetched ${projectsMap.size} projects from OSO`);
    return projectsMap;
  } catch (error) {
    console.error("Error querying OSO API:", error);
    return new Map();
  }
}

async function enrichWithOSOData(
  projects: CombinedProject[]
): Promise<CombinedProject[]> {
  console.log("\n--- Querying OSO API ---");

  const projectIds = projects
    .map((p) => p.oso_project_id)
    .filter((id) => id && id.length > 0);

  console.log(`Querying OSO for ${projectIds.length} projects...`);

  const batchSize = 100;
  const allOSOData = new Map<string, any>();

  for (let i = 0; i < projectIds.length; i += batchSize) {
    const batch = projectIds.slice(i, i + batchSize);
    console.log(
      `Fetching batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
        projectIds.length / batchSize
      )}...`
    );

    const batchData = await queryOSOProjects(batch);
    for (const [key, value] of batchData) {
      allOSOData.set(key, value);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`Received OSO data for ${allOSOData.size} projects`);

  const enrichedProjects = projects.map((project) => {
    const osoData = allOSOData.get(project.oso_project_id);

    return {
      ...project,
      oso_data: osoData || undefined,
      description: osoData?.description || null,
      oso_project_name: osoData?.projectName || null,
      oso_display_name: osoData?.displayName || project.display_name,
    };
  });

  return enrichedProjects;
}

async function main() {
  console.log("=".repeat(60));
  console.log("Developer Tooling Data Fetcher");
  console.log("=".repeat(60));

  const roundsData = await fetchAllRounds();

  console.log("\n--- Summary ---");
  let totalProjects = 0;
  for (const round of roundsData) {
    console.log(`${round.round}: ${round.projects.length} projects`);
    totalProjects += round.projects.length;
  }
  console.log(`Total entries: ${totalProjects}`);

  console.log("\n--- Combining data ---");
  const combinedProjects = combineRounds(roundsData);
  console.log(`Unique projects: ${combinedProjects.size}`);

  const projectsArray = Array.from(combinedProjects.values());

  projectsArray.sort((a, b) => b.total_op_reward - a.total_op_reward);

  console.log("\n--- Top 10 Projects by Total Rewards ---");
  projectsArray.slice(0, 10).forEach((project, index) => {
    console.log(
      `${index + 1}. ${project.display_name}: ${project.total_op_reward.toFixed(
        2
      )} OP`
    );
  });

  console.log("\n--- Enriching with OSO Data ---");
  const enrichedData = await enrichWithOSOData(projectsArray);

  console.log("\n✓ Data enriched with OSO information");
  console.log(
    `Projects with OSO data: ${enrichedData.filter((p) => p.oso_data).length}/${
      enrichedData.length
    }`
  );

  const simplifiedData: SimplifiedProject[] = enrichedData.map((project) => ({
    name: project.display_name,
    oso_project_id: project.oso_project_id,
    repos: project.onchain_builder_project_names || [],
    description: project.description,
  }));

  console.log("\n--- Saving JSON Files ---");

  const fullJson = JSON.stringify(enrichedData, null, 2);
  const simplifiedJson = JSON.stringify(simplifiedData, null, 2);

  console.log(`Full dataset: ${(fullJson.length / 1024).toFixed(2)} KB`);
  console.log(
    `Simplified dataset: ${(simplifiedJson.length / 1024).toFixed(2)} KB`
  );

  const outputDir = join(__dirname, "..", "output");

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
    console.log(`✓ Created output directory: ${outputDir}`);
  }

  const fullPath = join(outputDir, "developer-tooling-full.json");
  const simplifiedPath = join(outputDir, "developer-tooling-simplified.json");

  writeFileSync(fullPath, fullJson);
  writeFileSync(simplifiedPath, simplifiedJson);

  console.log(`\n✓ Saved: ${fullPath}`);
  console.log(`✓ Saved: ${simplifiedPath}`);

  console.log("\n=".repeat(30));
  console.log("✓ Complete! Files ready.");
  console.log("=".repeat(60));

  return {
    full: enrichedData,
    simplified: simplifiedData,
    stats: {
      totalProjects: enrichedData.length,
      projectsWithOSOData: enrichedData.filter((p) => p.oso_data).length,
      totalRewards: enrichedData.reduce((sum, p) => sum + p.total_op_reward, 0),
    },
  };
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
