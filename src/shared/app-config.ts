// Single source of truth for project identity and external links. Shared by the main process
// (GitHub star-count fetch) and the renderer (every entry-point link). Keep this UI-free — no
// icons, no JSX — so both processes can import it and any screen reuses the same values.

const GITHUB_OWNER = 'naiyixi'
const GITHUB_REPO = 'PureScience'
const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`

export const APP = {
  name: 'PureScience',
  // Chinese release codename for the current version — see CHANGELOG.md「版本代号」.
  releaseCode: '浑仪',
  releaseCodeMeaning: '张衡浑天仪，窥天测地、度量万象——科学工作台的正式起点',
  githubOwner: GITHUB_OWNER,
  githubRepo: GITHUB_REPO,
  links: {
    website: 'https://purescience.work',
    // Everything a reader can click points at the product site. There is no GitHub/Discord/X button in the
    // app: the site is the one place whose pages we control, and a repository link invites readers into a
    // work log rather than a product.
    support: 'https://purescience.work',
    releaseNotes: 'https://purescience.work',
    // Internal only: the star count is no longer surfaced anywhere in the UI, but keeping the API URL here
    // means an accidental re-introduction is a one-line change rather than a re-plumb.
    githubApi: `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`
  },
  copyright: '© 2026 ZEROLINK. All rights reserved.',
  update: {
    // Fixed URL: GitHub rewrites /releases/latest/download/<asset> to the newest release's asset,
    // so the client always polls the latest manifest without a per-version config change.
    manifestUrl: `${GITHUB_REPO_URL}/releases/latest/download/version.json`,
    downloadPage: `${GITHUB_REPO_URL}/releases`
  }
} as const
