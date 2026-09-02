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

// 语言选择菜单: 「跟随系统」+ 全部支持的语言 (简体/繁体中文、英文、日韩法德西俄)。
// 偏好持久化 (localStorage + document.lang)。原为二元切换按钮, 扩展为菜单以覆盖 9 语言;
// 「跟随系统」位于首位, 与参考产品 LANGUAGE_PREFERENCES=['system', ...] 的模型一致。
const LanguageToggleButton = ({ className }: LanguageToggleButtonProps): React.JSX.Element => {
  const { t, lang, preference, setLang } = useLanguage()

  const label =
    preference === 'system'
      ? t('settings.languageSystem')
      : (LANGUAGES.find((entry) => entry.id === lang)?.label ?? lang)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('common.language')}
          title={t('common.language')}
          className={cn('gap-1.5 text-muted-foreground hover:text-foreground', className)}
        >
          <Languages className="h-4 w-4" aria-hidden="true" />
          <span className="text-xs font-medium">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setLang('system')} className="justify-between gap-4">
          <span>{t('settings.languageSystem')}</span>
          {preference === 'system' ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
        </DropdownMenuItem>
        {LANGUAGES.map((entry) => (
          <DropdownMenuItem
            key={entry.id}
            onClick={() => setLang(entry.id)}
            className="justify-between gap-4"
          >
            <span>{entry.label}</span>
            {preference === entry.id ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export { LanguageToggleButton }
export type { LanguageToggleButtonProps }
