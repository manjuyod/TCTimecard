# AGENTS.md

## Purpose
This repository is designed to be built iteratively using AI coding agents (Codex, Cline, etc.).

## Rules for Agents
- Do NOT invent branding or UI styles. Always reuse extracted legacy branding.
- Prefer additive changes; do not refactor unrelated code.
- Keep all new code in TypeScript (`.ts`/`.tsx`) consistent with the current codebase.
- Use parameterized queries for all database access.
- Do not hardcode secrets; use environment variables.
- Ask clarifying questions only once per task if required.

## Execution Order
1. Run 00_discover_legacy_branding.json
2. Apply branding tokens
3. Scaffold app
4. Implement backend services
5. Build UI pages
6. Integrate email + automation
7. Final QA

## Definition of Done
- App runs on Replit
- Dual-auth works
- Hours aggregate correctly
- Branding matches legacy form
