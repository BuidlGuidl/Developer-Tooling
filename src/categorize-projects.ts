
import * as fs from "fs";
import * as path from "path";
import { CATEGORIES, UNCATEGORIZED, scoreProjectAgainstCategory } from "./categories.js";

const INPUT_FILE = path.join(process.cwd(), 'output/results.json');
const OUTPUT_FILE = path.join(process.cwd(), 'output/results.json');

interface Project {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  category?: string;
  [key: string]: any;
}

function categorizeProjects() {
  try {
    const rawData = fs.readFileSync(INPUT_FILE, 'utf-8');
    const projects: Project[] = JSON.parse(rawData);
    
    let categorizedCount = 0;

    const updatedProjects = projects.map(project => {
      let bestCategory = null;
      let maxScore = 0;

      // Debug specific project
      // const isDebug = project.name === "The Ethernaut";
      // if (isDebug) console.log(`Debugging: ${project.name}`);

      for (const category of CATEGORIES) {
        const score = scoreProjectAgainstCategory(project, category);
        // if (isDebug && score > 0) {
        //    console.log(`  Category: ${category.name}, Score: ${score}`);
        // }

        if (score > maxScore) {
          maxScore = score;
          bestCategory = category;
        }
      }

      return {
        ...project,
        category: bestCategory ? bestCategory.name : UNCATEGORIZED
      };
    });

    // Count stats
    const stats: Record<string, number> = {};
    updatedProjects.forEach(p => {
      const cat = p.category || "Uncategorized";
      stats[cat] = (stats[cat] || 0) + 1;
    });

    console.log("Categorization Stats:", stats);

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(updatedProjects, null, 2));
    console.log(`Successfully updated ${updatedProjects.length} projects in ${OUTPUT_FILE}`);

  } catch (error) {
    console.error("Error processing projects:", error);
  }
}

categorizeProjects();


