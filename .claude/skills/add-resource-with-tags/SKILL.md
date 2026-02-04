---
name: add-resource-with-tags
description: Guides contributors through adding or updating a tool/resource in output/results.json and choosing tags from output/taxonomy.json. Use when the user wants to add a new resource, suggest tags, or update an existing resource entry.
---

# Add a resource (with tags)

## Inputs to collect (ask for anything missing)
- Resource name
- 1-3 sentence description
- Website URL (optional)
- Twitter/X URL (optional)
- Square thumbnail icon URL (optional)
- Wide banner URL (optional)
- GitHub repo and/or NPM package URL(s) (at least one)
- llms.txt URL (optional)
- Suggested category (must match `output/taxonomy.json`)

## Tagging workflow (use `output/taxonomy.json`)
1. Read `output/taxonomy.json` and load the top-level `tags` list.
2. Propose **3-8 tags** from that list based on the resource description and repos.
   - Prefer more specific tags (e.g. `static-analysis`, `account-abstraction`) over generic ones.
   - Keep tags kebab-case.
   - Target having at least 2-3 tags.
3. If the user wants a **new tag**:
   - Add it to `output/taxonomy.json` under `tags`.
   - Apply it to **all existing resources** in `output/results.json` where it clearly fits (avoid one-off tags).
## Editing `output/results.json`
- Keep the file valid JSON (array of objects).
- For a **new entry**, add an object with (at minimum):
  - `id`: use `manually-added:<slug>` where `<slug>` is a kebab-case version of the name
  - `name`, `description`, `repos`, `tags`, `category`
  - optional: `website`, `twitter`, `thumbnail_url`, `banner_url`, `llms_txt_url`
- For an **update**, locate the existing object (prefer matching by `id`) and change only the necessary fields.
## Quick validation checklist
- Tags are all present in `output/taxonomy.json` `tags`.
- Category matches a taxonomy category name.
- `repos` contains at least one valid GitHub URL.
- JSON remains valid.
## Output format
When responding, provide:
- the proposed `tags` list
- the `category`
- the exact JSON object to insert/update (ready to paste)
