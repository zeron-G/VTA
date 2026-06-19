# VTA Public Release Specification

## Goal

Publish Virtual Teaching Assistant (VTA) as a public, Linux-first GitHub
repository containing the deployer and a reusable Course TA skill.

## Requirements

- Bundle the Course TA skill in source distributions and wheels.
- Install OpenClaw only from its official npm package.
- Document official upstream source, package, API, and authentication links.
- Exclude all runtime profiles, credentials, logs, course materials, student
  data, real identities, and institution-specific configuration.
- Provide Linux deployment and read-only health-check entrypoints.
- Validate tests, package contents, skill metadata, and release security before
  publishing.

## Non-goals

- Redistributing the OpenClaw npm tarball.
- Publishing a configured production profile.
- Creating provider accounts, Discord applications, or Canvas tokens.
