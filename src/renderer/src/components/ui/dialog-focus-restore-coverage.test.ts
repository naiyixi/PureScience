import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Sweep guard for dialog focus. Radix restores focus on close by focusing its own `Dialog.Trigger`; almost
// every dialog in this app is opened from page state, so there is no Trigger inside the Root and the restore
// has to be explicit (`useDialogFocusRestore`). Missing it drops a keyboard user onto <body> when the dialog
// goes away. This guard keeps new dialogs from quietly joining that pile.
//
// What this checks: every file rendering `Dialog.Content` without a `Dialog.Trigger` either uses the hook or
// carries a `focus-restore-exempt: <reason>` note explaining why the restore is handled elsewhere.
// What it cannot check: that the hook is bound to the dialog's real `open` flag, or that the opener is the
// control the person came from. Those stay with the per-dialog tests.
const RENDERER_ROOT = join(__dirname, '..', '..')

const collect = (root: string, collected: string[] = []): string[] => {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (statSync(path).isDirectory()) {
      collect(path, collected)
      continue
    }
    if (!/\.tsx$/.test(entry) || /\.test\.tsx$/.test(entry)) continue
    collected.push(path)
  }
  return collected
}

const hasContent = (source: string): boolean => /<Dialog\.Content[\s>]/.test(source)
const hasTrigger = (source: string): boolean => /<Dialog\.Trigger[\s>]/.test(source)
const usesHook = (source: string): boolean => /useDialogFocusRestore/.test(source)
const isExempt = (source: string): boolean => /focus-restore-exempt:/.test(source)

const violations = (): string[] => {
  const found: string[] = []
  for (const path of collect(RENDERER_ROOT)) {
    const source = readFileSync(path, 'utf8')
    if (!hasContent(source)) continue
    if (hasTrigger(source) || usesHook(source) || isExempt(source)) continue
    found.push(path.slice(RENDERER_ROOT.length + 1))
  }
  return found.sort()
}

describe('dialog focus restore coverage', () => {
  it('every dialog mounted without a trigger restores focus itself', () => {
    const unchecked = violations()

    expect(
      unchecked,
      'These files render <Dialog.Content> without a <Dialog.Trigger> and neither use\n' +
        'useDialogFocusRestore nor carry a "focus-restore-exempt: <reason>" note. Closing them drops\n' +
        'focus onto <body>; wire the hook (or state the reason it is handled elsewhere).'
    ).toEqual([])
  })

  it('counts the dialogs it is scanning, so a silent walk failure cannot read as compliance', () => {
    expect(collect(RENDERER_ROOT).length).toBeGreaterThan(200)
  })
})
