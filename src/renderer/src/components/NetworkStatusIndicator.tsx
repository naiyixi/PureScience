import { WifiOff } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useLanguage } from '@/i18n'
import { cn } from '@/lib/utils'
import { useNetworkStore } from '@/stores/network-store'
import { useSettingsStore } from '@/stores/settings-store'

type NetworkStatusIndicatorProps = {
  // 'pill' for the home header (icon + label), 'icon' for the workspace sidebar footer
  // where space is tight.
  variant: 'pill' | 'icon'
}

// Offline / unreachable warning entry point. Renders nothing while the internet is genuinely
// reachable; a missing link shows red ("Offline"), a live link with a broken path out shows
// amber ("Unreachable"). Clicking opens the settings Network panel for troubleshooting.

// Tone maps keep the Update-capsule design spec identical across states — only the palette
// changes (danger for a missing link, session-waiting amber for unreachable).
const pillToneClasses = {
  danger:
    'border-danger-000/20 bg-danger-000/10 text-danger-000 hover:border-danger-000/30 hover:bg-danger-000/15',
  warning:
    'border-session-waiting/20 bg-session-waiting/10 text-session-waiting hover:border-session-waiting/30 hover:bg-session-waiting/15'
} as const

const iconToneClasses = {
  danger: 'text-danger-000 hover:bg-danger-900',
  warning: 'text-session-waiting hover:bg-session-waiting/10'
} as const

const NetworkStatusIndicator = ({
  variant
}: NetworkStatusIndicatorProps): React.JSX.Element | null => {
  const isOnline = useNetworkStore((state) => state.isOnline)
  const connectivity = useNetworkStore((state) => state.connectivity)
  const openSettingsToPanel = useSettingsStore((state) => state.openSettingsToPanel)
  const { t } = useLanguage()

  if (isOnline && connectivity !== 'unreachable') return null

  const unreachable = isOnline // online but unreachable: amber instead of red
  const tone = unreachable ? 'warning' : 'danger'
  // Both words are interface copy, not telemetry: the pill is on the home header, where every neighbouring
  // label is translated — so they come from the dictionaries like the rest of it.
  const label = unreachable ? t('network.internetUnreachable') : t('network.noInternet')
  const text = unreachable ? t('network.unreachable') : t('network.offline')

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-slot="network-status"
            onClick={() => openSettingsToPanel('network')}
            aria-label={label}
            className={
              variant === 'pill'
                ? cn(
                    'inline-flex h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors duration-150 ease-out',
                    pillToneClasses[tone]
                  )
                : cn(
                    'inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md transition-colors duration-150 ease-out',
                    iconToneClasses[tone]
                  )
            }
          >
            <WifiOff
              className={variant === 'pill' ? 'size-3.5' : 'size-4'}
              strokeWidth={2}
              aria-hidden="true"
            />
            {variant === 'pill' ? <span>{text}</span> : null}
          </button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export { NetworkStatusIndicator }
