// Read-only projection of a cached vision-evidence row.
//
// When the active agent backend is text-only, an image attachment is translated by a dedicated vision model in
// an isolated session, and the extracted evidence JSON is cached so replaying the conversation does not pay for
// the same analysis twice. Until now nothing outside the main process could see that cache: the repository was
// write-only from the window's point of view, so a reader had no way to answer "which image was translated, by
// which extractor generation, under which schema".
//
// The payload itself (`evidenceJson`) deliberately stays out of this shape: it is the model's own output, it can
// be large, and the window has no business rendering it. What the window gets is the identity of the analysis:
// the image it belongs to (checksum + mime), the extractor generation and evidence schema it was produced
// under, where it came from, and when it was last written.
export type VisionEvidenceSummary = {
  /** identityKey: sha256(imageChecksum + extractorFingerprint + evidenceSchemaVersion). */
  id: string
  projectId: string
  sessionId: string
  /** 'upload-version' | 'message-image' (kept as a string so a future source does not break old readers). */
  sourceKind: string
  mimeType: string
  /** sha256 of the canonical image bytes — the image this evidence was extracted from. */
  imageChecksum: string
  /** sha256 of the extractor implementation/config: a different value means a different translation. */
  extractorFingerprint: string
  evidenceSchemaVersion: number
  /** ISO strings: a Date does not survive the IPC boundary, so the crossing happens here (main side). */
  createdAt: string
  updatedAt: string
}
