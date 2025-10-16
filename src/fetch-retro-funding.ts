import { config } from "dotenv";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as readline from "readline";

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
  repos: string[];
  oso_data?: any;
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
  oso_project_id?: string;
  repos?: string[];
  description?: string | null;
}

interface Artifact {
  artifactId: string;
  artifactName: string;
  projectId: string;
}

interface Repository {
  artifactId: string;
  artifactName: string;
  artifactUrl: string;
}

const OSO_API_URL = "https://www.opensource.observer/api/v1/graphql";
const DEVELOPER_API_KEY = process.env.DEVELOPER_API_KEY;
const MAX_PROJECTS = 256**256;

function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

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
          repos: [],
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

async function fetchArtifactsForProjects(
  projectIds: string[]
): Promise<Artifact[]> {
  const query = `
    query GetArtifacts($projectIds: [String!]!, $limit: Int!, $offset: Int!) {
      oso_artifactsByProjectV1(
        where: { 
          projectId: { _in: $projectIds }
          artifactSource: { _eq: "GITHUB"}
        }
        limit: $limit
        offset: $offset
      ) {
        artifactId
        artifactName
        projectId
      }
    }
  `;

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEVELOPER_API_KEY}`,
  };

  const projectBatchSize = 50;
  const limit = 1000;
  const allArtifacts: Artifact[] = [];

  console.log(
    `Fetching artifacts for ${projectIds.length} unique project IDs...`
  );

  for (let i = 0; i < projectIds.length; i += projectBatchSize) {
    const projectBatch = projectIds.slice(i, i + projectBatchSize);
    const batchNumber = Math.floor(i / projectBatchSize) + 1;
    const totalBatches = Math.ceil(projectIds.length / projectBatchSize);

    console.log(
      `  Project Batch ${batchNumber}/${totalBatches} (${projectBatch.length} projects)...`
    );

    let offset = 0;
    let hasMore = true;
    let batchTotal = 0;

    while (hasMore) {
      try {
        const response = await fetch(OSO_API_URL, {
          method: "POST",
          headers: headers,
          body: JSON.stringify({
            query: query,
            variables: {
              projectIds: projectBatch,
              limit,
              offset,
            },
          }),
        });

        if (!response.ok) {
          console.error(`    Failed at offset ${offset}: ${response.status}`);
          break;
        }

        const result = await response.json();
        const artifacts = result.data?.oso_artifactsByProjectV1 || [];

        if (artifacts.length === 0) {
          hasMore = false;
        } else {
          allArtifacts.push(...artifacts);
          batchTotal += artifacts.length;
          offset += limit;

          if (batchTotal % 5000 === 0 || artifacts.length < limit) {
            console.log(
              `    Progress: ${batchTotal} artifacts from this batch...`
            );
          }

          if (artifacts.length < limit) {
            hasMore = false;
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (error) {
        console.error(`    Error at offset ${offset}:`, error);
        break;
      }
    }

    console.log(
      `    ✓ Batch complete: ${batchTotal} artifacts (Total so far: ${allArtifacts.length})`
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`✓ Total artifacts fetched: ${allArtifacts.length}`);
  return allArtifacts;
}

async function fetchRepositoriesForArtifacts(
  artifactIds: string[]
): Promise<Repository[]> {
  const query = `
    query GetRepositories($artifactIds: [String!]!, $limit: Int!, $offset: Int!) {
      oso_repositoriesV0(
        where: { artifactId: { _in: $artifactIds } }
        limit: $limit
        offset: $offset
      ) {
        artifactId
        artifactName
        artifactUrl
      }
    }
  `;

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEVELOPER_API_KEY}`,
  };

  const artifactBatchSize = 100;
  const limit = 1000;
  const allRepositories: Repository[] = [];

  console.log(
    `Fetching repositories for ${artifactIds.length} unique artifact IDs...`
  );

  for (let i = 0; i < artifactIds.length; i += artifactBatchSize) {
    const artifactBatch = artifactIds.slice(i, i + artifactBatchSize);
    const batchNumber = Math.floor(i / artifactBatchSize) + 1;
    const totalBatches = Math.ceil(artifactIds.length / artifactBatchSize);

    console.log(
      `  Artifact Batch ${batchNumber}/${totalBatches} (${artifactBatch.length} artifacts)...`
    );

    let offset = 0;
    let hasMore = true;
    let batchTotal = 0;

    while (hasMore) {
      try {
        const response = await fetch(OSO_API_URL, {
          method: "POST",
          headers: headers,
          body: JSON.stringify({
            query: query,
            variables: {
              artifactIds: artifactBatch,
              limit,
              offset,
            },
          }),
        });

        if (!response.ok) {
          console.error(`    Failed at offset ${offset}: ${response.status}`);
          break;
        }

        const result = await response.json();
        const repositories = result.data?.oso_repositoriesV0 || [];

        if (repositories.length === 0) {
          hasMore = false;
        } else {
          allRepositories.push(...repositories);
          batchTotal += repositories.length;
          offset += limit;

          if (batchTotal % 2000 === 0 || repositories.length < limit) {
            console.log(
              `    Progress: ${batchTotal} repositories from this batch...`
            );
          }

          if (repositories.length < limit) {
            hasMore = false;
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (error) {
        console.error(`    Error at offset ${offset}:`, error);
        break;
      }
    }

    console.log(
      `    ✓ Batch complete: ${batchTotal} repositories (Total so far: ${allRepositories.length})`
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`✓ Total repositories fetched: ${allRepositories.length}`);
  return allRepositories;
}

function linkProjectsToRepositories(
  projects: CombinedProject[],
  artifacts: Artifact[],
  repositories: Repository[]
): CombinedProject[] {
  console.log("\n--- Linking Projects to Repositories ---");

  const artifactsByProjectId = new Map<string, Artifact[]>();
  for (const artifact of artifacts) {
    if (!artifactsByProjectId.has(artifact.projectId)) {
      artifactsByProjectId.set(artifact.projectId, []);
    }
    artifactsByProjectId.get(artifact.projectId)!.push(artifact);
  }

  const repositoriesByArtifactId = new Map<string, Repository[]>();
  for (const repo of repositories) {
    if (!repositoriesByArtifactId.has(repo.artifactId)) {
      repositoriesByArtifactId.set(repo.artifactId, []);
    }
    repositoriesByArtifactId.get(repo.artifactId)!.push(repo);
  }

  let totalReposLinked = 0;
  let projectsWithRepos = 0;

  for (const project of projects) {
    const repoUrls = new Set<string>();

    const artifactIds = new Set<string>();

    const ownArtifacts = artifactsByProjectId.get(project.oso_project_id) || [];
    for (const artifact of ownArtifacts) {
      artifactIds.add(artifact.artifactId);
    }

    for (const builderId of project.onchain_builder_oso_project_ids || []) {
      const builderArtifacts = artifactsByProjectId.get(builderId) || [];
      for (const artifact of builderArtifacts) {
        artifactIds.add(artifact.artifactId);
      }
    }

    for (const artifactId of artifactIds) {
      const repos = repositoriesByArtifactId.get(artifactId) || [];
      for (const repo of repos) {
        if (repo.artifactUrl) {
          repoUrls.add(repo.artifactUrl);
        }
      }
    }

    project.repos = Array.from(repoUrls).sort();

    if (project.repos.length > 0) {
      projectsWithRepos++;
      totalReposLinked += project.repos.length;
    }
  }

  console.log(`✓ Linked repositories to projects`);
  console.log(`  Projects with repos: ${projectsWithRepos}/${projects.length}`);
  console.log(`  Total repository URLs: ${totalReposLinked}`);

  return projects;
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
    };
  });

  return enrichedProjects;
}

async function main() {
  console.log("=".repeat(60));
  console.log("Developer Tooling Data Fetcher (Limited to 20 Projects)");
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

  let projectsArray = Array.from(combinedProjects.values());

  projectsArray.sort((a, b) => b.total_op_reward - a.total_op_reward);

  console.log(
    `\n⚠️  Limiting to top ${MAX_PROJECTS} projects by total rewards...`
  );
  projectsArray = projectsArray.slice(0, MAX_PROJECTS);
  console.log(`Processing ${projectsArray.length} projects`);

  console.log("\n--- Top 10 Projects by Total Rewards ---");
  projectsArray.slice(0, 10).forEach((project, index) => {
    console.log(
      `${index + 1}. ${project.display_name}: ${project.total_op_reward.toFixed(
        2
      )} OP`
    );
  });

  console.log("\n");
  const answer = await promptUser(
    "Include repository URLs in the output? (y/N) [default: N]: "
  );
  const includeRepos = answer === "yes" || answer === "y" || answer === "Y";

  if (includeRepos) {
    console.log("\n✓ Repository URLs will be included in the output");
    console.log("\n--- Fetching Artifacts and Repositories ---");

    const uniqueProjectIds = new Set<string>();
    for (const project of projectsArray) {
      if (project.oso_project_id) {
        uniqueProjectIds.add(project.oso_project_id);
      }
      for (const builderId of project.onchain_builder_oso_project_ids || []) {
        if (builderId) {
          uniqueProjectIds.add(builderId);
        }
      }
    }

    console.log(`Total unique project IDs to fetch: ${uniqueProjectIds.size}`);

    const artifacts = await fetchArtifactsForProjects(
      Array.from(uniqueProjectIds)
    );

    const uniqueArtifactIds = new Set<string>();
    for (const artifact of artifacts) {
      if (artifact.artifactId) {
        uniqueArtifactIds.add(artifact.artifactId);
      }
    }

    console.log(
      `Total unique artifact IDs to fetch: ${uniqueArtifactIds.size}`
    );

    const repositories = await fetchRepositoriesForArtifacts(
      Array.from(uniqueArtifactIds)
    );

    console.log("\n--- Linking Projects to Repositories ---");
    linkProjectsToRepositories(projectsArray, artifacts, repositories);
  } else {
    console.log("\n✓ Skipping repository data (repos will be empty arrays)");
  }

  console.log("\n--- Enriching with OSO Data ---");
  const enrichedData = await enrichWithOSOData(projectsArray);

  console.log("\n✓ Data enriched with OSO information");
  console.log(
    `Projects with OSO data: ${enrichedData.filter((p) => p.oso_data).length}/${
      enrichedData.length
    }`
  );

  const simplifiedData: SimplifiedProject[] = enrichedData.map((project) => {
    const baseProject: SimplifiedProject = {
      name: project.display_name,
      // oso_project_id: project.oso_project_id,
      description: project.oso_data?.description || null,
    };

    if (includeRepos) {
      baseProject.repos = project.repos;
    }

    return baseProject;
  });

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
      projectsWithRepos: enrichedData.filter((p) => p.repos.length > 0).length,
      totalRewards: enrichedData.reduce((sum, p) => sum + p.total_op_reward, 0),
      includeRepos: includeRepos,
    },
  };
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
