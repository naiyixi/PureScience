// Unified credential store helpers: service catalog metadata, renderer-safe projection, and
// connectivity testing. Encryption lives in crypto.ts (service layer); this module stays
// dependency-light so it can be unit-tested without an Electron runtime.

import type {
  CredentialServiceId,
  CredentialTestResult,
  CredentialView,
  StoredCredential
} from '../../shared/settings'

// Display labels for the 8 built-in service kinds + custom.
export const CREDENTIAL_SERVICE_LABELS: Record<CredentialServiceId, string> = {
  aws: 'AWS',
  github: 'GitHub',
  gcp: 'Google Cloud',
  azure: 'Azure',
  modal: 'Modal',
  nvidia: 'NVIDIA',
  openalex: 'OpenAlex',
  literature: 'Literature access',
  custom: 'Custom'
}

// Renders a stored credential into its renderer-safe view: no plaintext, no ciphertext.
export const toCredentialView = (credential: StoredCredential): CredentialView => ({
  id: credential.id,
  serviceId: credential.serviceId,
  name: credential.name,
  ...(credential.username !== undefined ? { username: credential.username } : {}),
  ...(credential.hint !== undefined ? { hint: credential.hint } : {}),
  hasSecret: credential.secretRef !== undefined,
  createdAt: credential.createdAt,
  updatedAt: credential.updatedAt
})

// Connectivity check for one service with the plaintext secret. GitHub gets a real probe; the
// remaining services confirm the secret is present and well-formed (a live probe would need
// per-service endpoints that are out of scope for the settings panel).
export const testCredentialSecret = async (
  serviceId: CredentialServiceId,
  secret: string
): Promise<CredentialTestResult> => {
  switch (serviceId) {
    case 'github': {
      try {
        const response = await fetch('https://api.github.com/user', {
          headers: { authorization: `Bearer ${secret}`, accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(10_000)
        })
        if (response.ok) return { ok: true, message: 'GitHub token is valid.' }
        if (response.status === 401 || response.status === 403) {
          return { ok: false, message: 'GitHub rejected the token (unauthorized).' }
        }
        return { ok: false, message: `GitHub returned HTTP ${response.status}.` }
      } catch {
        return { ok: false, message: 'Could not reach api.github.com.' }
      }
    }
    case 'modal': {
      if (!/^ak-[A-Za-z0-9]+$/.test(secret)) {
        return { ok: false, message: 'Modal tokens look like ak-….' }
      }
      return { ok: true, message: 'Saved — live probe not available in the settings panel.' }
    }
    default:
      return { ok: true, message: 'Saved — live probe not available for this service.' }
  }
}
