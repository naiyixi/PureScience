// Shared identity + prompt contract for the agent-facing knowledge-store MCP server. The store itself
// (registration, fingerprints, citations, lexical search) lives in src/main/knowledge and is owned by the main
// process; this module only names what the agent can call, so the server, the capability owner and the tests
// agree on one spelling.
//
// The three tools are deliberately narrow. Search is LEXICAL and says so — there is no embedding source wired
// in this version, and a tool that returned lexical hits under a semantic name would be the kind of lie the
// citation machinery exists to prevent. Every result carries the digest of the exact bytes it was taken from,
// recomputed when the result was built, so a reader can re-derive it instead of trusting a snippet.

export const KNOWLEDGE_MCP_SERVER_NAME = 'purescience-knowledge'

export const KNOWLEDGE_SEARCH_TOOL_NAME = 'knowledge_search'
export const KNOWLEDGE_REGISTER_SOURCE_TOOL_NAME = 'knowledge_register_source'
export const KNOWLEDGE_LIST_SOURCES_TOOL_NAME = 'knowledge_list_sources'
export const KNOWLEDGE_RENDER_WIKI_TOOL_NAME = 'knowledge_render_wiki'
export const KNOWLEDGE_REMOVE_SOURCE_TOOL_NAME = 'knowledge_remove_source'

export const KNOWLEDGE_SEARCH_TOOL_DESCRIPTION =
  'Searches the sources registered in this workspace and returns matches WITH citations. Each result names ' +
  'the source, the exact location (file path with a line range, or a URL), and the sha256 of the bytes it was ' +
  'taken from — recomputed when the result was built, so you can re-derive the same digest yourself. The ' +
  'search is LEXICAL (word matching), reported as mode "lexical" with degradation "semantic-source-unconfigured": ' +
  'do not describe these results as semantic or embedding-based. Read the status before concluding anything: ' +
  '"ok" means matches were found, "no-matches" means the registered sources were searched and nothing matched, ' +
  'and "not-indexed" means some sources could not be read on this call (see coverage.pending) — that is NOT ' +
  'the same as "there is nothing there". A row marked stale had its bytes changed since the citation was ' +
  'formed, and a row marked unreadable could not be re-read at all.'

export const KNOWLEDGE_REGISTER_SOURCE_TOOL_DESCRIPTION =
  'Registers a source for later search: a file path (kind "file"), a folder (kind "folder" — every file in the ' +
  'tree becomes its own source), or a URL (kind "url"). Registration records where the source came from and a ' +
  'sha256 fingerprint of its bytes; it does not copy the content anywhere. Registering the same location twice ' +
  'updates its fingerprint instead of adding a second row. Local paths must sit inside a folder this workspace ' +
  'manages (the data root or a folder the user granted) — anything else is refused with the reason ' +
  '"source-outside-roots" rather than silently registered. Read the returned sources to confirm what was ' +
  'actually registered: a folder returns one entry per file, and a file that could not be read is refused by ' +
  'name rather than registered empty.'

export const KNOWLEDGE_LIST_SOURCES_TOOL_DESCRIPTION =
  'Lists the sources registered in this workspace with their location, kind, label, fingerprint (sha256 + byte ' +
  'count) and registration time. Call this before searching to see what is actually there — searching an ' +
  'empty store is a fact about the store, not about the literature. `unreadable: true` means the source record ' +
  'itself could not be read, which is a different answer from "nothing is registered".'

export const KNOWLEDGE_RENDER_WIKI_TOOL_DESCRIPTION =
  'Renders a deterministic wiki for one registered FOLDER: a markdown table with one row per file in that ' +
  "folder, each row carrying the file's location and the sha256 of its bytes AS THEY ARE NOW — every file is " +
  're-read and re-hashed at render time, so a line cannot cite bytes that changed. Same folder, same bytes, ' +
  'same document — no timestamps and no counters, so two renders are comparable by diff. Nothing is written ' +
  'anywhere: the document comes back in the response for you to place. A folder with no registered files ' +
  'reports state "empty-folder", and a folder whose files cannot all be read reports "unreadable-folder" — ' +
  'the document is withheld rather than emitted with rows whose digests cannot be recomputed.'

export const KNOWLEDGE_REMOVE_SOURCE_TOOL_DESCRIPTION =
  'Removes one registered source by its id (from knowledge_list_sources). The row leaves the register and, when a ' +
  'stored copy is no longer referenced by any remaining source, that copy is deleted too — the response reports ' +
  'which digests were pruned, so you do not have to assume the disk changed. A copy still named by another source ' +
  'is kept: two sources can hold the same bytes. An unknown id is refused by name (source-not-found) instead of ' +
  'succeeding silently.'

// One source can yield many hits (one per matching line), so the tool needs a bound the agent can predict.
export const KNOWLEDGE_SEARCH_RESULT_LIMIT = 25

// Projected into the system prompt when the knowledge server is granted for the session. Kept short and
// imperative: the tool descriptions carry the detail, this only tells the model that the store exists, that it
// is the right place to look before re-reading files, and that its answers are lexical and cited.
export const KNOWLEDGE_MCP_SYSTEM_PROMPT_APPEND = [
  '<purescience_knowledge_instructions>',
  'A knowledge store is available for this session. knowledge_list_sources() lists what is registered; ' +
    'knowledge_register_source(kind, path|url) adds a file, a folder, or a URL; knowledge_search(query, ' +
    'limit?) searches the registered sources and returns each hit WITH its citation (source, exact location, ' +
    'sha256 of the bytes it was taken from); knowledge_render_wiki(folder) renders a digest-per-file ' +
    'document for one registered folder, returning it rather than writing it anywhere.',
  'Use it before re-reading files you have already registered, and cite what you use: quote the location and ' +
    'digest a result came back with rather than paraphrasing from memory.',
  'The search is lexical, not semantic — say so when you report findings. Pay attention to the response ' +
    'status: "ok" means matches, "no-matches" means the registered sources were searched and nothing matched, ' +
    'and "not-indexed" means some sources could not be read (coverage.pending) — never report that as "there ' +
    'is nothing on this".',
  '</purescience_knowledge_instructions>'
].join('\n')
