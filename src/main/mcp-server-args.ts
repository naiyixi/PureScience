// Process-argv flags that switch the main entry into a Node stdio MCP server mode instead of the
// Electron UI. Kept in their own dependency-free module so index.ts can detect the mode from argv
// WITHOUT statically importing the MCP server modules (and their heavy SDK graph) — those are imported
// lazily, only once the flag matches, so the UI path acquires the single-instance lock before any
// backend module loads.
export const ARTIFACT_MCP_SERVER_ARG = '--purescience-artifact-mcp'
export const NOTEBOOK_MCP_SERVER_ARG = '--purescience-notebook-mcp'
export const REVIEWER_MCP_PROXY_ARG = '--purescience-reviewer-mcp-proxy'
export const SKILL_IMPORT_MCP_SERVER_ARG = '--purescience-skill-import-mcp'
export const PLAN_MCP_SERVER_ARG = '--purescience-plan-mcp'
export const MEMORY_MCP_SERVER_ARG = '--purescience-memory-mcp'
export const CONTEXT_SUMMARY_MCP_SERVER_ARG = '--purescience-context-summary-mcp'
export const ROUTINE_MCP_SERVER_ARG = '--purescience-routine-mcp'
