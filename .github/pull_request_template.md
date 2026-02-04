## What changed?
- [ ] Add a project
- [ ] Update a project
- [ ] Update taxonomy (tags/categories)

## Before you submit

### Prefer issues first
If you’re not sure about tags/categories, please open an issue first (see the issue templates) and we’ll help.

### Editing projects manually (recommended)
You can submit changes by directly editing:
- `output/results.json` (the list of projects)

To see what tags and categories exist, check:
- `output/taxonomy.json`

### Using the helper script (optional)
This repo includes a shared AI skill to help choose tags:
- `.cursor/skills/add-project-with-tags/SKILL.md`

The `npm run project:add` script is deprecated.

## Tag rules
- **Use existing tags**: tags in `output/results.json` should come from `output/taxonomy.json` and be kebab-case.
- **Suggesting a new tag is allowed** if you also:\n  - add the tag to `output/taxonomy.json`, and\n  - update **all projects** in `output/results.json` that the tag applies to (so we don’t create one-off tags).

## Checklist
- [ ] `output/results.json` is valid JSON after my changes
- [ ] Added/updated entries include: `id`, `name`, `description`, `repos`, `tags`, `category` (plus optional links)
- [ ] My `tags` are in `output/taxonomy.json` (or I added them and applied them everywhere relevant)
- [ ] My `category` matches one of `output/taxonomy.json` categories
