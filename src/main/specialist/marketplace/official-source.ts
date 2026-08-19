import type { OfficialMarketplaceSourceConfig } from './service'

// The official PureScience Specialist Marketplace. The trusted-key table is intentionally EMPTY:
// no release has been published yet, so an empty table makes the official source fail closed at
// verification instead of trusting unsigned metadata. Users add sources from user-approved GitHub
// repositories (inspect → verify → add), which carry their own verified signing keys.
export const OFFICIAL_MARKETPLACE_SOURCE: OfficialMarketplaceSourceConfig = {
  id: 'purescience-official',
  name: 'PureScience Specialist Marketplace',
  repositoryUrl: 'https://github.com/naiyixi/purescience-specialist-marketplace',
  ref: 'published',
  metadataBaseUrls: [
    'https://statics.naiyixi.com/purescience/specialist-marketplace/v1/',
    'https://raw.githubusercontent.com/naiyixi/purescience-specialist-marketplace/published/'
  ],
  artifactBaseUrls: ['https://statics.naiyixi.com/purescience/specialist-marketplace/v1/'],
  trustedKeys: {}
}
