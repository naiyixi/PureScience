import type { OfficialMarketplaceSourceConfig } from './service'

// The official PureScience Specialist Marketplace. trustedKeys holds the CURRENT signing key:
// metadata served from the `published` branch of naiyixi/purescience-specialist-marketplace is
// verified against it before any listing is shown. Rotate by publishing a new key id + updating
// this map (and the marketplace repo's public key).
export const OFFICIAL_MARKETPLACE_SOURCE: OfficialMarketplaceSourceConfig = {
  id: 'purescience-official',
  name: 'PureScience Specialist Marketplace',
  repositoryUrl: 'https://github.com/naiyixi/purescience-specialist-marketplace',
  ref: 'published',
  // jsDelivr FIRST: GitHub-backed CDN with CN nodes — metadata stays reachable for users in
  // China where raw.githubusercontent.com times out. statics.zerolink.com is the reserved
  // future self-hosted CDN slot (currently unresolvable, kept last as a pure fallback).
  metadataBaseUrls: [
    'https://cdn.jsdelivr.net/gh/naiyixi/purescience-specialist-marketplace@published/',
    'https://raw.githubusercontent.com/naiyixi/purescience-specialist-marketplace/published/',
    'https://statics.zerolink.com/purescience/specialist-marketplace/v1/'
  ],
  // Artifacts are committed to the published branch too, so jsDelivr serves installer zips as
  // well (githubAssetUrl remains the final fallback).
  artifactBaseUrls: [
    'https://cdn.jsdelivr.net/gh/naiyixi/purescience-specialist-marketplace@published/',
    'https://statics.zerolink.com/purescience/specialist-marketplace/v1/'
  ],
  trustedKeys: {
    'purescience-marketplace-2026-08':
      'MCowBQYDK2VwAyEAH/9tbjAr/mDQqgFSCmsnEFsTebIEUYxg0Mk9VT3OmtM='
  }
}
