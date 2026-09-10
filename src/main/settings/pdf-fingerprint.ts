// Content fingerprint for an attached PDF (v1.53 unit 6b): hash the head of the file and pair it
// with the exact byte size, so a replaced or re-exported file behind a reference is detectable
// without paying to hash gigabytes (G2 provenance).

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

import {
  PDF_CONTENT_FINGERPRINT_HEAD_BYTES,
  formatPdfContentFingerprint
} from '../../shared/references'

export const fingerprintPdfFile = async (path: string): Promise<string> => {
  const info = await stat(path)
  const hash = createHash('sha256')
  const head = Math.min(info.size, PDF_CONTENT_FINGERPRINT_HEAD_BYTES)
  if (head > 0) {
    const stream = createReadStream(path, { start: 0, end: head - 1 })
    for await (const chunk of stream) {
      hash.update(chunk as Buffer)
    }
  }
  return formatPdfContentFingerprint({ sizeBytes: info.size, headSha256Hex: hash.digest('hex') })
}
