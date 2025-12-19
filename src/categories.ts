export interface ProjectForCategorization {
  name: string;
  description: string | null;
  tags: string[];
}

export interface CategoryDefinition {
  id: number;
  name: string;
  description: string;
  keywords: string[];
}

export const UNCATEGORIZED = "Uncategorized" as const;

export const CATEGORIES: CategoryDefinition[] = [
  {
    id: 1,
    name: "Smart Contract Development & Toolchains",
    description: "Tools for writing, compiling, formatting, and deploying smart contracts.",
    keywords: [
      "foundry",
      "brownie",
      "solc-select",
      "prettier solidity",
      "solady",
      "solidity",
      "vyper",
      "cli",
      "hardhat",
      "smart contract",
      "compiler",
      "formatting",
      "deploy",
      "development environment",
      "toolchain",
      "vscode",
      "extension",
      "plugin",
      "ide",
      "debug",
    ],
  },
  {
    id: 2,
    name: "Security, Testing & Formal Verification",
    description:
      "Tools dedicated to testing, auditing, vulnerability detection, and ensuring contract correctness.",
    keywords: [
      "slither",
      "medusa",
      "ercx",
      "kevm",
      "crytic-properties",
      "kurtosis",
      "security",
      "fuzz",
      "testing",
      "static-analysis",
      "runtime-verification",
      "audit",
      "vulnerability",
      "correctness",
      "formal verification",
      "verification",
      "proof",
      "scanning",
      "detector",
      "protection",
    ],
  },
  {
    id: 3,
    name: "Client Libraries & SDKs (Front-End)",
    description:
      "Libraries and frameworks for building dApp UIs, connecting wallets, and managing client-side contract interaction.",
    keywords: [
      "wagmi",
      "ethers.js",
      "ethers",
      "tevm",
      "alloy",
      "superbeam",
      "frontend",
      "json-rpc",
      "contract-interaction",
      "sdk",
      "ui",
      "client library",
      "dapp",
      "wallet connection",
      "react",
      "vue",
      "web3",
      "library",
      "api",
      "wrapper",
      "typescript",
      "javascript",
      "python",
      "golang",
      "rust",
      "client",
      "connect",
      "npm",
      "package",
    ],
  },
  {
    id: 4,
    name: "Data, Analytics & Tracing",
    description:
      "Tools for reading, indexing, monitoring, and visualizing on-chain data and state changes.",
    keywords: [
      "rindexer",
      "evmstate",
      "nftscan",
      "zkcodex",
      "analytics",
      "indexing",
      "transaction-decoding",
      "storage-layout",
      "tracing",
      "visualization",
      "monitor",
      "data",
      "explorer",
      "decoder",
      "dashboard",
      "metrics",
      "stats",
      "query",
      "graph",
      "beacon chain",
      "beacon",
    ],
  },
  {
    id: 5,
    name: "Transaction & Wallet Infrastructure",
    description:
      "Core services and libraries for creating, signing, bundling, and managing transactions, often involving Account Abstraction (AA).",
    keywords: [
      "skandha",
      "erc-4337",
      "bundler",
      "evm-mcp-server",
      "etherml",
      "libethc",
      "go-ethereum-hdwallet",
      "transaction-management",
      "wallet",
      "account-abstraction",
      "aa",
      "infrastructure",
      "signing",
      "transaction creation",
      "pay",
      "payment",
      "gas",
      "rpc",
      "multicall",
      "node",
      "provider",
    ],
  },
  {
    id: 6,
    name: "Cross-Chain & Interoperability",
    description:
      "Solutions enabling multi-chain asset transfers, contract interactions, and generalized cross-chain messaging.",
    keywords: [
      "daimo pay",
      "bloctopus",
      "enso build",
      "titan layer",
      "cross-chain",
      "interoperability",
      "bridge",
      "messaging",
      "multi-chain",
      "transaction-optimization",
      "x-chain",
      "omnichain",
    ],
  },
  {
    id: 7,
    name: "Education & Community Resources",
    description:
      "Learning platforms, security guidelines, and open standards for better developer collaboration.",
    keywords: [
      "ethernaut",
      "revoke.cash",
      "openrpc",
      "miniapp",
      "starter",
      "education",
      "learning",
      "community",
      "resource",
      "guide",
      "standard",
      "tutorial",
      "docs",
      "documentation",
      "academy",
      "wargame",
      "ctf",
      "course",
      "bootcamp",
      "eip",
      "erc",
      "proposal",
      "job",
      "career",
      "hiring",
      "market",
    ],
  },
];

export function scoreProjectAgainstCategory(
  project: ProjectForCategorization,
  category: CategoryDefinition
): number {
  let score = 0;

  for (const keyword of category.keywords) {
    const lowerKeyword = keyword.toLowerCase();

    // Exact match in tags gives highest score
    if (project.tags.some((t) => t.toLowerCase() === lowerKeyword)) {
      score += 5;
    }

    // Match in name
    if (project.name.toLowerCase().includes(lowerKeyword)) {
      score += 3;
    }

    // Match in description
    if (project.description?.toLowerCase().includes(lowerKeyword)) {
      score += 1;
    }
  }

  return score;
}

export function suggestCategory(project: ProjectForCategorization): string {
  let bestCategory: CategoryDefinition | null = null;
  let maxScore = 0;

  for (const category of CATEGORIES) {
    const score = scoreProjectAgainstCategory(project, category);
    if (score > maxScore) {
      maxScore = score;
      bestCategory = category;
    }
  }

  return bestCategory ? bestCategory.name : UNCATEGORIZED;
}


