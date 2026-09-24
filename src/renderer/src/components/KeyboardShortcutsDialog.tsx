import { Dialog } from 'radix-ui'

import { useLanguage, type TranslationKey } from '@/i18n'
import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { useDialogFocusRestore } from '@/components/ui/dialog-focus-restore'

type ShortcutRow = {
  id: string
  // Rendered as separate keycaps, with `mod` standing in for the platform's modifier so the sheet reads
  // correctly on Windows and Linux too.
  keys: readonly string[]
  labelKey: TranslationKey
}

// Only chords that are actually wired are listed. A shortcut sheet that lies about what exists is worse
// than no sheet: ⌘K opens this palette (gated on other dialogs being closed), ⌘, opens settings, and ⌘W
// walks the tab → pane → window ladder (see useCloseActivePaneShortcut).
const SHORTCUT_ROWS: readonly ShortcutRow[] = [
  { id: 'palette', keys: ['mod', 'K'], labelKey: 'shortcuts.commandPalette' },
  { id: 'settings', keys: ['mod', ','], labelKey: 'shortcuts.openSettings' },
  { id: 'close', keys: ['mod', 'W'], labelKey: 'shortcuts.closeActivePane' },
  { id: 'move', keys: ['↑', '↓'], labelKey: 'shortcuts.moveInList' },
  { id: 'run', keys: ['↵'], labelKey: 'shortcuts.runRow' },
  { id: 'dismiss', keys: ['esc'], labelKey: 'shortcuts.dismiss' }
]

const keycapClassName =
  'inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md border border-border bg-bg-000 px-1.5 font-mono text-[11px] leading-none text-foreground shadow-sm'

export const KeyboardShortcutsDialog = ({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element => {
  const { t } = useLanguage()
  const focusRestore = useDialogFocusRestore(open)
  const modifier = window.api?.platform === 'darwin' ? '⌘' : 'Ctrl'

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          data-testid="keyboard-shortcuts-dialog"
          onOpenAutoFocus={focusRestore.onOpenAutoFocus}
          onCloseAutoFocus={focusRestore.onCloseAutoFocus}
          className={dialogPanelClassName('w-[calc(100%_-_2rem)] max-w-[520px] p-0')}
        >
          <div className="border-b border-border px-6 py-4">
            <Dialog.Title className="text-base font-medium">{t('shortcuts.title')}</Dialog.Title>
            <p className="mt-1 text-xs text-muted-foreground">{t('shortcuts.hint')}</p>
          </div>
          <ul className="divide-y divide-border">
            {SHORTCUT_ROWS.map((row) => (
              <li
                key={row.id}
                data-testid={`shortcut-row-${row.id}`}
                className="flex items-center justify-between gap-4 px-6 py-3"
              >
                <span className="text-sm text-foreground">{t(row.labelKey)}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {row.keys.map((key) => (
                    <kbd key={key} className={keycapClassName}>
                      {key === 'mod' ? modifier : key}
                    </kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
