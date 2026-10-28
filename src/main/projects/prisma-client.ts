import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { PrismaClient } from '@prisma/client'

import {
  ensureSqliteCheckConstraints,
  type SqliteCheckConstraintMigration
} from './sqlite-schema-migrations'

const PROJECT_DB_FILE = 'purescience.db'
// SQLite PRAGMAs are connection-scoped. The runtime constraint migration disables foreign keys
// before entering its rebuild transaction, so this client must keep both operations on one physical
// connection. A single writer also avoids unnecessary SQLITE_BUSY contention for the local Project DB.
const PROJECT_DB_CONNECTION_LIMIT = 1
// A brief lock (a checkpoint, another process closing) should wait rather than fail the query outright.
const PROJECT_DB_BUSY_TIMEOUT_MS = 5000

// Exact DDL Prisma generates for the Project model (verified via `prisma migrate diff`). Applying it as
// CREATE TABLE IF NOT EXISTS lets a packaged app create its schema without shipping the migrate engine,
// while staying byte-compatible with what the generated client reads and writes.
const PROJECT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isExample" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);`

const PERMISSION_GRANT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "PermissionGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "capabilityKind" TEXT NOT NULL,
    "capabilityKey" TEXT NOT NULL,
    "qualifierMode" TEXT NOT NULL DEFAULT 'none',
    "qualifierValue" TEXT,
    "scopeKind" TEXT NOT NULL,
    "projectId" TEXT,
    "sessionId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME,
    CONSTRAINT "PermissionGrant_capabilityKind_check" CHECK ("capabilityKind" IN ('customize_mutation', 'mcp_tool', 'execution', 'file_operation', 'skill_operation', 'builtin_tool')),
    CONSTRAINT "PermissionGrant_capabilityKey_check" CHECK (length(trim("capabilityKey")) > 0),
    CONSTRAINT "PermissionGrant_qualifier_check" CHECK (
      ("qualifierMode" IN ('none', 'any') AND "qualifierValue" IS NULL) OR
      ("qualifierMode" IN ('category', 'exact') AND "qualifierValue" IS NOT NULL AND length(trim("qualifierValue")) > 0)
    ),
    CONSTRAINT "PermissionGrant_scope_check" CHECK (
      ("scopeKind" = 'global' AND "projectId" IS NULL AND "sessionId" IS NULL) OR
      ("scopeKind" = 'project' AND "projectId" IS NOT NULL AND "sessionId" IS NULL) OR
      ("scopeKind" = 'session' AND "projectId" IS NOT NULL AND "sessionId" IS NOT NULL)
    ),
    CONSTRAINT "PermissionGrant_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "PermissionGrant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`

const PERMISSION_GRANT_INDEX_DDLS = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "PermissionGrant_fingerprint_key" ON "PermissionGrant"("fingerprint")`,
  `CREATE INDEX IF NOT EXISTS "PermissionGrant_capabilityKind_capabilityKey_qualifierMode_qualifierValue_scopeKind_projectId_sessionId_idx" ON "PermissionGrant"("capabilityKind", "capabilityKey", "qualifierMode", "qualifierValue", "scopeKind", "projectId", "sessionId")`,
  `CREATE INDEX IF NOT EXISTS "PermissionGrant_projectId_sessionId_idx" ON "PermissionGrant"("projectId", "sessionId")`
]

// Same runtime-DDL approach for the per-project preview panel state table.
const PREVIEW_STATE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ProjectPreviewState" (
    "projectId" TEXT NOT NULL PRIMARY KEY,
    "panelState" TEXT NOT NULL,
    "activeItemId" TEXT,
    "items" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL
);`

// Unread terminal-task metadata is a small ordered projection; Session JSON remains authoritative.
const UNREAD_TASK_SESSION_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "UnreadTaskSession" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sessionId" TEXT NOT NULL
);`
const UNREAD_TASK_SESSION_SESSION_ID_INDEX_DDL = `CREATE UNIQUE INDEX IF NOT EXISTS "UnreadTaskSession_sessionId_key" ON "UnreadTaskSession"("sessionId");`

// Backend-owned message center (v0.12 notification center). Runtime DDL so a packaged app stays
// byte-compatible with the generated client without shipping the migrate engine.
const NOTIFICATION_INBOX_ITEM_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "NotificationInboxItem" (
    "sequence" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT,
    "projectId" TEXT,
    "sessionId" TEXT,
    "originId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" DATETIME,
    "actionState" TEXT,
    "settledAt" DATETIME
);`
const NOTIFICATION_INBOX_ITEM_INDEX_DDLS = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "NotificationInboxItem_id_key" ON "NotificationInboxItem"("id")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "NotificationInboxItem_dedupeKey_key" ON "NotificationInboxItem"("dedupeKey")`,
  `CREATE INDEX IF NOT EXISTS "NotificationInboxItem_readAt_sequence_idx" ON "NotificationInboxItem"("readAt", "sequence")`,
  `CREATE INDEX IF NOT EXISTS "NotificationInboxItem_sessionId_idx" ON "NotificationInboxItem"("sessionId")`,
  `CREATE INDEX IF NOT EXISTS "NotificationInboxItem_projectId_idx" ON "NotificationInboxItem"("projectId")`
]

// Reviewer results: one Review per audited turn, plus its child checks (stored in Finding table).
// v2 (issue 12): Review no longer has summary/checks JSON columns; all checks are Finding rows.
// v3 (issue 13): reasoning replaced by reviewerLog (captured action stream JSON array).
// Same runtime-DDL approach — applied as CREATE TABLE IF NOT EXISTS so a packaged app stays
// byte-compatible with the generated client.
const REVIEW_EVIDENCE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ReviewEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reviewId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'agent',
    "fingerprint" TEXT NOT NULL,
    "query" TEXT NOT NULL DEFAULT '',
    "terms" TEXT NOT NULL DEFAULT '[]',
    "snippet" TEXT NOT NULL DEFAULT '',
    "capturedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewEvidence_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`

const REVIEW_EVIDENCE_REVIEW_ID_INDEX_DDL = `CREATE INDEX IF NOT EXISTS "ReviewEvidence_reviewId_idx" ON "ReviewEvidence"("reviewId")`

// The reviewer panel loads by session; without this index it scanned the whole Review table, and each
// row carries `scope`/`reviewerLog` JSON — 244–498 ms for a single review on the real machine.
const REVIEW_SESSION_ID_INDEX_DDL = `CREATE INDEX IF NOT EXISTS "Review_sessionId_idx" ON "Review"("sessionId")`

// Checks are read per review in sort order; the table had no index beyond its primary key.
const FINDING_REVIEW_ID_SORT_INDEX_DDL = `CREATE INDEX IF NOT EXISTS "Finding_reviewId_sortIndex_idx" ON "Finding"("reviewId", "sortIndex")`

// Background result deliveries: the ledger that returns a finished job's result to its session even
// when no window is alive to notice it. `claimToken` + `claimExpiresAt` are the crash-safety pair: a
// delivery is only moved by the holder of a live lease, so a worker that dies mid-delivery can be
// taken over instead of stranding the result. Same runtime-DDL approach as the tables above.
const BACKGROUND_DELIVERY_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "BackgroundDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL DEFAULT 'compute',
    "state" TEXT NOT NULL DEFAULT 'waiting-result',
    "outputFiles" TEXT NOT NULL DEFAULT '[]',
    "fingerprint" TEXT,
    "claimToken" TEXT,
    "claimExpiresAt" DATETIME,
    "continuationMessageId" TEXT,
    "reason" TEXT,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);`

const BACKGROUND_DELIVERY_INDEX_DDLS = [
  `CREATE INDEX IF NOT EXISTS "BackgroundDelivery_sessionId_idx" ON "BackgroundDelivery"("sessionId")`,
  // One delivery per job, enforced by the database rather than by every caller remembering to check.
  `CREATE UNIQUE INDEX IF NOT EXISTS "BackgroundDelivery_jobId_key" ON "BackgroundDelivery"("jobId")`,
  // The claim scan reads by state and lease expiry: that is how an expired claim is found and taken over.
  `CREATE INDEX IF NOT EXISTS "BackgroundDelivery_state_claimExpiresAt_idx" ON "BackgroundDelivery"("state", "claimExpiresAt")`
]

const REVIEW_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "Review" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnMessageId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT '{}',
    "lifecycle" TEXT NOT NULL DEFAULT 'running',
    "outcome" TEXT,
    "errorMessage" TEXT,
    "model" TEXT NOT NULL DEFAULT '',
    "reviewerLog" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);`

// Migration: for existing DBs that still have the old reasoning column, add reviewerLog.
// The reasoning column is simply ignored by the new Prisma client.
const REVIEW_ADD_REVIEWER_LOG_DDL = `ALTER TABLE "Review" ADD COLUMN "reviewerLog" TEXT NOT NULL DEFAULT '[]'`

// Migration: add the `status` column to Finding if it doesn't exist yet (for DBs that have the old
// `severity` column). The schema guard below checks the desired column before applying this DDL.
const FINDING_ADD_STATUS_COLUMN_DDL = `ALTER TABLE "Finding" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pass'`

// The FOREIGN KEY ... ON DELETE CASCADE matches Prisma's generated DDL; the reviewer repository also
// deletes findings explicitly (deleteReviewsForSession/Project) so cleanup does not depend on the
// SQLite foreign-keys pragma being enabled.
// v2: severity replaced by status ('pass'|'warn'|'fail'); locator is now optional (pass checks omit it).
// v4 (issue 15): added reflagCount column (Phase 3 fix loop re-flag counter).
const FINDING_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "Finding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reviewId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pass',
    "resolution" TEXT NOT NULL DEFAULT 'open',
    "claim" TEXT NOT NULL DEFAULT '',
    "evidence" TEXT NOT NULL DEFAULT '',
    "locator" TEXT NOT NULL DEFAULT '{}',
    "artifactVersionId" TEXT,
    "artifactBindingState" TEXT NOT NULL DEFAULT 'legacy_unverified',
    "sortIndex" INTEGER NOT NULL DEFAULT 0,
    "reflagCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Finding_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`

// Migration guard: add the `reflagCount` column to Finding if it doesn't exist yet (for DBs that
// predate issue 15). SQLite does not support IF NOT EXISTS on ALTER TABLE ADD COLUMN, so the schema
// guard below proves the column postcondition explicitly.
const FINDING_ADD_REFLAG_COUNT_DDL = `ALTER TABLE "Finding" ADD COLUMN "reflagCount" INTEGER NOT NULL DEFAULT 0`
const FINDING_ADD_ARTIFACT_BINDING_STATE_DDL = `ALTER TABLE "Finding" ADD COLUMN "artifactBindingState" TEXT NOT NULL DEFAULT 'legacy_unverified'`

// Runtime DDL remains idempotent for existing installations that do not run a separate migration
// command. Prisma models provide typed access after these tables and indexes have been ensured.
const PROJECT_DELETION_INTENT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ProjectDeletionIntent" (
    "projectId" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);`

// Existing installations create their Project table before Archive existed. Keep the migration
// additive so no stored Project or its activity ordering is rewritten.
const PROJECT_ADD_ARCHIVED_AT_DDL = `ALTER TABLE "Project" ADD COLUMN "archivedAt" DATETIME`

// ManagedFile is a metadata projection only: storageKey points back into the existing managed roots,
// while soft-delete fields keep Files queries reversible during durable session/project deletion.
const MANAGED_FILE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ManagedFile" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "source" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "sourceVersionId" TEXT,
    "checksum" TEXT,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "messageId" TEXT,
    "displayName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "mtimeMs" BIGINT,
    "sortAtMs" BIGINT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "deleteOperationId" TEXT
);`

const MANAGED_FILE_ADD_SOURCE_VERSION_ID_DDL = `ALTER TABLE "ManagedFile" ADD COLUMN "sourceVersionId" TEXT`
const MANAGED_FILE_ADD_CHECKSUM_DDL = `ALTER TABLE "ManagedFile" ADD COLUMN "checksum" TEXT`
// Why a produced Version was left unpublished, named so the file view can say which: absent on published
// Versions and on rows written before this column existed.
const ARTIFACT_VERSION_ADD_STATE_REASON_DDL = `ALTER TABLE "ArtifactVersion" ADD COLUMN "stateReason" TEXT`

// One ledger row per session provides the filesRevision fast path, materialized source counts, and the
// independent ordering key used by artifact-group pagination.
const MANAGED_FILE_SESSION_SYNC_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ManagedFileSessionSync" (
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "filesRevision" INTEGER NOT NULL,
    "groupSortAtMs" BIGINT NOT NULL,
    "artifactCount" INTEGER NOT NULL DEFAULT 0,
    "uploadCount" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    "deleteOperationId" TEXT,
    PRIMARY KEY ("projectId", "sessionId")
);`

// Index order mirrors the three keyset queries: uploads, one session's artifacts, and session groups.
// Project-scoped unique keys also enforce canonical ownership for legacy duplicate references.
const MANAGED_FILE_INDEX_DDLS = [
  `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "deletedAt", "sortAtMs", "seq");`,
  `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_source_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "source", "deletedAt", "sortAtMs", "seq");`,
  `CREATE INDEX IF NOT EXISTS "ManagedFile_projectId_sessionId_source_deletedAt_sortAtMs_seq_idx" ON "ManagedFile"("projectId", "sessionId", "source", "deletedAt", "sortAtMs", "seq");`,
  `CREATE INDEX IF NOT EXISTS "ManagedFile_sessionId_deletedAt_idx" ON "ManagedFile"("sessionId", "deletedAt");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ManagedFile_projectId_source_sourceFileId_key" ON "ManagedFile"("projectId", "source", "sourceFileId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ManagedFile_projectId_source_storageKey_key" ON "ManagedFile"("projectId", "source", "storageKey");`,
  `CREATE INDEX IF NOT EXISTS "ManagedFileSessionSync_projectId_deletedAt_groupSortAtMs_sessionId_idx" ON "ManagedFileSessionSync"("projectId", "deletedAt", "groupSortAtMs", "sessionId");`
]

// Artifact Provenance starts with a narrow retained origin, one stable filename lineage, and its
// immutable save Versions. Runtime DDL mirrors Prisma's SQLite migration output so packaged installs
// can add the tables without shipping the migrate engine.
const FILE_ORIGIN_SESSION_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "FileOriginSession" (
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "titleSnapshot" TEXT,
    "state" TEXT NOT NULL DEFAULT 'active',
    "deletedAt" DATETIME,
    "deletionOperationId" TEXT,
    "retainedReviewIdsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FileOriginSession_state_check" CHECK ("state" IN ('active', 'deleting', 'deleted')),
    PRIMARY KEY ("projectId", "sessionId")
);`

const ARTIFACT_LINEAGE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ArtifactLineage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "normalizedFilename" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ArtifactLineage_projectId_sessionId_fkey" FOREIGN KEY ("projectId", "sessionId") REFERENCES "FileOriginSession" ("projectId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE
);`

const UPLOAD_FILE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "UploadFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UploadFile_projectId_sessionId_fkey" FOREIGN KEY ("projectId", "sessionId") REFERENCES "FileOriginSession" ("projectId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE
);`

const UPLOAD_VERSION_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "UploadVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "uploadFileId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'staging',
    "contentStorageKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "contentType" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "createdAt" DATETIME,
    "registeredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UploadVersion_state_check" CHECK ("state" IN ('staging', 'ready')),
    CONSTRAINT "UploadVersion_uploadFileId_fkey" FOREIGN KEY ("uploadFileId") REFERENCES "UploadFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`

const ARTIFACT_MESSAGE_SNAPSHOT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ArtifactMessageSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "rootFrameId" TEXT NOT NULL,
    "agentFrameId" TEXT NOT NULL,
    "messageBranchId" TEXT NOT NULL,
    "terminalMessageId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'staging',
    "storageKey" TEXT NOT NULL,
    "checksum" TEXT NOT NULL DEFAULT '',
    "messageCount" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ArtifactMessageSnapshot_state_check" CHECK ("state" IN ('staging', 'ready')),
    CONSTRAINT "ArtifactMessageSnapshot_projectId_sessionId_fkey" FOREIGN KEY ("projectId", "sessionId") REFERENCES "FileOriginSession" ("projectId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE
);`

const ARTIFACT_MESSAGE_SNAPSHOT_ADD_CHECKSUM_DDL = `ALTER TABLE "ArtifactMessageSnapshot" ADD COLUMN "checksum" TEXT NOT NULL DEFAULT '';`

const ARTIFACT_VERSION_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ArtifactVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "artifactId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "artifactRunId" TEXT NOT NULL,
    "writeOperationId" TEXT,
    "writeRequestChecksum" TEXT,
    "rootFrameId" TEXT NOT NULL,
    "agentFrameId" TEXT NOT NULL,
    "messageBranchId" TEXT NOT NULL,
    "runtimeSegmentId" TEXT NOT NULL,
    "promptMessageId" TEXT NOT NULL,
    "notebookSessionId" TEXT,
    "producerRunId" TEXT,
    "producerRunIndex" INTEGER,
    "messageId" TEXT,
    "messageSnapshotId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'staging',
    "contentStorageKey" TEXT NOT NULL,
    "evidenceStorageKey" TEXT NOT NULL,
    "contentType" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "evidenceJson" TEXT NOT NULL,
    "evidenceChecksum" TEXT NOT NULL,
    "evidenceSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "executionSnapshotJson" TEXT,
    "executionSnapshotChecksum" TEXT,
    "executionSnapshotStorageKey" TEXT,
    "executionSnapshotSchemaVersion" INTEGER,
    "stateReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ArtifactVersion_state_check" CHECK ("state" IN ('staging', 'pending', 'finalized', 'unpublished')),
    CONSTRAINT "ArtifactVersion_filename_check" CHECK (length("filename") > 0),
    CONSTRAINT "ArtifactVersion_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "ArtifactLineage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersion_messageSnapshotId_fkey" FOREIGN KEY ("messageSnapshotId") REFERENCES "ArtifactMessageSnapshot" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);`

const ARTIFACT_VERSION_ADD_FILENAME_DDL = `ALTER TABLE "ArtifactVersion" ADD COLUMN "filename" TEXT`

const ARTIFACT_VERSION_INPUT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ArtifactVersionInput" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "artifactVersionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "inputFileVersionId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "sourceArtifactVersionId" TEXT,
    "sourceUploadVersionId" TEXT,
    "sourceVersionNumber" INTEGER,
    "sourceCreatedAt" DATETIME,
    "sourceProjectId" TEXT NOT NULL,
    "sourceSessionId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "strongestAssociation" TEXT NOT NULL,
    CONSTRAINT "ArtifactVersionInput_sourceKind_check" CHECK ("sourceKind" IN ('artifact-version', 'upload-version')),
    CONSTRAINT "ArtifactVersionInput_sourceIdentity_check" CHECK (
      ("sourceKind" = 'artifact-version' AND "sourceArtifactVersionId" IS NOT NULL AND "sourceUploadVersionId" IS NULL AND "inputFileVersionId" = "sourceArtifactVersionId") OR
      ("sourceKind" = 'upload-version' AND "sourceUploadVersionId" IS NOT NULL AND "sourceArtifactVersionId" IS NULL AND "inputFileVersionId" = "sourceUploadVersionId")
    ),
    CONSTRAINT "ArtifactVersionInput_artifactVersionId_fkey" FOREIGN KEY ("artifactVersionId") REFERENCES "ArtifactVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersionInput_sourceArtifactVersionId_fkey" FOREIGN KEY ("sourceArtifactVersionId") REFERENCES "ArtifactVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersionInput_sourceUploadVersionId_fkey" FOREIGN KEY ("sourceUploadVersionId") REFERENCES "UploadVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ArtifactVersionInput_sourceProjectId_sourceSessionId_fkey" FOREIGN KEY ("sourceProjectId", "sourceSessionId") REFERENCES "FileOriginSession" ("projectId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE
);`

const REVIEW_FINDING_DISPOSITION_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ReviewFindingDisposition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceFindingId" TEXT NOT NULL,
    "causeReviewId" TEXT,
    "sequence" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "note" TEXT,
    "assessedArtifactVersionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewFindingDisposition_sourceFindingId_fkey" FOREIGN KEY ("sourceFindingId") REFERENCES "Finding" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReviewFindingDisposition_causeReviewId_fkey" FOREIGN KEY ("causeReviewId") REFERENCES "Review" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);`

const REVIEW_SCOPE_SNAPSHOT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ReviewScopeSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "scopeTurnMessageId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'staging',
    "snapshotJson" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "blockCount" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewScopeSnapshot_state_check" CHECK ("state" IN ('staging', 'ready')),
    CONSTRAINT "ReviewScopeSnapshot_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`

const PROVENANCE_CHECK_CONSTRAINT_MIGRATIONS: readonly SqliteCheckConstraintMigration[] = [
  {
    tableName: 'FileOriginSession',
    columnName: 'state',
    constraintNames: ['FileOriginSession_state_check'],
    allowedValues: ['active', 'deleting', 'deleted'],
    canonicalTableDdl: FILE_ORIGIN_SESSION_TABLE_DDL
  },
  {
    tableName: 'UploadVersion',
    columnName: 'state',
    constraintNames: ['UploadVersion_state_check'],
    allowedValues: ['staging', 'ready'],
    canonicalTableDdl: UPLOAD_VERSION_TABLE_DDL
  },
  {
    tableName: 'ArtifactMessageSnapshot',
    columnName: 'state',
    constraintNames: ['ArtifactMessageSnapshot_state_check'],
    allowedValues: ['staging', 'ready'],
    canonicalTableDdl: ARTIFACT_MESSAGE_SNAPSHOT_TABLE_DDL
  },
  {
    tableName: 'ArtifactVersion',
    columnName: 'state',
    constraintNames: ['ArtifactVersion_state_check', 'ArtifactVersion_filename_check'],
    allowedValues: ['staging', 'pending', 'finalized', 'unpublished'],
    canonicalTableDdl: ARTIFACT_VERSION_TABLE_DDL
  },
  {
    tableName: 'ArtifactVersionInput',
    columnName: 'sourceKind',
    constraintNames: [
      'ArtifactVersionInput_sourceKind_check',
      'ArtifactVersionInput_sourceIdentity_check'
    ],
    allowedValues: ['artifact-version', 'upload-version'],
    canonicalTableDdl: ARTIFACT_VERSION_INPUT_TABLE_DDL
  },
  {
    tableName: 'ReviewScopeSnapshot',
    columnName: 'state',
    constraintNames: ['ReviewScopeSnapshot_state_check'],
    allowedValues: ['staging', 'ready'],
    canonicalTableDdl: REVIEW_SCOPE_SNAPSHOT_TABLE_DDL
  }
]

const ARTIFACT_PROVENANCE_INDEX_DDLS = [
  `CREATE INDEX IF NOT EXISTS "FileOriginSession_projectId_state_idx" ON "FileOriginSession"("projectId", "state");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactLineage_projectId_sessionId_idx" ON "ArtifactLineage"("projectId", "sessionId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactLineage_projectId_sessionId_normalizedFilename_key" ON "ArtifactLineage"("projectId", "sessionId", "normalizedFilename");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersion_writeOperationId_key" ON "ArtifactVersion"("writeOperationId");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersion_artifactId_createdAt_idx" ON "ArtifactVersion"("artifactId", "createdAt");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersion_artifactRunId_state_idx" ON "ArtifactVersion"("artifactRunId", "state");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersion_rootFrameId_agentFrameId_messageBranchId_promptMessageId_idx" ON "ArtifactVersion"("rootFrameId", "agentFrameId", "messageBranchId", "promptMessageId");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersion_messageId_idx" ON "ArtifactVersion"("messageId");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersion_messageSnapshotId_idx" ON "ArtifactVersion"("messageSnapshotId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersion_artifactId_versionNumber_key" ON "ArtifactVersion"("artifactId", "versionNumber");`,
  `CREATE INDEX IF NOT EXISTS "UploadFile_projectId_sessionId_idx" ON "UploadFile"("projectId", "sessionId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "UploadVersion_uploadFileId_versionNumber_key" ON "UploadVersion"("uploadFileId", "versionNumber");`,
  `CREATE INDEX IF NOT EXISTS "UploadVersion_uploadFileId_state_registeredAt_idx" ON "UploadVersion"("uploadFileId", "state", "registeredAt");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactMessageSnapshot_projectId_sessionId_agentFrameId_messageBranchId_terminalMessageId_key" ON "ArtifactMessageSnapshot"("projectId", "sessionId", "agentFrameId", "messageBranchId", "terminalMessageId");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactMessageSnapshot_projectId_sessionId_state_idx" ON "ArtifactMessageSnapshot"("projectId", "sessionId", "state");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersionInput_artifactVersionId_sourceKind_inputFileVersionId_key" ON "ArtifactVersionInput"("artifactVersionId", "sourceKind", "inputFileVersionId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ArtifactVersionInput_artifactVersionId_ordinal_key" ON "ArtifactVersionInput"("artifactVersionId", "ordinal");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceKind_inputFileVersionId_idx" ON "ArtifactVersionInput"("sourceKind", "inputFileVersionId");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceArtifactVersionId_idx" ON "ArtifactVersionInput"("sourceArtifactVersionId");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceUploadVersionId_idx" ON "ArtifactVersionInput"("sourceUploadVersionId");`,
  `CREATE INDEX IF NOT EXISTS "ArtifactVersionInput_sourceProjectId_sourceSessionId_idx" ON "ArtifactVersionInput"("sourceProjectId", "sourceSessionId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ReviewFindingDisposition_sourceFindingId_sequence_key" ON "ReviewFindingDisposition"("sourceFindingId", "sequence");`,
  `CREATE INDEX IF NOT EXISTS "ReviewFindingDisposition_causeReviewId_createdAt_idx" ON "ReviewFindingDisposition"("causeReviewId", "createdAt");`,
  `CREATE INDEX IF NOT EXISTS "ReviewFindingDisposition_assessedArtifactVersionId_idx" ON "ReviewFindingDisposition"("assessedArtifactVersionId");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ReviewScopeSnapshot_reviewId_key" ON "ReviewScopeSnapshot"("reviewId");`,
  `CREATE INDEX IF NOT EXISTS "ReviewScopeSnapshot_projectId_sessionId_state_idx" ON "ReviewScopeSnapshot"("projectId", "sessionId", "state");`
]

// Compute settings: one row per registered SSH compute host (Compute tab, issue 01). Pure-additive
// table — it references nothing and nothing references it, so this CREATE runs safely against any
// pre-existing DB. The DDL is byte-identical to what `prisma migrate diff` generates for the
// ComputeHost model (verified in prisma-client.test.ts), keeping the runtime schema compatible with
// the generated client without shipping the migrate engine. Security: only an ssh alias + optional
// non-secret overrides are stored here; no credentials or keys (design.md §1/§3).
const COMPUTE_HOST_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ComputeHost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "shape" TEXT NOT NULL DEFAULT 'direct_ssh',
    "executionMode" TEXT NOT NULL DEFAULT 'direct_ssh',
    "sshAlias" TEXT NOT NULL,
    "sshOverrides" TEXT,
    "scratchRoot" TEXT,
    "scratchPinned" BOOLEAN NOT NULL DEFAULT false,
    "concurrencyLimit" INTEGER,
    "probeResult" TEXT,
    "detailsDoc" TEXT NOT NULL DEFAULT '',
    "detailsUpdatedAt" DATETIME,
    "detailsUpdatedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);`

// The unique index Prisma expects for @unique providerId. Created separately (matching the migrate
// output) and guarded with IF NOT EXISTS so re-running ensure is idempotent.
const COMPUTE_HOST_PROVIDER_ID_INDEX_DDL = `CREATE UNIQUE INDEX IF NOT EXISTS "ComputeHost_providerId_key" ON "ComputeHost"("providerId")`

// Migration guard: add executionMode (direct_ssh | slurm) to ComputeHost for DBs created before
// the Slurm execution-mode work. NOT NULL DEFAULT backfills existing hosts as direct_ssh.
const COMPUTE_HOST_ADD_EXECUTION_MODE_DDL = `ALTER TABLE "ComputeHost" ADD COLUMN "executionMode" TEXT NOT NULL DEFAULT 'direct_ssh'`

// Compute jobs (Phase 3a, compute-jobs issue 01). Pure-additive table — references nothing and
// nothing references it. Tracks the full job lifecycle from submitted through terminal states.
// Harvest columns (harvestedAt, outputManifest) are created now but filled in Phase 3b only.
// Security: command stored for audit; commandHash for dedup; no credentials ever stored.
// compute-jobs issue 02: added lastPollError for SSH-connectivity-failure recording (design.md §8).
// compute-harvest issue 01: added harvestError, leftOnRemote, notifiedAt, notificationConsumedAt
//   (pure-additive; null until Phase 3b fills them).
const COMPUTE_JOB_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ComputeJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "shape" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "intent" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "commandHash" TEXT NOT NULL,
    "environment" TEXT,
    "resourceRequest" TEXT,
    "inputManifest" TEXT,
    "outputManifest" TEXT,
    "harvestConfig" TEXT,
    "timeoutSeconds" INTEGER,
    "remoteWorkdir" TEXT,
    "remoteHandle" TEXT,
    "exitCode" INTEGER,
    "stdoutTail" TEXT,
    "stderrTail" TEXT,
    "errorCode" TEXT,
    "lastPollError" TEXT,
    "harvestError" TEXT,
    "leftOnRemote" TEXT,
    "notifiedAt" DATETIME,
    "notificationConsumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" DATETIME,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "harvestedAt" DATETIME
);`

// Migration guard: add lastPollError to ComputeJob for DBs created before compute-jobs issue 02.
const COMPUTE_JOB_ADD_LAST_POLL_ERROR_DDL = `ALTER TABLE "ComputeJob" ADD COLUMN "lastPollError" TEXT`

// Migration guards: add the 4 new Phase 3b harvest columns to ComputeJob for DBs created before
// compute-harvest issue 01. Each is nullable and defaults to NULL so existing rows are unaffected.
const COMPUTE_JOB_ADD_HARVEST_ERROR_DDL = `ALTER TABLE "ComputeJob" ADD COLUMN "harvestError" TEXT`
const COMPUTE_JOB_ADD_LEFT_ON_REMOTE_DDL = `ALTER TABLE "ComputeJob" ADD COLUMN "leftOnRemote" TEXT`
const COMPUTE_JOB_ADD_NOTIFIED_AT_DDL = `ALTER TABLE "ComputeJob" ADD COLUMN "notifiedAt" DATETIME`
const COMPUTE_JOB_ADD_NOTIFICATION_CONSUMED_AT_DDL = `ALTER TABLE "ComputeJob" ADD COLUMN "notificationConsumedAt" DATETIME`

// Migration guard: add the execution-protection snapshot to ComputeJob. Nullable like the harvest
// columns, so a database created before protection levels existed keeps working without a rewrite.
const COMPUTE_JOB_ADD_EXECUTION_PROTECTION_DDL = `ALTER TABLE "ComputeJob" ADD COLUMN "executionProtection" TEXT`

// Cached image-evidence results from the Vision model relay . Pure-additive
// table referencing nothing, applied as CREATE TABLE IF NOT EXISTS so a packaged app stays
// byte-compatible with the generated client without shipping the migrate engine. DDL mirrors the
// Prisma model in schema.prisma (verified via `prisma migrate diff` in the compatibility tests).
const VISION_EVIDENCE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "VisionEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "uploadVersionId" TEXT,
    "sourceMessageId" TEXT,
    "sourceImageId" TEXT,
    "imageChecksum" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "extractorFingerprint" TEXT NOT NULL,
    "evidenceSchemaVersion" INTEGER NOT NULL,
    "evidenceJson" TEXT NOT NULL,
    "evidenceChecksum" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VisionEvidence_sourceKind_check" CHECK ("sourceKind" IN ('upload-version', 'message-image')),
    CONSTRAINT "VisionEvidence_sourceIdentity_check" CHECK ((("sourceKind" = 'upload-version' AND "uploadVersionId" IS NOT NULL AND "sourceMessageId" IS NULL AND "sourceImageId" IS NULL) OR ("sourceKind" = 'message-image' AND "uploadVersionId" IS NULL AND "sourceMessageId" IS NOT NULL AND "sourceImageId" IS NOT NULL))),
    CONSTRAINT "VisionEvidence_schemaVersion_check" CHECK ("evidenceSchemaVersion" >= 1),
    CONSTRAINT "VisionEvidence_imageChecksum_check" CHECK (length("imageChecksum") = 64 AND "imageChecksum" NOT GLOB '*[^0-9a-f]*'),
    CONSTRAINT "VisionEvidence_extractorFingerprint_check" CHECK (length("extractorFingerprint") = 64 AND "extractorFingerprint" NOT GLOB '*[^0-9a-f]*'),
    CONSTRAINT "VisionEvidence_evidenceChecksum_check" CHECK (length("evidenceChecksum") = 64 AND "evidenceChecksum" NOT GLOB '*[^0-9a-f]*'),
    CONSTRAINT "VisionEvidence_evidenceJson_check" CHECK (json_valid("evidenceJson") AND json_type("evidenceJson") = 'object')
);`
const VISION_EVIDENCE_INDEX_DDLS = [
  `CREATE INDEX IF NOT EXISTS "VisionEvidence_projectId_sessionId_idx" ON "VisionEvidence"("projectId", "sessionId")`,
  `CREATE INDEX IF NOT EXISTS "VisionEvidence_sessionId_idx" ON "VisionEvidence"("sessionId")`,
  `CREATE INDEX IF NOT EXISTS "VisionEvidence_uploadVersionId_idx" ON "VisionEvidence"("uploadVersionId")`
]

// Reference library (v1.51): three pure-additive tables with no relations to pre-existing tables.
// CREATE TABLE IF NOT EXISTS keeps re-runs idempotent and older DBs byte-compatible with the
// generated client (same runtime-DDL approach as every table above).
const REFERENCE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "Reference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "authorsJson" TEXT NOT NULL DEFAULT '[]',
    "venue" TEXT,
    "year" INTEGER,
    "volume" TEXT,
    "issue" TEXT,
    "pages" TEXT,
    "publisher" TEXT,
    "itemType" TEXT,
    "doi" TEXT,
    "pmid" TEXT,
    "pmcid" TEXT,
    "arxivId" TEXT,
    "url" TEXT,
    "abstractSnippet" TEXT,
    "sourceConnector" TEXT NOT NULL DEFAULT 'manual',
    "sourceRecordId" TEXT,
    "citationKey" TEXT NOT NULL,
    "provenanceJson" TEXT,
    "pdfManagedFileId" TEXT,
    "pdfContentHash" TEXT,
    "notes" TEXT,
    "citedAt" DATETIME,
    "citedSessionId" TEXT,
    "integrityStatus" TEXT,
    "integrityCheckedAt" DATETIME,
    "integritySourceUrl" TEXT,
    "integrityNoticesJson" TEXT,
    "integrityEvidence" TEXT,
    "readingStatus" TEXT,
    "readingStatusUpdatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
)`
const REFERENCE_ADD_INTEGRITY_STATUS_DDL = `ALTER TABLE "Reference" ADD COLUMN "integrityStatus" TEXT`
const REFERENCE_ADD_INTEGRITY_CHECKED_AT_DDL = `ALTER TABLE "Reference" ADD COLUMN "integrityCheckedAt" DATETIME`
const REFERENCE_ADD_INTEGRITY_SOURCE_URL_DDL = `ALTER TABLE "Reference" ADD COLUMN "integritySourceUrl" TEXT`
const REFERENCE_ADD_INTEGRITY_NOTICES_DDL = `ALTER TABLE "Reference" ADD COLUMN "integrityNoticesJson" TEXT`
const REFERENCE_ADD_INTEGRITY_EVIDENCE_DDL = `ALTER TABLE "Reference" ADD COLUMN "integrityEvidence" TEXT`
// B3: additive reading-state columns, so a record imported before the layer keeps reading as `unread`.
const REFERENCE_ADD_READING_STATUS_DDL = `ALTER TABLE "Reference" ADD COLUMN "readingStatus" TEXT`
const REFERENCE_ADD_READING_STATUS_AT_DDL = `ALTER TABLE "Reference" ADD COLUMN "readingStatusUpdatedAt" DATETIME`
const REFERENCE_ADD_PDF_CONTENT_HASH_DDL = `ALTER TABLE "Reference" ADD COLUMN "pdfContentHash" TEXT`
// Citation-style layer (v1.65): additive columns on Reference, added to existing databases too.
const REFERENCE_ADD_VOLUME_DDL = `ALTER TABLE "Reference" ADD COLUMN "volume" TEXT`
const REFERENCE_ADD_ISSUE_DDL = `ALTER TABLE "Reference" ADD COLUMN "issue" TEXT`
const REFERENCE_ADD_PAGES_DDL = `ALTER TABLE "Reference" ADD COLUMN "pages" TEXT`
const REFERENCE_ADD_PUBLISHER_DDL = `ALTER TABLE "Reference" ADD COLUMN "publisher" TEXT`
const REFERENCE_ADD_ITEM_TYPE_DDL = `ALTER TABLE "Reference" ADD COLUMN "itemType" TEXT`
// v2.6.0 A2: a citation mark — when the record was declared cited, and by which session — added
// to existing databases too, because a citation recorded on one machine has to read back on the
// same one after an upgrade.
const REFERENCE_ADD_CITED_AT_DDL = `ALTER TABLE "Reference" ADD COLUMN "citedAt" DATETIME`
const REFERENCE_ADD_CITED_SESSION_ID_DDL = `ALTER TABLE "Reference" ADD COLUMN "citedSessionId" TEXT`
const REFERENCE_UNIQUE_PROJECT_CITATION_KEY_DDL = `CREATE UNIQUE INDEX IF NOT EXISTS "Reference_projectId_citationKey_key" ON "Reference"("projectId", "citationKey")`
const REFERENCE_INDEX_DDLS = [
  `CREATE INDEX IF NOT EXISTS "Reference_projectId_idx" ON "Reference"("projectId")`,
  `CREATE INDEX IF NOT EXISTS "Reference_doi_idx" ON "Reference"("doi")`,
  `CREATE INDEX IF NOT EXISTS "Reference_pmid_idx" ON "Reference"("pmid")`,
  `CREATE INDEX IF NOT EXISTS "Reference_arxivId_idx" ON "Reference"("arxivId")`,
  // v2.6.0 A2: the citation mark's own index, mirroring the Prisma @@index([projectId, citedAt]).
  `CREATE INDEX IF NOT EXISTS "Reference_projectId_citedAt_idx" ON "Reference"("projectId", "citedAt")`
]

const REFERENCE_ATTACHMENT_VERSION_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ReferenceAttachmentVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "referenceId" TEXT NOT NULL,
    "managedFileId" TEXT NOT NULL,
    "contentHash" TEXT,
    "attachedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replacedAt" DATETIME
)`
const REFERENCE_ATTACHMENT_VERSION_INDEX_DDLS = [
  `CREATE INDEX IF NOT EXISTS "ReferenceAttachmentVersion_referenceId_idx" ON "ReferenceAttachmentVersion"("referenceId")`
]

// Imported citation styles (v1.65): a formatting asset, so it is application-wide rather than
// project-scoped, and it stores the whole compiled program plus the provenance of the document.
const CITATION_STYLE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "CitationStyle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "styleId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "license" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "styleUpdatedAt" TEXT,
    "defaultLocale" TEXT,
    "contentHash" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "unsupportedJson" TEXT NOT NULL DEFAULT '[]',
    "fidelity" TEXT NOT NULL DEFAULT 'verified',
    "fidelityNotesJson" TEXT NOT NULL DEFAULT '[]',
    "programJson" TEXT NOT NULL,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`
const CITATION_STYLE_UNIQUE_STYLE_ID_DDL = `CREATE UNIQUE INDEX IF NOT EXISTS "CitationStyle_styleId_key" ON "CitationStyle"("styleId")`
const CITATION_STYLE_IMPORTED_AT_INDEX_DDL = `CREATE INDEX IF NOT EXISTS "CitationStyle_importedAt_idx" ON "CitationStyle"("importedAt")`
// Added after the table's first release within the same version window: an existing store gets the
// columns rather than being treated as current.
const CITATION_STYLE_ADD_FIDELITY_DDL = `ALTER TABLE "CitationStyle" ADD COLUMN "fidelity" TEXT NOT NULL DEFAULT 'verified'`
const CITATION_STYLE_ADD_FIDELITY_NOTES_DDL = `ALTER TABLE "CitationStyle" ADD COLUMN "fidelityNotesJson" TEXT NOT NULL DEFAULT '[]'`

const REFERENCE_COLLECTION_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ReferenceCollection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
)`
const REFERENCE_COLLECTION_UNIQUE_PROJECT_NAME_DDL = `CREATE UNIQUE INDEX IF NOT EXISTS "ReferenceCollection_projectId_name_key" ON "ReferenceCollection"("projectId", "name")`
const REFERENCE_COLLECTION_PROJECT_INDEX_DDL = `CREATE INDEX IF NOT EXISTS "ReferenceCollection_projectId_idx" ON "ReferenceCollection"("projectId")`

const COLLECTION_ITEM_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "CollectionItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "collectionId" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "note" TEXT,
    "sortIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`
const COLLECTION_ITEM_UNIQUE_COLLECTION_REFERENCE_DDL = `CREATE UNIQUE INDEX IF NOT EXISTS "CollectionItem_collectionId_referenceId_key" ON "CollectionItem"("collectionId", "referenceId")`
const COLLECTION_ITEM_REFERENCE_INDEX_DDL = `CREATE INDEX IF NOT EXISTS "CollectionItem_referenceId_idx" ON "CollectionItem"("referenceId")`

// Literature screening (v1.77): the纳排分诊 layer over the reference library above. Five pure-additive
// tables with logical foreign keys only (no relational constraints) — nothing references them, so
// these CREATE/INDEX statements stay safe to (re)run on any existing DB, and their DDL is
// byte-identical to what `prisma migrate diff` generates for the Screening* models. The composite
// primary keys are load-bearing, not convenience: (collectionId, revision) makes a rule revision
// immutable (a second write of the same revision cannot overwrite it), (collectionId, referenceId)
// gives a reference exactly one current verdict, and (runId, referenceId) makes a pass resumable
// without duplicating its own progress rows.
const SCREENING_RULE_REVISION_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ScreeningRuleRevision" (
    "collectionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "inclusionJson" TEXT NOT NULL DEFAULT '[]',
    "exclusionJson" TEXT NOT NULL DEFAULT '[]',
    "contentHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("collectionId", "revision")
)`
const SCREENING_ASSESSMENT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ScreeningAssessment" (
    "collectionId" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "ruleRevision" INTEGER NOT NULL,
    "inputDigest" TEXT NOT NULL,
    "policyKey" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "verdict" TEXT NOT NULL DEFAULT 'not-evaluated',
    "probabilitiesJson" TEXT NOT NULL DEFAULT '{}',
    "evidenceJson" TEXT NOT NULL DEFAULT '[]',
    "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("collectionId", "referenceId")
)`
const SCREENING_OVERRIDE_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ScreeningOverride" (
    "collectionId" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("collectionId", "referenceId")
)`
const SCREENING_RUN_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ScreeningRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "collectionId" TEXT NOT NULL,
    "ruleRevision" INTEGER NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'running'
)`
const SCREENING_RUN_ITEM_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "ScreeningRunItem" (
    "runId" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "failureKind" TEXT,
    "deferredReason" TEXT,
    "inputDigest" TEXT,
    PRIMARY KEY ("runId", "referenceId")
)`
const SCREENING_INDEX_DDLS = [
  `CREATE INDEX IF NOT EXISTS "ScreeningRuleRevision_collectionId_contentHash_idx" ON "ScreeningRuleRevision"("collectionId", "contentHash")`,
  `CREATE INDEX IF NOT EXISTS "ScreeningAssessment_collectionId_verdict_idx" ON "ScreeningAssessment"("collectionId", "verdict")`,
  `CREATE INDEX IF NOT EXISTS "ScreeningAssessment_collectionId_ruleRevision_idx" ON "ScreeningAssessment"("collectionId", "ruleRevision")`,
  `CREATE INDEX IF NOT EXISTS "ScreeningOverride_collectionId_createdAt_idx" ON "ScreeningOverride"("collectionId", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "ScreeningRun_collectionId_startedAt_idx" ON "ScreeningRun"("collectionId", "startedAt")`,
  `CREATE INDEX IF NOT EXISTS "ScreeningRun_status_idx" ON "ScreeningRun"("status")`,
  `CREATE INDEX IF NOT EXISTS "ScreeningRunItem_runId_state_idx" ON "ScreeningRunItem"("runId", "state")`
]

// Journals as first-class entities (R2). Index names follow Prisma's own conventions
// (Journal_issn_key / Journal_normalizedName_idx / JournalMetric_journalId_kind_year_idx) so this DDL stays
// byte-compatible with what `prisma migrate diff` generates — the property the statements below rely on.
const JOURNAL_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "Journal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "normalizedName" TEXT NOT NULL,
    "issn" TEXT,
    "issnL" TEXT,
    "eissn" TEXT,
    "publisher" TEXT,
    "homepage" TEXT,
    "createdVia" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`
const JOURNAL_METRIC_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "JournalMetric" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "journalId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "numericValue" REAL,
    "year" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT
)`
const JOURNAL_INDEX_DDLS = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "Journal_issn_key" ON "Journal"("issn")`,
  `CREATE INDEX IF NOT EXISTS "Journal_normalizedName_idx" ON "Journal"("normalizedName")`,
  `CREATE INDEX IF NOT EXISTS "JournalMetric_journalId_kind_year_idx" ON "JournalMetric"("journalId", "kind", "year")`
]
// Aliases (R2-U4). The unique index is the load-bearing one: a spelling can name exactly one journal, so a
// second alias for the same spelling is refused by the database itself and not only by a caller's check.
const JOURNAL_ALIAS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "JournalAlias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "normalizedName" TEXT NOT NULL,
    "journalId" TEXT NOT NULL,
    "createdVia" TEXT NOT NULL,
    "mergedFromJournalId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`
const JOURNAL_ALIAS_INDEX_DDLS = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "JournalAlias_normalizedName_key" ON "JournalAlias"("normalizedName")`,
  `CREATE INDEX IF NOT EXISTS "JournalAlias_journalId_idx" ON "JournalAlias"("journalId")`
]
const REFERENCE_JOURNAL_ID_INDEX_DDL = `CREATE INDEX IF NOT EXISTS "Reference_journalId_idx" ON "Reference"("journalId")`

// PDF annotations (文档标注层 A1): two pure-additive tables with logical foreign keys only (no
// relational constraints) — nothing references them and they reference nothing, so these CREATE/INDEX
// statements stay safe to (re)run on any existing DB, and their DDL is byte-identical to what
// `prisma migrate diff` generates for the PdfAnnotation* models. Two properties are load-bearing:
//   * the version anchor — (sourceFileId, versionId) is the prefix of EVERY index, so switching a file
//     to another version is an indexed lookup rather than a scan of the annotation store;
//   * the import receipt — its idempotency key (sourceKind, sourceFileId, versionId, digest) is a
//     UNIQUE index, so a repeated import is refused by the database itself and not only by the caller
//     remembering to check first. Nothing links a receipt to an annotation, because clearing one must
//     never clear the other.
const PDF_ANNOTATION_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "PdfAnnotation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceFileId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "selectorJson" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)`
const PDF_ANNOTATION_IMPORT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "PdfAnnotationImport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceKind" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "digest" TEXT NOT NULL
)`
const PDF_ANNOTATION_INDEX_DDLS = [
  // Both annotation indexes start with (sourceFileId, versionId): the version-switch read, and the
  // same read filtered by kind, both resolve without touching another version's rows.
  `CREATE INDEX IF NOT EXISTS "PdfAnnotation_sourceFileId_versionId_createdAt_idx" ON "PdfAnnotation"("sourceFileId", "versionId", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "PdfAnnotation_sourceFileId_versionId_kind_idx" ON "PdfAnnotation"("sourceFileId", "versionId", "kind")`,
  `CREATE INDEX IF NOT EXISTS "PdfAnnotationImport_sourceFileId_versionId_importedAt_idx" ON "PdfAnnotationImport"("sourceFileId", "versionId", "importedAt")`,
  // The idempotency key, enforced by the database rather than by the import path remembering to look.
  `CREATE UNIQUE INDEX IF NOT EXISTS "PdfAnnotationImport_sourceKind_sourceFileId_versionId_digest_key" ON "PdfAnnotationImport"("sourceKind", "sourceFileId", "versionId", "digest")`
]

// Indexes for ComputeJob: by providerId (per-host poller queries), sessionId (UI list), status
// (finding non-terminal jobs on restart). IF NOT EXISTS makes re-runs idempotent.
const COMPUTE_JOB_PROVIDER_INDEX_DDL = `CREATE INDEX IF NOT EXISTS "ComputeJob_providerId_idx" ON "ComputeJob"("providerId")`
const COMPUTE_JOB_SESSION_INDEX_DDL = `CREATE INDEX IF NOT EXISTS "ComputeJob_sessionId_idx" ON "ComputeJob"("sessionId")`
const COMPUTE_JOB_STATUS_INDEX_DDL = `CREATE INDEX IF NOT EXISTS "ComputeJob_status_idx" ON "ComputeJob"("status")`

// Builds a client bound to the SQLite file under the given storage root. Not a singleton, so tests can
// point separate clients at temp directories. Backslashes are normalized so the file: URL is valid on
// Windows (Prisma's SQLite connector expects forward slashes).
const createProjectDbClient = (storageRoot: string): PrismaClient => {
  const dbPath = join(storageRoot, PROJECT_DB_FILE).replace(/\\/g, '/')

  return new PrismaClient({
    datasources: {
      db: { url: `file:${dbPath}?connection_limit=${PROJECT_DB_CONNECTION_LIMIT}` }
    }
  })
}

type SqliteTableColumn = { name: string }

const quoteSqliteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`

const hasTableColumn = async (
  client: PrismaClient,
  tableName: string,
  columnName: string
): Promise<boolean> => {
  const columns = await client.$queryRawUnsafe<SqliteTableColumn[]>(
    `PRAGMA table_info(${quoteSqliteIdentifier(tableName)})`
  )
  return columns.some((column) => column.name === columnName)
}

const hasTable = async (client: PrismaClient, tableName: string): Promise<boolean> => {
  const tables = await client.$queryRawUnsafe<{ name: string }[]>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${quoteSqliteIdentifier(tableName)}`
  )
  return tables.length > 0
}

// SQLite does not support ALTER TABLE ... ADD COLUMN IF NOT EXISTS. Prove the desired postcondition
// instead of interpreting an engine-specific error string: a failed ALTER is ignored only when a
// second schema read confirms that another initializer added the exact column concurrently. A
// missing table is skipped entirely — degraded/minimal databases (older stores, partial test
// fixtures) simply do not have this table yet, and their schema is created by the DDL above.
const addColumnIfMissing = async (
  client: PrismaClient,
  tableName: string,
  columnName: string,
  ddl: string
): Promise<void> => {
  if (!(await hasTable(client, tableName))) return
  if (await hasTableColumn(client, tableName, columnName)) return

  try {
    await client.$executeRawUnsafe(ddl)
  } catch (error) {
    if (await hasTableColumn(client, tableName, columnName)) return
    throw error
  }
}

// The schema as ordered data, not as an ordered sequence of awaited calls.
//
// Why this is a list: a launch on an existing database re-ran ~180 statements so that each one could
// answer "already there" (measured on a copy of a 255 MB live database: `ensureProjectSchema` cost
// p50 120.7 ms / p90 174.7 ms per launch, `docs/bench-runs/2026-10-25-project-db-open.txt`). The list
// exists so the same data can also produce a fingerprint: apply it, record the fingerprint in SQLite's
// own `user_version`, and skip the whole thing when the file already matches. A hand-maintained version
// number would drift the first time someone adds a step and forgets; a fingerprint of the steps cannot.
type ProjectSchemaStep =
  | { readonly kind: 'sql'; readonly sql: string }
  | {
      readonly kind: 'column'
      readonly table: string
      readonly column: string
      readonly ddl: string
    }
  | { readonly kind: 'checks' }

const column = (table: string, columnName: string, ddl: string): ProjectSchemaStep => ({
  kind: 'column',
  table,
  column: columnName,
  ddl
})

const sql = (...statements: readonly string[]): readonly ProjectSchemaStep[] =>
  statements.map((statement) => ({ kind: 'sql', sql: statement }))

// Two facts have to hold for the fast path, and `PRAGMA user_version` alone can only hold one of them:
//   * the DDL this build would apply is the DDL that was applied (a fingerprint of the steps below);
//   * nothing has changed the schema since (SQLite's own `schema_version`, which bumps on ANY DDL — including
//     a table rewritten by another process, a restored file, or an older build).
// Recording only the fingerprint would let a file mutated behind the app's back pass as current; recording
// both keeps the promise "after this call the schema is correct" without paying for 180 statements.
const SCHEMA_STAMP_TABLE_DDL = `CREATE TABLE IF NOT EXISTS "SchemaStamp" (
    "id" INTEGER NOT NULL PRIMARY KEY CHECK ("id" = 1),
    "ddlFingerprint" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL
);`

const PROJECT_SCHEMA_STEPS: readonly ProjectSchemaStep[] = [
  ...sql(SCHEMA_STAMP_TABLE_DDL),
  ...sql(PROJECT_TABLE_DDL),
  column('Project', 'archivedAt', PROJECT_ADD_ARCHIVED_AT_DDL),
  ...sql(PERMISSION_GRANT_TABLE_DDL, ...PERMISSION_GRANT_INDEX_DDLS),
  ...sql(PREVIEW_STATE_TABLE_DDL),
  ...sql(UNREAD_TASK_SESSION_TABLE_DDL, UNREAD_TASK_SESSION_SESSION_ID_INDEX_DDL),
  ...sql(NOTIFICATION_INBOX_ITEM_TABLE_DDL, ...NOTIFICATION_INBOX_ITEM_INDEX_DDLS),
  ...sql(REVIEW_TABLE_DDL, FINDING_TABLE_DDL),
  // Old databases carry `severity` / `reasoning` instead of these columns; each guarded add proves the
  // postcondition rather than trusting an engine error string.
  column('Finding', 'status', FINDING_ADD_STATUS_COLUMN_DDL),
  column('Review', 'reviewerLog', REVIEW_ADD_REVIEWER_LOG_DDL),
  column('Finding', 'reflagCount', FINDING_ADD_REFLAG_COUNT_DDL),
  column('Finding', 'artifactBindingState', FINDING_ADD_ARTIFACT_BINDING_STATE_DDL),
  ...sql(PROJECT_DELETION_INTENT_TABLE_DDL),
  ...sql(MANAGED_FILE_TABLE_DDL),
  column('ManagedFile', 'sourceVersionId', MANAGED_FILE_ADD_SOURCE_VERSION_ID_DDL),
  column('ManagedFile', 'checksum', MANAGED_FILE_ADD_CHECKSUM_DDL),
  column('ArtifactVersion', 'stateReason', ARTIFACT_VERSION_ADD_STATE_REASON_DDL),
  ...sql(MANAGED_FILE_SESSION_SYNC_TABLE_DDL, ...MANAGED_FILE_INDEX_DDLS),
  ...sql(
    FILE_ORIGIN_SESSION_TABLE_DDL,
    ARTIFACT_LINEAGE_TABLE_DDL,
    UPLOAD_FILE_TABLE_DDL,
    UPLOAD_VERSION_TABLE_DDL,
    ARTIFACT_MESSAGE_SNAPSHOT_TABLE_DDL
  ),
  column('ArtifactMessageSnapshot', 'checksum', ARTIFACT_MESSAGE_SNAPSHOT_ADD_CHECKSUM_DDL),
  ...sql(ARTIFACT_VERSION_TABLE_DDL),
  column('ArtifactVersion', 'filename', ARTIFACT_VERSION_ADD_FILENAME_DDL),
  // Backfill: rows written before `filename` existed take it from their lineage. Runs after the column
  // exists, which is why the steps below are ordered rather than grouped.
  ...sql(
    `UPDATE "ArtifactVersion" SET "filename" = (SELECT "filename" FROM "ArtifactLineage" WHERE "ArtifactLineage"."id" = "ArtifactVersion"."artifactId") WHERE "filename" IS NULL OR "filename" = ''`
  ),
  ...sql(
    ARTIFACT_VERSION_INPUT_TABLE_DDL,
    REVIEW_FINDING_DISPOSITION_TABLE_DDL,
    REVIEW_SCOPE_SNAPSHOT_TABLE_DDL,
    REVIEW_EVIDENCE_TABLE_DDL,
    REVIEW_EVIDENCE_REVIEW_ID_INDEX_DDL,
    REVIEW_SESSION_ID_INDEX_DDL,
    FINDING_REVIEW_ID_SORT_INDEX_DDL,
    BACKGROUND_DELIVERY_TABLE_DDL,
    ...BACKGROUND_DELIVERY_INDEX_DDLS
  ),
  // Rebuilds a table when a CHECK constraint in an older file does not match the canonical DDL.
  { kind: 'checks' },
  ...sql(...ARTIFACT_PROVENANCE_INDEX_DDLS),
  ...sql(COMPUTE_HOST_TABLE_DDL, COMPUTE_HOST_PROVIDER_ID_INDEX_DDL),
  column('ComputeHost', 'executionMode', COMPUTE_HOST_ADD_EXECUTION_MODE_DDL),
  ...sql(
    COMPUTE_JOB_TABLE_DDL,
    COMPUTE_JOB_PROVIDER_INDEX_DDL,
    COMPUTE_JOB_SESSION_INDEX_DDL,
    COMPUTE_JOB_STATUS_INDEX_DDL
  ),
  // Compute-job columns added after the table shipped: all nullable, so existing rows are untouched.
  column('ComputeJob', 'lastPollError', COMPUTE_JOB_ADD_LAST_POLL_ERROR_DDL),
  column('ComputeJob', 'harvestError', COMPUTE_JOB_ADD_HARVEST_ERROR_DDL),
  column('ComputeJob', 'leftOnRemote', COMPUTE_JOB_ADD_LEFT_ON_REMOTE_DDL),
  column('ComputeJob', 'notifiedAt', COMPUTE_JOB_ADD_NOTIFIED_AT_DDL),
  column('ComputeJob', 'executionProtection', COMPUTE_JOB_ADD_EXECUTION_PROTECTION_DDL),
  column('Reference', 'pdfContentHash', REFERENCE_ADD_PDF_CONTENT_HASH_DDL),
  column('ComputeJob', 'notificationConsumedAt', COMPUTE_JOB_ADD_NOTIFICATION_CONSUMED_AT_DDL),
  ...sql(VISION_EVIDENCE_TABLE_DDL, ...VISION_EVIDENCE_INDEX_DDLS),
  ...sql(REFERENCE_TABLE_DDL),
  // DOI integrity columns for databases created before they existed. Ordered after the table DDL: a
  // step that runs before its table exists is skipped, which is how the first version of this failed.
  column('Reference', 'integrityStatus', REFERENCE_ADD_INTEGRITY_STATUS_DDL),
  column('Reference', 'integrityCheckedAt', REFERENCE_ADD_INTEGRITY_CHECKED_AT_DDL),
  column('Reference', 'integritySourceUrl', REFERENCE_ADD_INTEGRITY_SOURCE_URL_DDL),
  column('Reference', 'integrityNoticesJson', REFERENCE_ADD_INTEGRITY_NOTICES_DDL),
  column('Reference', 'integrityEvidence', REFERENCE_ADD_INTEGRITY_EVIDENCE_DDL),
  column('Reference', 'readingStatus', REFERENCE_ADD_READING_STATUS_DDL),
  column('Reference', 'readingStatusUpdatedAt', REFERENCE_ADD_READING_STATUS_AT_DDL),
  // Citation-style layer: bibliographic columns on Reference for existing databases.
  column('Reference', 'volume', REFERENCE_ADD_VOLUME_DDL),
  column('Reference', 'issue', REFERENCE_ADD_ISSUE_DDL),
  column('Reference', 'pages', REFERENCE_ADD_PAGES_DDL),
  column('Reference', 'publisher', REFERENCE_ADD_PUBLISHER_DDL),
  column('Reference', 'itemType', REFERENCE_ADD_ITEM_TYPE_DDL),
  column('Reference', 'citedAt', REFERENCE_ADD_CITED_AT_DDL),
  column('Reference', 'citedSessionId', REFERENCE_ADD_CITED_SESSION_ID_DDL),
  ...sql(CITATION_STYLE_TABLE_DDL),
  column('CitationStyle', 'fidelity', CITATION_STYLE_ADD_FIDELITY_DDL),
  column('CitationStyle', 'fidelityNotesJson', CITATION_STYLE_ADD_FIDELITY_NOTES_DDL),
  ...sql(
    CITATION_STYLE_UNIQUE_STYLE_ID_DDL,
    CITATION_STYLE_IMPORTED_AT_INDEX_DDL,
    REFERENCE_UNIQUE_PROJECT_CITATION_KEY_DDL,
    ...REFERENCE_INDEX_DDLS,
    REFERENCE_COLLECTION_TABLE_DDL,
    REFERENCE_ATTACHMENT_VERSION_TABLE_DDL,
    ...REFERENCE_ATTACHMENT_VERSION_INDEX_DDLS,
    REFERENCE_COLLECTION_UNIQUE_PROJECT_NAME_DDL,
    REFERENCE_COLLECTION_PROJECT_INDEX_DDL,
    COLLECTION_ITEM_TABLE_DDL,
    COLLECTION_ITEM_UNIQUE_COLLECTION_REFERENCE_DDL,
    COLLECTION_ITEM_REFERENCE_INDEX_DDL
  ),
  // Literature screening: revisions, AI verdicts, human overrides, and the run/item ledger.
  ...sql(
    SCREENING_RULE_REVISION_TABLE_DDL,
    SCREENING_ASSESSMENT_TABLE_DDL,
    SCREENING_OVERRIDE_TABLE_DDL,
    SCREENING_RUN_TABLE_DDL,
    SCREENING_RUN_ITEM_TABLE_DDL,
    ...SCREENING_INDEX_DDLS
  ),
  // PDF annotations: the annotations and the import receipt ledger, deliberately unlinked.
  ...sql(PDF_ANNOTATION_TABLE_DDL, PDF_ANNOTATION_IMPORT_TABLE_DDL, ...PDF_ANNOTATION_INDEX_DDLS),
  ...sql(
    JOURNAL_TABLE_DDL,
    JOURNAL_METRIC_TABLE_DDL,
    JOURNAL_ALIAS_TABLE_DDL,
    ...JOURNAL_INDEX_DDLS,
    ...JOURNAL_ALIAS_INDEX_DDLS
  ),
  column('Journal', 'displayName', `ALTER TABLE "Journal" ADD COLUMN "displayName" TEXT`),
  column('Reference', 'journalId', `ALTER TABLE "Reference" ADD COLUMN "journalId" TEXT`),
  column('Reference', 'journalMatch', `ALTER TABLE "Reference" ADD COLUMN "journalMatch" TEXT`),
  ...sql(REFERENCE_JOURNAL_ID_INDEX_DDL)
]

// Derived, never hand-written: any change to a statement, a guarded column, or a CHECK migration
// changes this value, so the recorded fingerprint cannot claim a schema the steps no longer produce.
// 31 bits because `PRAGMA user_version` is a signed 32-bit integer.
const PROJECT_SCHEMA_FINGERPRINT: number = (() => {
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        steps: PROJECT_SCHEMA_STEPS,
        checks: PROVENANCE_CHECK_CONSTRAINT_MIGRATIONS
      })
    )
    .digest()
  return hash.readUInt32BE(0) & 0x7fffffff
})()

type SchemaStamp = { ddlFingerprint: number; schemaVersion: number }

const toNumber = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : undefined

const readSchemaVersion = async (client: PrismaClient): Promise<number | undefined> => {
  const rows =
    await client.$queryRawUnsafe<Array<{ schema_version: number }>>('PRAGMA schema_version')
  return toNumber(rows[0]?.schema_version)
}

// Absent (a fresh file, or one written before the stamp existed) is `undefined`, not a zero: the caller
// must not be able to read "no stamp" as "matches".
const readSchemaStamp = async (client: PrismaClient): Promise<SchemaStamp | undefined> => {
  try {
    const rows = await client.$queryRawUnsafe<
      Array<{ ddlFingerprint: unknown; schemaVersion: unknown }>
    >('SELECT "ddlFingerprint", "schemaVersion" FROM "SchemaStamp" WHERE "id" = 1')
    const ddlFingerprint = toNumber(rows[0]?.ddlFingerprint)
    const schemaVersion = toNumber(rows[0]?.schemaVersion)
    return ddlFingerprint === undefined || schemaVersion === undefined
      ? undefined
      : { ddlFingerprint, schemaVersion }
  } catch {
    // No SchemaStamp table yet: the first run of this build on this file.
    return undefined
  }
}

const writeSchemaStamp = async (client: PrismaClient, schemaVersion: number): Promise<void> => {
  await client.$executeRawUnsafe(
    `INSERT INTO "SchemaStamp" ("id", "ddlFingerprint", "schemaVersion") VALUES (1, ${PROJECT_SCHEMA_FINGERPRINT}, ${schemaVersion}) ON CONFLICT("id") DO UPDATE SET "ddlFingerprint" = ${PROJECT_SCHEMA_FINGERPRINT}, "schemaVersion" = ${schemaVersion}`
  )
}

const applySchemaStep = async (client: PrismaClient, step: ProjectSchemaStep): Promise<void> => {
  if (step.kind === 'sql') {
    await client.$executeRawUnsafe(step.sql)
    return
  }
  if (step.kind === 'checks') {
    await ensureSqliteCheckConstraints(client, PROVENANCE_CHECK_CONSTRAINT_MIGRATIONS)
    return
  }
  await addColumnIfMissing(client, step.table, step.column, step.ddl)
}

// Creates the schema if missing. Idempotent; no projects are seeded, so a fresh install starts empty.
//
// The fast path is the point: `journal_mode` is a FILE property and `busy_timeout` a connection property,
// so both still run on every launch, then one `PRAGMA user_version` read decides whether the other ~180
// statements have anything to do. A file whose fingerprint does not match (fresh, older, or written by a
// build with different DDL) runs the full sequence and records the fingerprint afterwards — so an
// interrupted upgrade simply re-runs it.
const ensureProjectSchema = async (client: PrismaClient): Promise<void> => {
  // P0-10③ first step. `journal_mode` is a FILE-level property (unlike `foreign_keys`, which is
  // connection-scoped), so setting it here covers every later connection to this database. WAL stops a
  // writer's journal lock from blocking readers — which is exactly the shape of the slow `SELECT 1` canary
  // (median 47 ms, p90 346 ms with an idle event loop) — and `busy_timeout` keeps a brief lock from failing a
  // query outright. Both go through `$queryRawUnsafe`: PRAGMA statements return a row, which `$executeRaw`
  // rejects. The single-connection limit is NOT relaxed here: the runtime constraint migration still needs
  // its `foreign_keys = OFF` and its rebuild transaction on one physical connection.
  // Design and acceptance readings: docs/evidence/2026-10-11-single-connection-read-pool-design.md
  await client.$queryRawUnsafe('PRAGMA journal_mode = WAL')
  await client.$queryRawUnsafe(`PRAGMA busy_timeout = ${PROJECT_DB_BUSY_TIMEOUT_MS}`)

  const stamp = await readSchemaStamp(client)
  if (
    stamp &&
    stamp.ddlFingerprint === PROJECT_SCHEMA_FINGERPRINT &&
    stamp.schemaVersion === (await readSchemaVersion(client))
  ) {
    return
  }

  for (const step of PROJECT_SCHEMA_STEPS) {
    await applySchemaStep(client, step)
  }

  // Read the version AFTER the sequence: creating the stamp table (or rebuilding one for a CHECK
  // constraint) bumps it, and the stamp has to describe the file as it is now.
  const schemaVersion = await readSchemaVersion(client)
  if (schemaVersion === undefined) {
    throw new Error('SQLite did not report a schema_version after applying the project schema.')
  }
  await writeSchemaStamp(client, schemaVersion)
}

let clientPromise: Promise<PrismaClient> | undefined
// Latched once the quit path has released the query engine. Creating a new client afterwards would
// re-open the exact native state the release exists to remove (see releaseProjectDbForShutdown).
let releasedForShutdown = false

/**
 * Thrown when a project-database read arrives after the quit path released the engine. Named rather
 * than silent: work still running during teardown is a defect worth seeing, and reconnecting would
 * restore the native state the release removes.
 */
export class ProjectDbReleasedError extends Error {
  readonly name = 'ProjectDbReleasedError'

  constructor() {
    super('The project database was released for application shutdown.')
  }
}

// Production singleton: ensures the storage dir exists, connects, and applies the schema.
const getProjectDbClient = (storageRoot: string): Promise<PrismaClient> => {
  if (releasedForShutdown) return Promise.reject(new ProjectDbReleasedError())

  if (!clientPromise) {
    const pending = (async () => {
      await mkdir(storageRoot, { recursive: true })

      const client = createProjectDbClient(storageRoot)

      try {
        await ensureProjectSchema(client)
      } catch (error) {
        // Release the connection / query-engine this client opened before the retry cache is cleared,
        // so repeated init failures don't leak a PrismaClient (and its engine subprocess) per attempt.
        await client.$disconnect().catch(() => undefined)
        throw error
      }

      return client
    })()

    clientPromise = pending

    // Do not cache a failed initialization: a transient error (locked db, unwritable dir) would otherwise
    // disable projects for the entire app session. Clearing the cache lets the next call retry. Attaching
    // this handler also keeps an early rejection from becoming an unhandled rejection that could crash the
    // main process at startup — real awaiters still observe it (surfaced via the renderer project store).
    pending.catch(() => {
      if (clientPromise === pending) clientPromise = undefined
    })
  }

  return clientPromise
}

// Releases the process-wide authority-store connection before operations that require an exclusive
// SQLite checkpoint. The next repository read lazily creates a fresh client.
const disconnectProjectDbClient = async (): Promise<void> => {
  const pending = clientPromise
  if (!pending) return

  clientPromise = undefined
  const client = await pending.catch(() => undefined)
  await client?.$disconnect()
}

/** Outcome vocabulary for the quit-path release; each state is named so a log line is unambiguous. */
export type ProjectDbReleaseOutcome =
  | { released: true; reason: 'no-client' | 'never-connected' | 'disconnected' }
  | { released: false; reason: 'timeout' | 'failed' }

// How long the quit path waits for the engine to close before giving up on it. The engine has no
// outstanding work by this point (backend teardown already ran), so this is a stall guard, not a
// work budget.
const PROJECT_DB_RELEASE_TIMEOUT_MS = 3000

/**
 * Releases the Prisma query engine for application shutdown (v2.0.0 P0-1).
 *
 * Real evidence, 2026-10-10: a packaged 1.97.0 run aborted (SIGABRT) about five seconds AFTER every
 * shutdown phase had reported `completed`. The faulting stack is `abort()` inside
 * `libquery_engine-darwin-arm64.dylib.node`, reached from `uv_run` → `node::Environment::CleanupHandles()`
 * → `node::Environment::RunCleanup()` → `node::FreeEnvironment()`: the engine's pending thread-pool work
 * resumed while Node was already tearing the environment down. Nothing in the quit path ever called
 * `$disconnect()` (it appeared only in tests), so the engine was always still open at teardown.
 *
 * This closes it explicitly, bounded so a wedged engine cannot hang quit, and latches so nothing can
 * reconnect behind it. Bounded on purpose: an unclosed engine is worse than a slow exit, so the caller
 * reports the timeout instead of pretending the release happened.
 */
const releaseProjectDbForShutdown = async (
  timeoutMs: number = PROJECT_DB_RELEASE_TIMEOUT_MS
): Promise<ProjectDbReleaseOutcome> => {
  releasedForShutdown = true

  const pending = clientPromise
  if (!pending) return { released: true, reason: 'no-client' }

  clientPromise = undefined
  const client = await pending.catch(() => undefined)
  if (!client) return { released: true, reason: 'never-connected' }

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
    timer.unref?.()
  })
  const closing = client
    .$disconnect()
    .then((): 'disconnected' | 'failed' => 'disconnected')
    .catch((): 'disconnected' | 'failed' => 'failed')

  const result = await Promise.race([closing, deadline])
  if (timer) clearTimeout(timer)

  if (result === 'timeout') return { released: false, reason: 'timeout' }
  if (result === 'failed') return { released: false, reason: 'failed' }
  return { released: true, reason: 'disconnected' }
}

/** True once the quit path released the engine; later clients are refused by name. */
const isProjectDbReleased = (): boolean => releasedForShutdown

export {
  PROJECT_SCHEMA_FINGERPRINT,
  createProjectDbClient,
  disconnectProjectDbClient,
  ensureProjectSchema,
  getProjectDbClient,
  isProjectDbReleased,
  releaseProjectDbForShutdown
}
