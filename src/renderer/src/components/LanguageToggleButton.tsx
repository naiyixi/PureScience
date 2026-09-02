import { Check, Languages } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { LANGUAGES } from '@/i18n/languages'
import { useLanguage } from '@/i18n'

type LanguageToggleButtonProps = {
  className?: string
}

// 语言选择菜单: 点击展开全部支持的语言 (简体/繁体中文、英文、日韩法德西俄)。
// 语言选择持久化 (localStorage + document.lang)。原为二元切换按钮, 扩展为菜单以覆盖 9 语言。
const LanguageToggleButton = ({ className }: LanguageToggleButtonProps): React.JSX.Element => {
  const { lang, setLang } = useLanguage()

  const current = LANGUAGES.find((entry) => entry.id === lang)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Language"
          title="Language"
          className={cn('gap-1.5 text-muted-foreground hover:text-foreground', className)}
        >
          <Languages className="h-4 w-4" aria-hidden="true" />
          <span className="text-xs font-medium">{current?.label ?? lang}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LANGUAGES.map((entry) => (
          <DropdownMenuItem
            key={entry.id}
            onClick={() => setLang(entry.id)}
            className="justify-between gap-4"
          >
            <span>{entry.label}</span>
            {entry.id === lang ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export { LanguageToggleButton }
export type { LanguageToggleButtonProps }
