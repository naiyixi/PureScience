import type { KnowledgeSource } from '../../shared/knowledge'
import { sha256Of } from './knowledge-citation'

// Where a folder's current bytes come from. Like the citation verifier, the wiki never trusts a stored
// digest: it re-reads each file and hashes what is there, so a line's citation is true of the folder NOW.
export type KnowledgeWikiReader = {
  read(path: string): Promise<string | undefined>
}

// A folder either yields a document, or names why it did not. "The folder is empty" and "the folder could
// not be read" are different findings — one is a fact about the folder, the other about us.
export type KnowledgeWikiResult =
  | { state: 'written'; content: string; entries: number }
  | { state: 'empty-folder' }
  | { state: 'unreadable-folder' }

export type KnowledgeWikiGenerator = {
  render(folder: string, sources: KnowledgeSource[]): Promise<KnowledgeWikiResult>
}

// Deterministic by construction: entries are ordered by location with a plain code-unit comparison (NOT
// localeCompare, which varies with the host's locale), no timestamp is written anywhere, and nothing is
// numbered from a counter that could start differently. Same folder, same bytes — every time, on any host.
const byLocation = (left: KnowledgeSource, right: KnowledgeSource): number =>
  left.location < right.location ? -1 : left.location > right.location ? 1 : 0

const escapeCell = (value: string): string => value.replace(/\|/g, '\\|')

export const createKnowledgeWikiGenerator = (ports: {
  reader: KnowledgeWikiReader
}): KnowledgeWikiGenerator => ({
  async render(folder: string, sources: KnowledgeSource[]): Promise<KnowledgeWikiResult> {
    const inFolder = sources.filter(
      (source) => source.folder === folder || source.location === folder
    )
    if (inFolder.length === 0) return { state: 'empty-folder' }

    const rows: { label: string; location: string; digest: string; bytes: number }[] = []
    for (const source of [...inFolder].sort(byLocation)) {
      const body = await ports.reader.read(source.location)
      // A file the wiki cannot read stops the document rather than contributing a line without a digest:
      // a line whose citation cannot be recomputed is worse than no line at all.
      if (body === undefined) return { state: 'unreadable-folder' }
      rows.push({
        label: source.label,
        location: source.location,
        digest: sha256Of(body),
        bytes: Buffer.byteLength(body, 'utf8')
      })
    }

    const lines: string[] = [
      `# ${folder}`,
      '',
      'Every line below cites the file it came from and the digest of that file as it is now.',
      '',
      '| File | Location | sha256 | Bytes |',
      '| --- | --- | --- | --- |',
      ...rows.map(
        (row) =>
          `| ${escapeCell(row.label)} | ${escapeCell(row.location)} | ${row.digest} | ${row.bytes} |`
      ),
      ''
    ]
    return { state: 'written', content: lines.join('\n'), entries: rows.length }
  }
})
