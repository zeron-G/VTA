# Documentation Overhaul Plan

1. Inventory source modules, tests, current docs, package metadata, and CI.
2. Define the documentation map and the implemented/compatibility/contract/
   planned/institutional status vocabulary.
3. Build a repository-owned accessible SVG hero and rewrite the README.
4. Write detailed architecture, development, extension, reference, operations,
   deployment, roadmap, and glossary pages.
5. Add a local Markdown-link validation gate and update CI.
6. Run rendering-oriented static checks plus the full repository verification.
7. Publish through a pull request and require Linux CI before merge.

## Risks

- GitHub Markdown supports Mermaid but may treat SVG animation differently
  across clients. The visual must remain useful as a static image.
- Documentation can drift from code. Current-state pages therefore cite source
  module paths and CI validates local links.
- Large READMEs become hard to scan. The root page provides layered summaries
  and routes details into focused documents.
