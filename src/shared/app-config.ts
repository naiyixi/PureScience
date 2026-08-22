// Single source of truth for project identity and external links. Shared by the main process
// (GitHub star-count fetch) and the renderer (every entry-point link). Keep this UI-free — no
// icons, no JSX — so both processes can import it and any screen reuses the same values.

const GITHUB_OWNER = 'naiyixi'
const GITHUB_REPO = 'PureScience'
const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`

export const APP = {
  name: 'PureScience',
  // Chinese release codename for the current version — see CHANGELOG.md「版本代号」.
  releaseCode: '启明',
  releaseCodeMeaning: '启明星，长夜之后的第一缕光',
  githubOwner: GITHUB_OWNER,
  githubRepo: GITHUB_REPO,
  links: {
    website: 'https://purescience.work',
    githubRepo: GITHUB_REPO_URL,
    githubReleases: `${GITHUB_REPO_URL}/releases`,
    githubApi: `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`,
    githubIssues: `${GITHUB_REPO_URL}/issues`,
    discord: 'https://discord.gg/85dKfuGM9',
    x: 'https://x.com/zerolink_ai'
  },
  copyright: '© 2026 ZEROLINK. All rights reserved.',
  mission: '独立开源的科研 AI 工作台 · 以开源之力，造福全人类',
  update: {
    // Fixed URL: GitHub rewrites /releases/latest/download/<asset> to the newest release's asset,
    // so the client always polls the latest manifest without a per-version config change.
    manifestUrl: `${GITHUB_REPO_URL}/releases/latest/download/version.json`,
    downloadPage: `${GITHUB_REPO_URL}/releases`
  }
} as const
