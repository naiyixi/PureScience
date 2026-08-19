// Single source of truth for project identity and external links. Shared by the main process
// (GitHub star-count fetch) and the renderer (every entry-point link). Keep this UI-free — no
// icons, no JSX — so both processes can import it and any screen reuses the same values.

const GITHUB_OWNER = 'zerolink'
const GITHUB_REPO = 'purescience'
const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`

export const APP = {
  name: 'PureScience',
  githubOwner: GITHUB_OWNER,
  githubRepo: GITHUB_REPO,
  links: {
    website: 'https://www.zerolink.com/purescience',
    githubRepo: GITHUB_REPO_URL,
    githubReleases: `${GITHUB_REPO_URL}/releases`,
    githubApi: `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`,
    githubIssues: `${GITHUB_REPO_URL}/issues`,
    discord: 'https://discord.gg/85dKfuGM9',
    x: 'https://x.com/zerolink_ai'
  },
  copyright: '© 2026 ZEROLINK. All rights reserved.',
  update: {
    manifestUrl: 'https://statics.zerolink.com/purescience/app/stable/version.json',
    downloadPage: 'https://www.zerolink.com/purescience'
  }
} as const
