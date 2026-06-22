# Documentation Overhaul Specification

## Problem

The repository documentation currently describes VirtualTeachingAssistant as
"Linux-first", which confuses one deployment target with the identity of the
project. The README is too short for architecture-level development, and the
architecture overview mixes implemented components with target-state services.
Future contributors cannot reliably tell what exists, what is a compatibility
layer, what is only an interface, and what still requires institutional work.

## Goal

Create a complete, navigable documentation system that presents
VirtualTeachingAssistant as a Python teaching-agent platform and framework. It
must explain the design, boundaries, current implementation, extension model,
development workflow, operational model, security posture, and roadmap without
claiming unimplemented or institutionally unapproved capabilities.

## Audiences

- Professors and teaching staff evaluating the product direction.
- Python engineers implementing the platform and integrations.
- Security, privacy, accessibility, and operations reviewers.
- Contributors building channels, skills, activities, agents, and transports.

## Required outcomes

- A visually coherent README with an accessible repository-owned animated SVG,
  Mermaid diagrams, concise navigation, and an explicit current-state matrix.
- A documentation index with reading paths by audience.
- Separate current-state and target-state architecture descriptions.
- Detailed component, request lifecycle, extension, configuration, testing,
  deployment, operations, roadmap, and glossary documents.
- Correct project metadata and governance wording: Python platform first;
  Linux is the currently documented server deployment target, not the project
  category.
- All links are relative or authoritative, all code examples are syntactically
  valid, and no document contains credentials, student data, or local paths.

## Non-goals

- Implementing missing production services or adapters.
- Claiming Carey or Johns Hopkins endorsement, approval, or compliance.
- Replacing architecture decisions already recorded in ADRs.
- Adding third-party analytics, remote scripts, or externally hosted artwork.

## Truth model

Every capability must be labeled as one of:

- **Implemented:** executable code and tests exist in this repository.
- **Compatibility:** available through the original OpenClaw deployer, outside
  the V2 platform composition root.
- **Contract only:** a typed port, model, or registry exists, but no production
  adapter/runtime is wired.
- **Planned:** documented target with no implemented contract or runtime.
- **Institutional gate:** requires Carey/JHU policy, identity, or infrastructure
  decisions outside this repository.

## Acceptance criteria

1. The README never characterizes the project itself as Linux-first.
2. README and detailed docs distinguish platform core from compatibility layer.
3. Architecture diagrams visually distinguish implemented and target-state
   components and describe the legend in text.
4. Current-state claims can be traced to source modules or tests.
5. Animated SVG has static content, accessible text, and a reduced-motion rule.
6. A local link checker passes for all repository-relative Markdown links.
7. Unit tests, compileall, architecture checks, eval validation, security scan,
   package build, and GitHub Actions remain green.

## Rollback

The change is documentation and metadata only. Revert the documentation commit
if navigation or rendering regresses; no runtime state or schema migration is
involved.
