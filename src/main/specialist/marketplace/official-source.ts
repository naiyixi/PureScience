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
  metadataBaseUrls: [
    'https://statics.zerolink.com/purescience/specialist-marketplace/v1/',
    'https://raw.githubusercontent.com/naiyixi/purescience-specialist-marketplace/published/'
  ],
  artifactBaseUrls: ['https://statics.zerolink.com/purescience/specialist-marketplace/v1/'],
  trustedKeys: {
    'purescience-marketplace-2026-08':
      'MCowBQYDK2VwAyEAH/9tbjAr/mDQqgFSCmsnEFsTebIEUYxg0Mk9VT3OmtM='
  }
}
