import { ChevronDown } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useLanguage } from '@/i18n'

import type { CreateComputeHostRequest, SshOverrides } from '../../../../shared/compute'
import { DETAILS_DOC_MAX_LENGTH } from '../../../../shared/compute'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useComputeStore } from '@/stores/compute-store'

type ComputeAddFormProps = {
  // Called with the new host's provider id after a successful create (SettingsPage navigates to the
  // host detail shell).
  onCreated: (providerId: string) => void
  onCancel: () => void
}

// Builds the create request from the form, trimming and dropping empty advanced overrides so an empty
// section is stored as no overrides (never "{}"). Only user/port/identity — never credentials.
const buildRequest = (
  alias: string,
  detailsDoc: string,
  user: string,
  port: string,
  identityFile: string,
  passwordCredentialId: string
): CreateComputeHostRequest => {
  const overrides: SshOverrides = {}
  if (user.trim()) overrides.user = user.trim()
  const portNum = Number.parseInt(port.trim(), 10)
  if (port.trim() !== '' && Number.isFinite(portNum)) overrides.port = portNum
  if (identityFile.trim()) overrides.identityFile = identityFile.trim()
  if (passwordCredentialId.trim()) overrides.passwordCredentialId = passwordCredentialId.trim()

  return {
    sshAlias: alias.trim(),
    detailsDoc: detailsDoc.trim() ? detailsDoc : undefined,
    sshOverrides: Object.keys(overrides).length > 0 ? overrides : undefined
  }
}

export function ComputeAddForm({ onCreated, onCancel }: ComputeAddFormProps): React.JSX.Element {
  const { t } = useLanguage()
  const sshAliases = useComputeStore((state) => state.sshAliases)
  const loadSshAliases = useComputeStore((state) => state.loadSshAliases)
  const createHost = useComputeStore((state) => state.createHost)
  const probeHost = useComputeStore((state) => state.probeHost)

  const [alias, setAlias] = useState('')
  const [detailsDoc, setDetailsDoc] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [user, setUser] = useState('')
  const [port, setPort] = useState('')
  const [identityFile, setIdentityFile] = useState('')
  const [passwordCredentialId, setPasswordCredentialId] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    void loadSshAliases()
  }, [loadSshAliases])

  const detailsTooLong = detailsDoc.length > DETAILS_DOC_MAX_LENGTH
  const canSubmit = useMemo(
    () => alias.trim().length > 0 && !detailsTooLong && !isSubmitting,
    [alias, detailsTooLong, isSubmitting]
  )

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return
    setIsSubmitting(true)
    setError(undefined)

    try {
      const host = await createHost(
        buildRequest(alias, detailsDoc, user, port, identityFile, passwordCredentialId)
      )
      // Navigate to the detail page immediately; the probe runs in the background so the detail page
      // can show "Probing…" state (design.md §7: create record → auto-probe → redirect to detail).
      onCreated(host.providerId)
      // Fire-and-forget: errors are captured as probeResult.ok=false and surfaced in the detail UI.
      void probeHost(host.providerId).catch(() => undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.couldNotAddHost'))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="p-5">
      <p className="mb-5 text-[13px] leading-5 text-muted-foreground">
        {t('computeAdd.pickParagraph').replace('{cfg}', '~/.ssh/config')}
      </p>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-foreground">
            {t('computeAdd.fromSshLabel')}
          </label>
          <Select
            value={alias}
            onValueChange={(value) => setAlias(value)}
            disabled={sshAliases.length === 0}
          >
            <SelectTrigger aria-label={t('computeAdd.pickHostAria')}>
              <SelectValue
                placeholder={
                  sshAliases.length === 0
                    ? t('settings.noHostsInSshConfig')
                    : t('settings.pickHost')
                }
              />
            </SelectTrigger>
            <SelectContent>
              {sshAliases.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="compute-alias" className="text-sm font-medium text-foreground">
            {t('computeAdd.orTypeAlias')}
          </label>
          <Input
            id="compute-alias"
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
            placeholder="例如：biowulf、lab-gpu、coder.myworkspace"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor="compute-details" className="text-sm font-medium text-foreground">
              {t('settings.anythingToKnow')}
            </label>
            <span
              className={`text-xs ${detailsTooLong ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {detailsDoc.length} / {DETAILS_DOC_MAX_LENGTH} chars
            </span>
          </div>
          <Textarea
            id="compute-details"
            value={detailsDoc}
            onChange={(event) => setDetailsDoc(event.target.value)}
            rows={4}
            placeholder={t('settings.jobPromptPlaceholder')}
            aria-invalid={detailsTooLong || undefined}
          />
        </div>

        {/* Advanced overrides (collapsible). Values are stored as sshOverrides JSON; never credentials. */}
        <div className="rounded-xl border border-border">
          <button
            type="button"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium text-foreground"
          >
            <ChevronDown
              className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${
                advancedOpen ? '' : '-rotate-90'
              }`}
              aria-hidden="true"
            />
            {t('computeAdd.advancedOverride')}
          </button>

          {advancedOpen ? (
            <div className="flex flex-col gap-4 border-t border-border px-3 py-3">
              <p className="text-xs text-muted-foreground">
                {t('computeAdd.advancedExplain')
                  .replace('{cmd}', 'ssh -G <alias>')
                  .replace('{cfg}', '~/.ssh/config')}
              </p>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="compute-user" className="text-sm font-medium text-foreground">
                  User
                </label>
                <Input
                  id="compute-user"
                  value={user}
                  onChange={(event) => setUser(event.target.value)}
                  placeholder="argocd"
                />
                <span className="text-xs text-muted-foreground">
                  Leave empty to use User from ~/.ssh/config.
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="compute-port" className="text-sm font-medium text-foreground">
                  Port
                </label>
                <Input
                  id="compute-port"
                  inputMode="numeric"
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                  placeholder="22"
                />
                <span className="text-xs text-muted-foreground">
                  Leave empty for 22 or Port from ~/.ssh/config.
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="compute-identity" className="text-sm font-medium text-foreground">
                  {t('settings.identityFile')}
                </label>
                <Input
                  id="compute-identity"
                  value={identityFile}
                  onChange={(event) => setIdentityFile(event.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                />
                <span className="text-xs text-muted-foreground">
                  Leave empty for ssh-agent / IdentityFile from ~/.ssh/config.
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="compute-password-credential"
                  className="text-sm font-medium text-foreground"
                >
                  {t('settings.sshPasswordCredential')}
                </label>
                <Input
                  id="compute-password-credential"
                  value={passwordCredentialId}
                  onChange={(event) => setPasswordCredentialId(event.target.value)}
                  placeholder={t('settings.sshPasswordCredentialPlaceholder')}
                />
                <span className="text-xs text-muted-foreground">
                  {t('settings.sshPasswordCredentialHint')}
                </span>
              </div>
            </div>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
            {t('common.cancel')}
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {isSubmitting ? t('settings.addingHost') : t('settings.add')}
          </Button>
        </div>
      </div>
    </div>
  )
}
