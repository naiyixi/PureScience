// Catalog of user-facing error messages produced by the main-process remote
// access layer (src/main/remote-access/*). The main process composes these in
// English; the renderer maps the exact message back to a dictionary key so the
// UI can show them in the active interface language. Unknown/unmapped messages
// (e.g. low-level OS errors) pass through unchanged.
export const REMOTE_ERROR_KEYS: Record<string, string> = {
  'Administrator approval was cancelled or Remote.It could not complete the command.':
    'remoteError.approvalCancelled',
  'Administrator approval was cancelled or Remote.It could not complete the commands.':
    'remoteError.approvalCancelledPlural',
  'Provider route kept configured while local remote access is disabled':
    'remoteError.routeKeptWhileDisabled',
  'Remote access disabled locally': 'remoteError.disabledLocally',
  'Remote access is not initialized yet.': 'remoteError.notInitialized',
  'Remote access returned an invalid HTTPS browser URL.': 'remoteError.invalidHttpsBrowserUrl',
  'Remote access returned an invalid browser URL.': 'remoteError.invalidBrowserUrl',
  'Remote.It could not create the PureScience service. On macOS or Linux, service management may require administrator approval.':
    'remoteError.couldNotCreateService',
  'Remote.It could not disable the service public endpoint.':
    'remoteError.couldNotDisablePublicEndpoint',
  'Remote.It could not enable the Persistent Public URL for PureScience.':
    'remoteError.couldNotEnablePersistentUrl',
  'Remote.It could not identify existing Windows services, so PureScience stopped before creating duplicates.':
    'remoteError.windowsServicesUnclear',
  'Remote.It could not prepare the App and Browser services. On macOS or Linux, initial service management may require administrator approval.':
    'remoteError.couldNotPrepareServices',
  'Remote.It could not update the PureScience service. On macOS or Linux, service management may require administrator approval.':
    'remoteError.couldNotUpdateService',
  'Remote.It created the PureScience service but it is not enabled.':
    'remoteError.createdButNotEnabled',
  'Remote.It created the service but did not report its identifier.':
    'remoteError.createdNoIdentifier',
  'Remote.It did not disable the service public endpoint.':
    'remoteError.didNotDisablePublicEndpoint',
  'Remote.It did not enable a Persistent Public URL for PureScience.':
    'remoteError.didNotEnablePersistentUrl',
  'Remote.It did not return cloud configuration data.': 'remoteError.noCloudConfig',
  'Remote.It did not return two distinct PureScience service identifiers.':
    'remoteError.noTwoServiceIdentifiers',
  'Remote.It has not finished switching its background service mode. Wait a few seconds, then click Detect again. Do not add the device again.':
    'remoteError.notFinishedSwitchingMode',
  'Remote.It is still switching its background service mode. Wait a few seconds, then click Detect again. Do not add the device again.':
    'remoteError.stillSwitchingMode',
  'Remote.It rejected the cloud configuration request.': 'remoteError.rejectedCloudConfig',
  'Remote.It reported an error.': 'remoteError.reportedError',
  'Remote.It returned an invalid service identifier.': 'remoteError.invalidServiceIdentifier',
  'Remote.It returned incomplete results while preparing remote access.':
    'remoteError.incompletePreparation',
  'Remote.It returned invalid cloud configuration data.': 'remoteError.invalidCloudConfigData',
  'Remote.It returned invalid status data.': 'remoteError.invalidStatusData',
  'Remote.It status has not reported all accepted service changes yet.':
    'remoteError.statusChangesPending',
  'Remote.It status is temporarily unavailable.': 'remoteError.statusUnavailable',
  'The local web service stopped. Detect again to restore remote access.':
    'remoteError.localWebStopped',
  'The remote access app is not installed. Install the desktop app, sign in, then detect again.':
    'remoteError.appNotInstalled',
  'The remote access app is unavailable.': 'remoteError.appUnavailable',
  'Unable to read Remote.It status.': 'remoteError.unableReadStatus'
}

export const localizeRemoteMessage = (translator: unknown, message: string): string => {
  const key = REMOTE_ERROR_KEYS[message]
  if (!key) return message
  return (translator as (key: string) => string)(key)
}
