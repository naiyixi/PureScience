import { Languages } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useLanguage, type Language } from '@/i18n'

type LanguageToggleButtonProps = {
  className?: string
}

// 中英文切换按钮: 点击在 zh/en 间切换, 语言选择持久化 (localStorage + document.lang)。
// 替换原 GitHub 星标按钮的位置 (home header / workspace sidebar)。
const LanguageToggleButton = ({ className }: LanguageToggleButtonProps): React.JSX.Element => {
  const { lang, setLang } = useLanguage()

  const toggle = (): void => setLang(lang === 'zh' ? 'en' : 'zh')

  const next: Language = lang === 'zh' ? 'en' : 'zh'

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggle}
      aria-label={lang === 'zh' ? 'Switch to English' : '切换到中文'}
      title={lang === 'zh' ? 'Switch to English' : '切换到中文'}
      className={cn('gap-1.5 text-muted-foreground hover:text-foreground', className)}
    >
      <Languages className="h-4 w-4" aria-hidden="true" />
      <span className="text-xs font-medium">{next === 'zh' ? '中' : 'EN'}</span>
    </Button>
  )
}

export { LanguageToggleButton }
export type { LanguageToggleButtonProps }
