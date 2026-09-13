import type { ArtifactRpcMethod } from '../../shared/artifact-provenance'

// The canonical set of artifact-capability RPC methods.
//
// This must be the ONLY list. A minting site that passes its own literal array silently narrows the
// capability, and the failure is invisible to every unit suite: the whitelist looks correct, the tool
// exists, and the call is refused at runtime with
// `Artifact RPC capability does not allow <method>.` — verified live on 2026-09-13, where
// `verify_artifact_reproduction` was denied because the turn owner passed a two-method array.
// Adding a method therefore means adding it here and nowhere else.
export const ARTIFACT_RPC_METHODS: ReadonlySet<ArtifactRpcMethod> = new Set<ArtifactRpcMethod>([
  'artifactCreateVersion',
  'artifactReplayVersion',
  'artifactCheckReproduction'
])
