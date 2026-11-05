import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { APP } from '../../shared/app-config'

// Every file that can end up being the feed a build reads. The packaged feed comes from
// `electron-builder.yml`'s `publish:` block; a development build reads `dev-app-update.yml` instead.
// Both used to name `statics.zerolink.com`, a host that has never resolved — so *every* first update
// check failed and the only way anyone heard about a release was the GitHub fallback. This guard keeps
// the dead host out of both, and pins the working host to the repository the app actually ships from.
const FEED_FILES = ['electron-builder.yml', 'dev-app-update.yml']

const read = (name: string): string =>
  readFileSync(resolve(__dirname, '..', '..', '..', name), 'utf8')

// Comments are allowed to name the dead host — that is how a reader learns why it is gone. What must not
// happen is a live `url:`/`provider:` line still pointing at it.
const liveConfigLines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.replace(/\s+#.*$/, ''))
    .filter((line) => line.trim() && !line.trim().startsWith('#'))

describe('update feeds', () => {
  for (const file of FEED_FILES) {
    it(`${file} does not point any live feed at the host that never resolved`, () => {
      const offending = liveConfigLines(read(file)).filter((line) =>
        line.includes('statics.zerolink.com')
      )
      expect(offending).toEqual([])
    })
  }

  it('the development feed uses the same GitHub source as the packaged one', () => {
    const dev = liveConfigLines(read('dev-app-update.yml')).join('\n')
    expect(dev).toContain('provider: github')
    expect(dev).toContain(`owner: ${APP.githubOwner}`)
    expect(dev).toContain(`repo: ${APP.githubRepo}`)

    const packaged = liveConfigLines(read('electron-builder.yml')).join('\n')
    expect(packaged).toContain('provider: github')
    expect(packaged).toContain(`owner: ${APP.githubOwner}`)
    expect(packaged).toContain(`repo: ${APP.githubRepo}`)
  })
})
