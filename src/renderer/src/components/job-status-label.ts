import type { ComputeJobStatus } from '../../../shared/compute'
import type { Translate } from '@/i18n'

// One place that decides what a job status is CALLED. The wording used to be English literals inside two
// components ('finished', 'failed', 'timed out'), so a reader running the app in Chinese, Japanese or
// German saw the English word in the conversation card and in the detail header while every neighbouring
// label was translated. Colours and emphasis stay in the components; the words come from here.
//
// `submitted` deliberately shares queued's wording: both mean "the scheduler has it and nothing runs yet",
// and two different sentences there would invent a distinction the reader cannot act on.
export const JOB_STATUS_I18N_KEYS: Record<ComputeJobStatus, Parameters<Translate>[0]> = {
  queued: 'jobStatus.queued',
  submitted: 'jobStatus.queued',
  running: 'jobStatus.running',
  success: 'jobStatus.success',
  failed: 'jobStatus.failed',
  timeout: 'jobStatus.timeout',
  error: 'jobStatus.error',
  cancelled: 'jobStatus.cancelled'
}

// A row written by an older build can carry a status outside today's union (the repository normalises on
// read, but the renderer is handed whatever the bridge sent). Say the raw value rather than an empty
// space — and never call t(undefined), which throws inside render.
export const jobStatusLabel = (status: ComputeJobStatus, t: Translate): string => {
  const key = JOB_STATUS_I18N_KEYS[status] as Parameters<Translate>[0] | undefined
  return key ? t(key) : status
}
