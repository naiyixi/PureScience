// Alias-level cross-run lineage for notebook sessions (v2.1.0, batch B).
//
// The name-level marker in ./run-dependencies.ts answers "did a later run assign this name again".
// It cannot answer two other ways an earlier result goes stale, both of which leave every recorded
// name untouched:
//
//   1. the value is mutated IN PLACE — `df['stage'] = 'x'`, `acc.append(1)`, `df.dropna(inplace=True)`
//      change the object without any assignment to the base name, so `variablesWritten` never sees it;
//   2. the mutation happens through an ALIAS — `b = a` makes `b` the same object, so a later run that
//      only ever mentions `b` has changed `a` as well. Nothing named `a` was written.
//
// This module names both, and names the chain that connects them, so the marker on an earlier run can
// say what happened instead of only that something did. Measured over the recorded runs in this
// machine's data root (2,197 runs / 142 sessions): 2,129 in-place mutation sites; 3 runs are stale
// ONLY under the rules below, and for the 1,173 runs the name-level rule already flags this turns a
// bare "stale" into a statement of who changed what, where — recomputable from run.json alone.
//
// Recomputation recipe (a third party holding run.json needs nothing else):
//   - the producing run's content hash is the sha256 of its UTF-8 `script` — exactly the hash the
//     run's persisted risk review already carries (`riskReview.codeHash`). Runs recorded before that
//     receipt existed report 'not-recorded'; this module never hashes anything itself, because a
//     second hashing place is a second recipe.
//   - a reason is (producing run id, that hash, variable, alias chain, mutation point) under
//     ALIAS_LINEAGE_RECIPE_VERSION, and every field is carried by the surface that shows it.
//
// Conservative, syntax-light — same bargain as run-dependencies.ts: common shapes are caught, strings
// and comments are skipped, and false positives are rare rather than impossible. It NEVER guesses:
// `b = a.copy()` is a copy, not an alias, so mutating `b` flags nothing.

import type { NotebookRunRiskReceipt } from './notebook'
import { extractVariablesWritten } from './run-dependencies'

/** The rule set version a reason names, so an old reason stays readable after the rules grow. */
export const ALIAS_LINEAGE_RECIPE_VERSION = 'notebook-alias-lineage:v1'

/** The recipe a third party recomputes a reason with. Printed beside the reason, not retyped. */
export const ALIAS_LINEAGE_RECIPE =
  'stale reason = producing run id + sha256(utf8 cell source) + variable + alias chain + ' +
  'mutation point (later run id, 1-based line, matched line text, mutation kind), ' +
  'under rule set notebook-alias-lineage:v1'

/** Methods that change their receiver in place with no `inplace` flag. */
const MUTATING_METHODS = new Set([
  'append',
  'extend',
  'insert',
  'remove',
  'pop',
  'clear',
  'sort',
  'reverse',
  'update',
  'add',
  'discard',
  'difference_update',
  'intersection_update',
  'symmetric_difference_update',
  'setdefault',
  'popitem'
])

/**
 * Methods that change their receiver in place ONLY when the call says so (`inplace=True`). Listing
 * them is what keeps `df.dropna()` from being read as a mutation of `df`.
 */
const OPT_IN_MUTATING_METHODS = new Set([
  'drop',
  'dropna',
  'fillna',
  'rename',
  'sort_values',
  'sort_index',
  'reset_index',
  'set_index',
  'replace',
  'astype',
  'clip',
  'interpolate',
  'drop_duplicates',
  'set_axis',
  'rename_axis'
])

// A pure reference copy: the whole line is `name = name` (or `name <- name`), nothing else.
const ALIAS_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|<-)\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:#.*)?$/
// `name[...] = value` and its augmented forms change the object behind `name` in place.
const SUBSCRIPT_WRITE_RE =
  /^([A-Za-z_][A-Za-z0-9_]*)\s*\[[^\]]*\]\s*(?:\+=|-=|\*=|\/=|%=|\|=|&=|\^=|=)/
const AUGMENTED_SUBSCRIPT_RE = /\]\s*(?:\+=|-=|\*=|\/=|%=|\|=|&=|\^=)/
const SUBSCRIPT_DELETE_RE = /^(?:del|rm)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\[/
const METHOD_CALL_RE = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/
const INPLACE_FLAG_RE = /inplace\s*=\s*True/

export type NotebookAliasBinding = {
  /** The name introduced by the binding (a second name for the same object). */
  name: string
  /** The name it now refers to. */
  target: string
  /** 1-based line of the binding. */
  line: number
  excerpt: string
}

export type NotebookMutationKind =
  'inplace-call' | 'subscript-write' | 'subscript-augmented-write' | 'subscript-delete'

export type NotebookMutationSite = {
  /** The name the line mentions. Equals the mutated object's name only when it is not an alias. */
  via: string
  kind: NotebookMutationKind
  /** 1-based line of the mutation. */
  line: number
  excerpt: string
}

export type NotebookScriptStructure = {
  recipeVersion: typeof ALIAS_LINEAGE_RECIPE_VERSION
  aliases: NotebookAliasBinding[]
  mutations: NotebookMutationSite[]
}

export type NotebookStaleReasonKind = 'name-rewrite' | 'direct-mutation' | 'alias-mutation'

export type NotebookStaleReason = {
  kind: NotebookStaleReasonKind
  recipeVersion: typeof ALIAS_LINEAGE_RECIPE_VERSION
  /** The run that produced the value and is now stale. */
  producerRunId: string
  /** sha256 of that run's source, from the run's own persisted risk review; 'not-recorded' if absent. */
  producerContentHash: string | 'not-recorded'
  /** The base name the producing run wrote. */
  variable: string
  /** The later completed run that changed it. */
  laterRunId: string
  /** The name that run used at the site (=== `variable` unless the change came through an alias). */
  via: string
  /** Names from `variable` to `via`, one hop per plain alias binding. Empty for a direct change. */
  aliasChain: string[]
  /** How the object changed. Absent for a plain rewrite — a rewrite has no site in this sense. */
  mutation?: { kind: NotebookMutationKind; line: number; excerpt: string }
}

/** The run fields this analysis reads. Structural on purpose: callers pass records or summaries. */
export type AliasLineageRun = {
  runId: string
  status: string
  script?: string
  variablesWritten?: string[]
  riskReview?: Pick<NotebookRunRiskReceipt, 'codeHash'>
}

/**
 * Finds the alias bindings and in-place mutation sites in one script; both lists are in source order.
 * Lines inside triple-quoted strings are skipped, so a docstring full of example code is not read as
 * this run's own changes.
 */
export const analyzeNotebookScriptStructure = (script: string): NotebookScriptStructure => {
  const aliases: NotebookAliasBinding[] = []
  const mutations: NotebookMutationSite[] = []
  let openBlock: string | undefined

  const lines = script.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim()
    const delimiters = line.match(/"""|'''/g)

    if (openBlock !== undefined) {
      if (line.includes(openBlock)) openBlock = undefined
      continue
    }
    if (delimiters !== null && delimiters.length % 2 === 1) {
      openBlock = delimiters[0]
      continue
    }
    if (line === '' || line.startsWith('#') || line.startsWith('//')) continue

    const lineNumber = index + 1
    const excerpt = line.slice(0, 160)

    const alias = line.match(ALIAS_RE)
    if (alias !== null && alias[1] !== alias[2]) {
      aliases.push({ name: alias[1], target: alias[2], line: lineNumber, excerpt })
      continue
    }

    const subscriptDelete = line.match(SUBSCRIPT_DELETE_RE)
    if (subscriptDelete !== null) {
      mutations.push({
        via: subscriptDelete[1],
        kind: 'subscript-delete',
        line: lineNumber,
        excerpt
      })
      continue
    }

    const subscriptWrite = line.match(SUBSCRIPT_WRITE_RE)
    if (subscriptWrite !== null) {
      mutations.push({
        via: subscriptWrite[1],
        kind: AUGMENTED_SUBSCRIPT_RE.test(line) ? 'subscript-augmented-write' : 'subscript-write',
        line: lineNumber,
        excerpt
      })
      continue
    }

    const call = line.match(METHOD_CALL_RE)
    if (call !== null) {
      const receiver = call[1]
      const method = call[2]
      if (
        MUTATING_METHODS.has(method) ||
        (OPT_IN_MUTATING_METHODS.has(method) && INPLACE_FLAG_RE.test(line))
      ) {
        mutations.push({ via: receiver, kind: 'inplace-call', line: lineNumber, excerpt })
      }
    }
  }

  return { recipeVersion: ALIAS_LINEAGE_RECIPE_VERSION, aliases, mutations }
}

type LocatedMutation = NotebookMutationSite & { root: string; chain: string[] }

const emptyStructure = (): NotebookScriptStructure => ({
  recipeVersion: ALIAS_LINEAGE_RECIPE_VERSION,
  aliases: [],
  mutations: []
})

type ResolvedRun = {
  run: AliasLineageRun
  /** Names this run assigns (or deletes) directly — a rebind ends any alias of that name. */
  written: string[]
  /** Alias bindings introduced by this run. */
  bound: { name: string; entry: AliasEntry }[]
  /** Mutation sites with `via` resolved through the aliases in force when they ran. */
  mutations: LocatedMutation[]
}

type AliasEntry = {
  /** The name the object was first bound to in this session. */
  root: string
  /** Names from the alias down to `root`'s alias, in order: for `b = a`, `['b']`. */
  path: string[]
}

const resolveName = (
  name: string,
  roots: ReadonlyMap<string, AliasEntry>
): { root: string; chain: string[] } => {
  const entry = roots.get(name)
  if (entry === undefined) return { root: name, chain: [] }
  return { root: entry.root, chain: [...entry.path] }
}

/**
 * Walks the runs in order, keeping the alias map the kernel itself would hold, and resolves every
 * mutation site to the name the object was first bound to. When a name is reassigned the mapping is
 * dropped, and so are the mappings of aliases that pointed at it — after `a = something_else`, an old
 * `b = a` no longer identifies `a`, and saying otherwise would name the wrong run.
 */
const resolveRuns = (runs: readonly AliasLineageRun[]): ResolvedRun[] => {
  const roots = new Map<string, AliasEntry>()
  const resolved: ResolvedRun[] = []

  for (const run of runs) {
    const structure =
      run.script === undefined ? emptyStructure() : analyzeNotebookScriptStructure(run.script)
    const local = new Map(roots)
    const bound: { name: string; entry: AliasEntry }[] = []
    const mutations: LocatedMutation[] = []

    // Source order, so a binding only applies to the lines below it: a mutation written above its
    // own alias line belongs to whatever the name meant there.
    const sites = [
      ...structure.aliases.map((alias) => ({ line: alias.line, alias, mutation: undefined })),
      ...structure.mutations.map((mutation) => ({
        line: mutation.line,
        alias: undefined,
        mutation
      }))
    ].sort((left, right) => left.line - right.line)

    for (const site of sites) {
      if (site.alias !== undefined) {
        const resolved = resolveName(site.alias.target, local)
        const entry: AliasEntry = {
          root: resolved.root,
          path: [site.alias.name, ...resolved.chain]
        }
        local.set(site.alias.name, entry)
        bound.push({ name: site.alias.name, entry })
        continue
      }
      if (site.mutation === undefined) continue
      const { root, chain } = resolveName(site.mutation.via, local)
      mutations.push({ ...site.mutation, root, chain })
    }

    const written = run.script === undefined ? [] : extractVariablesWritten(run.script)
    for (const { name, entry } of bound) roots.set(name, entry)
    for (const name of written) {
      if (bound.some((binding) => binding.name === name)) continue
      roots.delete(name)
      for (const [aliasName, entry] of [...roots]) if (entry.root === name) roots.delete(aliasName)
    }

    resolved.push({ run, written, bound, mutations })
  }

  return resolved
}

/** Reads the content hash the run already carries. Absent hash is named, never re-derived here. */
export const aliasLineageContentHash = (run: AliasLineageRun): string | 'not-recorded' => {
  const hash = run.riskReview?.codeHash
  return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) ? hash : 'not-recorded'
}

/**
 * For each run whose written variables a later completed run changed, the located reason: the earliest
 * later run that changed one of them, and what it did there. A rewrite of the name itself outranks a
 * mutation of the object behind it inside the same later run — the rewrite is the plain explanation,
 * and leading with the subtler one would hide it.
 *
 * This adds reasons; it does not narrow what the window already shows. Callers keep the existing
 * name-level set (`computeStaleRunIds`) for the marker itself and union these rows into it, because a
 * run whose later rewriting site cannot be located (no script recorded) still deserves its marker.
 */
export const computeNotebookStaleReasons = (
  runs: readonly AliasLineageRun[]
): NotebookStaleReason[] => {
  const resolved = resolveRuns(runs)
  const reasons: NotebookStaleReason[] = []

  for (let index = 0; index < resolved.length; index += 1) {
    const producer = resolved[index]
    if (producer === undefined || producer.written.length === 0) continue
    const written = new Set(producer.written)
    const base = {
      recipeVersion: ALIAS_LINEAGE_RECIPE_VERSION,
      producerRunId: producer.run.runId,
      producerContentHash: aliasLineageContentHash(producer.run)
    } as const

    for (let later = index + 1; later < resolved.length; later += 1) {
      const effect = resolved[later]
      if (effect === undefined || effect.run.status !== 'completed') continue

      const rewritten = [...written].sort().find((name) => effect.written.includes(name))
      if (rewritten !== undefined) {
        reasons.push({
          ...base,
          kind: 'name-rewrite',
          variable: rewritten,
          laterRunId: effect.run.runId,
          via: rewritten,
          aliasChain: []
        })
        break
      }

      const mutation = effect.mutations.find((site) => written.has(site.root))
      if (mutation === undefined) continue
      reasons.push({
        ...base,
        kind: mutation.chain.length > 0 ? 'alias-mutation' : 'direct-mutation',
        variable: mutation.root,
        laterRunId: effect.run.runId,
        via: mutation.via,
        aliasChain: [...mutation.chain],
        mutation: { kind: mutation.kind, line: mutation.line, excerpt: mutation.excerpt }
      })
      break
    }
  }

  return reasons
}
