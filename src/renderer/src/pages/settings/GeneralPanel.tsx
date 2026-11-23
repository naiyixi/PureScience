import { useLanguage, type Language } from '@/i18n'
import { LANGUAGES } from '@/i18n/languages'
import { ExternalLink, FolderOpen, Globe, PackageOpen, Terminal } from 'lucide-react'
import { useEffect, useState } from 'react'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import { ThemeSegmentedControl } from '@/components/ThemeControls'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useSettingsStore } from '@/stores/settings-store'
import type { CloseActionPreference } from '../../../../shared/window-controls'
import type { CliLauncherStatus } from '../../../../shared/cli'
import { APP } from '../../../../shared/app-config'
import { formatBytes } from '../../../../shared/update'
import { AppIconSection } from './AppIconSection'
import { AppVersionSection } from './AppVersionSection'
import { SettingsRow, SettingsSection, SettingsToggle } from './SettingsLayout'

// Community entry links (Discord, X) share the GitHub badge's compact look so the row reads as one
// set of "connect with the project" actions.
const socialLinkClassName =
  'inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2 text-xs font-medium text-muted-foreground transition-colors duration-150 motion-reduce:transition-none hover:bg-muted hover:text-foreground'

// Discord and X are brand marks that lucide-react dropped in v1, so we inline the official SVGs.
// currentColor lets them inherit the link's text color like the other icons.
// General app settings. Hosts the Diagnostics (log file) tools and the the single product-site link. The log
// file stays on this device and is never transmitted by the app.
const GeneralPanel = (): React.JSX.Element => {
  const { t, lang, preference, setLang } = useLanguage()
  // 导出署名与许可：主进程存的就是这两栏，导出 RO-Crate 时逐字写进 author / license。
  const exportAuthor = useSettingsStore((state) => state.exportAuthor)
  const exportLicense = useSettingsStore((state) => state.exportLicense)
  const exportAuthorKind = useSettingsStore((state) => state.exportAuthorKind)
  const exportAffiliation = useSettingsStore((state) => state.exportAffiliation)
  const setExportAuthor = useSettingsStore((state) => state.setExportAuthor)
  const setExportAffiliation = useSettingsStore((state) => state.setExportAffiliation)
  const setExportAuthorKind = useSettingsStore((state) => state.setExportAuthorKind)
  const setExportLicense = useSettingsStore((state) => state.setExportLicense)
  const isMac = window.api.platform === 'darwin'
  const [logPath, setLogPath] = useState<string | null>(null)
  const [message, setMessage] = useState<string | undefined>(undefined)
  // Kept apart from `message`: a saved bundle is not a problem, and `message` renders as an alert.
  const [bundleMessage, setBundleMessage] = useState<string | undefined>(undefined)
  const [isExporting, setIsExporting] = useState(false)
  const [isOpening, setIsOpening] = useState(false)
  const [cli, setCli] = useState<CliLauncherStatus | null>(null)
  const [isUpdatingCli, setIsUpdatingCli] = useState(false)
  const [cliError, setCliError] = useState<string | undefined>(undefined)
  const notificationsEnabled = useSettingsStore((state) => state.notificationsEnabled)
  const setNotificationsEnabled = useSettingsStore((state) => state.setNotificationsEnabled)
  const useIntent = useSettingsStore((state) => state.useIntent)
  const setUseIntent = useSettingsStore((state) => state.setUseIntent)
  const closePreference = useSettingsStore((state) => state.closePreference)
  const setClosePreference = useSettingsStore((state) => state.setClosePreference)

  useEffect(() => {
    void window.api.logs.getPath().then(setLogPath)
    void window.api.cli.getStatus().then(setCli)
  }, [])

  const handleCli = async (action: 'install' | 'uninstall'): Promise<void> => {
    setIsUpdatingCli(true)
    setCliError(undefined)

    try {
      setCli(
        action === 'install' ? await window.api.cli.install() : await window.api.cli.uninstall()
      )
    } catch (error) {
      setCliError(error instanceof Error ? error.message : t('settings.couldNotUpdateCliTool'))
    } finally {
      setIsUpdatingCli(false)
    }
  }

  const handleOpenLog = async (): Promise<void> => {
    setIsOpening(true)
    setMessage(undefined)

    try {
      const result = await window.api.logs.openFile()

      if (!result.opened) {
        setMessage(result.error ?? t('settings.couldNotOpenLogFile'))
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('settings.couldNotOpenLogFile'))
    } finally {
      setIsOpening(false)
    }
  }

  // Assembles the bundle locally, after the user picks where it goes. A cancelled dialog leaves the panel
  // untouched: the user asked for nothing and should see nothing change.
  const handleExportBundle = async (): Promise<void> => {
    setIsExporting(true)
    setBundleMessage(undefined)

    try {
      const result = await window.api.diagnostics?.exportSupportBundle()

      if (result?.exported && result.path) {
        // The main process already reports what it wrote and how much it stripped; showing only the path made
        // the user open the file to learn either. Both numbers are optional on the result, so the message
        // degrades to the path when a build does not report them.
        const detail =
          typeof result.bytes === 'number' && typeof result.redactions === 'number'
            ? ` — ${t('settings.supportBundleDetail')
                .replace('{size}', formatBytes(result.bytes, lang))
                .replace('{redactions}', String(result.redactions))}`
            : ''
        setBundleMessage(t('settings.supportBundleSaved').replace('{path}', result.path) + detail)
      } else if (result?.error) {
        setMessage(result.error)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('settings.couldNotExportSupportBundle'))
    } finally {
      setIsExporting(false)
    }
  }

  const handleReveal = async (): Promise<void> => {
    setMessage(undefined)

    try {
      const result = await window.api.logs.revealInFolder()

      if (!result.revealed) {
        setMessage(result.error ?? t('settings.couldNotRevealLogFile'))
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('settings.couldNotRevealLogFile'))
    }
  }

  return (
    <div className="space-y-5 p-5">
      <AppVersionSection />

      {/* 导出署名与许可。留空就真的不写 —— 界面上写清楚这一点，免得用户以为留空会「自动填上」。 */}
      <SettingsSection
        title={t('settings.exportAttributionTitle')}
        description={t('settings.exportAttributionIntro')}
        aria-label={t('settings.exportAttributionTitle')}
        separated
      >
        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-foreground">
              {t('settings.exportAuthorLabel')}
            </span>
            <Input
              value={exportAuthor}
              placeholder={t('settings.exportAuthorPlaceholder')}
              onChange={(event) => void setExportAuthor(event.target.value)}
            />
          </label>
          {/* 机构与署名分开两栏：导出里它是独立的 Organization 实体，拼进署名就再也拆不开了。 */}
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-foreground">
              {t('settings.exportAffiliationLabel')}
            </span>
            <Input
              value={exportAffiliation}
              placeholder={t('settings.exportAffiliationPlaceholder')}
              onChange={(event) => void setExportAffiliation(event.target.value)}
            />
            {/* 署名类型是「机构」时，这一栏的含义变了：这个机构属于哪个上级单位。
                不提示的话，用户会把自己单位再填一遍，导出里就多出一个没有意义的 Organization。 */}
            {exportAuthorKind === 'organization' ? (
              <p className="text-xs text-muted-foreground">
                {t('settings.exportAffiliationParentHint')}
              </p>
            ) : null}
          </label>
          {/* 类型只决定导出里那个实体的 @type。它不改用户写下的文字，所以不放进同一个输入框。 */}
          <div className="space-y-1.5">
            <span className="text-sm font-medium text-foreground">
              {t('settings.exportAuthorKindLabel')}
            </span>
            <Select
              value={exportAuthorKind}
              onValueChange={(value) =>
                void setExportAuthorKind(value as 'person' | 'organization')
              }
            >
              <SelectTrigger aria-label={t('settings.exportAuthorKindLabel')}>
                <span>
                  {exportAuthorKind === 'organization'
                    ? t('settings.exportAuthorKindOrganization')
                    : t('settings.exportAuthorKindPerson')}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="person">{t('settings.exportAuthorKindPerson')}</SelectItem>
                <SelectItem value="organization">
                  {t('settings.exportAuthorKindOrganization')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-foreground">
              {t('settings.exportLicenseLabel')}
            </span>
            <Input
              value={exportLicense}
              placeholder={t('settings.exportLicensePlaceholder')}
              onChange={(event) => void setExportLicense(event.target.value)}
            />
          </label>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('settings.licensing')}
        description={t('settings.licensingDesc')}
        aria-label={t('settings.licensing')}
        separated
      >
        <SettingsRow
          label={t('settings.useIntent')}
          description={t('settings.useIntentDesc')}
          className="pt-0"
          controlClassName="flex justify-end"
        >
          <Select
            value={useIntent ?? 'commercial'}
            onValueChange={(value) => void setUseIntent(value as 'commercial' | 'non-commercial')}
          >
            <SelectTrigger aria-label={t('settings.useIntent')}>
              <span>
                {useIntent === 'non-commercial'
                  ? t('settings.useIntentNonCommercial')
                  : t('settings.useIntentCommercial')}
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="commercial">{t('settings.useIntentCommercial')}</SelectItem>
              <SelectItem value="non-commercial">{t('settings.useIntentNonCommercial')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title={t('settings.appearance')}
        description={t('settings.appearanceDesc')}
        aria-label={t('settings.appearance')}
        separated
      >
        <SettingsRow
          label={t('common.language')}
          description={t('settings.languageDescription')}
          className="pt-0"
          controlClassName="flex justify-end"
        >
          <Select
            value={preference}
            onValueChange={(value) => setLang(value as Language | 'system')}
          >
            <SelectTrigger aria-label={t('common.language')}>
              <span>
                {preference === 'system'
                  ? t('settings.languageSystem')
                  : (LANGUAGES.find((entry) => entry.id === lang)?.label ?? lang)}
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{t('settings.languageSystem')}</SelectItem>
              {LANGUAGES.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow
          label={t('settings.theme')}
          description={isMac ? t('settings.themeHint') : t('settings.themeFallbackHint')}
          controlClassName="flex justify-end"
        >
          <ThemeSegmentedControl />
        </SettingsRow>
      </SettingsSection>

      {window.api.platform === 'win32' && window.api.window?.onCloseConfirmRequest ? (
        <SettingsSection
          title={t('settings.windowBehavior')}
          description={t('settings.windowBehaviorHint')}
          aria-label={t('settings.windowBehavior')}
          separated
        >
          <SettingsRow
            label={t('settings.whenClosingWindow')}
            description={t('settings.whenClosingWindowHint')}
            className="pt-0"
          >
            <Select
              value={closePreference ?? 'ask'}
              onValueChange={(value) =>
                void setClosePreference(
                  value === 'ask' ? undefined : (value as CloseActionPreference)
                )
              }
            >
              <SelectTrigger aria-label={t('settings.whenClosingWindow')}>
                <span>
                  {closePreference === 'minimize'
                    ? t('settings.minimizeToTray')
                    : closePreference === 'quit'
                      ? 'Quit'
                      : t('settings.askEveryTime')}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ask">{t('settings.askEveryTime')}</SelectItem>
                <SelectItem value="minimize">{t('settings.minimizeToTray')}</SelectItem>
                <SelectItem value="quit">{t('settings.quit')}</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsSection>
      ) : null}

      <SettingsSection
        title={t('settings.notifications')}
        description={<>{t('settings.notificationsDesc')}</>}
        aria-label={t('settings.notifications')}
        separated
      >
        <SettingsRow
          label={t('settings.taskNotifications')}
          description={t('settings.taskNotificationsHint')}
          className="pt-0"
        >
          <div className="flex justify-end">
            <SettingsToggle
              enabled={notificationsEnabled}
              aria-label={t('settings.toggleTaskNotifications')}
              onToggle={() => void setNotificationsEnabled(!notificationsEnabled)}
            />
          </div>
        </SettingsRow>

        <p className="mt-1 text-xs text-muted-foreground">{t('settings.taskNotificationsHint2')}</p>
      </SettingsSection>

      {/* macOS uses the adaptive build/icon.icon for the installed app and binds its live Dock icon
          to Theme. Hiding the independent picker prevents two controls from racing each other. */}
      {!isMac ? <AppIconSection /> : null}

      <SettingsSection
        title={t('settings.diagnostics')}
        description={<>{t('settings.diagnosticsDesc')}</>}
        aria-label={t('settings.diagnostics')}
        separated
      >
        <SettingsRow
          label={t('settings.logFile')}
          controlClassName="w-auto justify-self-end"
          className="pt-0"
        >
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleReveal()}
              disabled={!logPath}
            >
              <FolderOpen className="size-4" aria-hidden="true" />
              {t('settings.revealInFinder')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleOpenLog()}
              disabled={isOpening || !logPath}
            >
              <ExternalLink className="size-4" aria-hidden="true" />
              {isOpening ? t('common.opening') : t('common.open')}
            </Button>
          </div>
        </SettingsRow>

        <pre
          className="overflow-x-auto rounded-lg border border-border bg-muted/60 px-3 py-2.5 font-mono text-xs text-foreground"
          aria-label={t('generalPanel.logFilePath')}
        >
          {logPath ?? t('settings.notAvailableYet')}
        </pre>

        <SettingsRow
          label={t('settings.supportBundle')}
          description={t('settings.supportBundleDesc')}
          controlClassName="w-auto justify-self-end"
        >
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleExportBundle()}
            disabled={isExporting}
          >
            <PackageOpen className="size-4" aria-hidden="true" />
            {t('settings.exportSupportBundle')}
          </Button>
        </SettingsRow>

        {bundleMessage ? (
          <p className="mt-2 text-xs text-muted-foreground">{bundleMessage}</p>
        ) : null}

        {message ? (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {message}
          </p>
        ) : null}

        <p className="mt-3 text-xs text-muted-foreground">
          {t('settings.somethingNotWorking')}{' '}
          <ExternalTextLink href={APP.links.support}>{t('settings.openIssue')}</ExternalTextLink>{' '}
          {t('settings.shareLogHint')}
        </p>
      </SettingsSection>

      <SettingsSection
        title={t('settings.commandLineTool')}
        description={<span dangerouslySetInnerHTML={{ __html: t('settings.cliInstallHint') }} />}
        aria-label={t('settings.commandLineTool')}
        separated
      >
        <SettingsRow
          label="purescience"
          controlClassName="w-auto justify-self-end"
          className="pt-0"
        >
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleCli(cli?.installed ? 'uninstall' : 'install')}
            disabled={isUpdatingCli || cli === null}
          >
            <Terminal className="size-4" aria-hidden="true" />
            {isUpdatingCli
              ? t('settings.working')
              : cli?.installed
                ? t('settings.uninstallCommand')
                : t('settings.installCommand')}
          </Button>
        </SettingsRow>

        {cli?.installed ? (
          <pre
            className="overflow-x-auto rounded-lg border border-border bg-muted/60 px-3 py-2.5 font-mono text-xs text-foreground"
            aria-label={t('settings.commandLineToolPath')}
          >
            {cli.target}
          </pre>
        ) : null}

        {cli?.installed && cli.pathHint ? (
          <p className="mt-2 text-xs text-muted-foreground">{cli.pathHint}</p>
        ) : null}

        {cliError ? (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {cliError}
          </p>
        ) : null}

        <p className="mt-3 text-xs text-muted-foreground">
          {t('settings.cliRunHint')} <code className="font-mono">purescience start</code>{' '}
          {t('settings.cliOpenUrlHint')} <code className="font-mono">purescience stop</code>{' '}
          {t('settings.cliShutDownHint')} <code className="font-mono">status</code> /{' '}
          <code className="font-mono">url</code> {t('settings.cliAlsoAvailable')}
        </p>
      </SettingsSection>

      <SettingsSection
        title={t('settings.enjoyingPureScience')}
        description={<>{t('settings.communityDesc')}</>}
        aria-label={t('settings.community')}
        separated
      >
        {/* One link. The repository, Discord and X buttons are gone: each sent readers somewhere we do not
            write for them, and three near-identical buttons where one page is meant explained nothing. */}
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={APP.links.website}
            target="_blank"
            rel="noreferrer"
            aria-label={t('aria.openWebsite').replace('{name}', APP.name)}
            className={socialLinkClassName}
          >
            <Globe className="size-4" strokeWidth={2} aria-hidden="true" />
            {t('settings.socialWebsite')}
          </a>
        </div>
      </SettingsSection>
    </div>
  )
}

export { GeneralPanel }
