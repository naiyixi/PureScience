// @vitest-environment jsdom
//
// 删除项目确认框的文案必须随界面语言走。历史缺陷：描述里混着硬编码英文碎片（` and its 3 sessions`、
// `Generated artifacts and uploaded files…`）并在中文提示句后**再拼一个英文尾巴** ` be undone.`，于是
// 中文界面读作「…此操作无法撤销。 and its 3 sessions. Generated artifacts… 此操作无法撤销。 be undone.」。
// 那些碎片住在**组件**里，任何字典测试都看不见 ⇒ 本文件按语言真渲染一次，把「屏上是哪种语言」钉住。
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Project } from '../../../../shared/projects'
import { LanguageProvider } from '@/i18n'
import { DeleteProjectDialog } from './DeleteProjectDialog'

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) => (
    <button {...props}>{children}</button>
  )
}))

vi.mock('@/components/ui/dialog-focus-restore', () => ({
  useDialogFocusRestore: () => ({
    onOpenAutoFocus: () => {},
    onCloseAutoFocus: () => {}
  })
}))

// 这些用例只关心文案，浮层的 Portal/焦点行为由 home-dialogs.render.test.tsx 与真机 spec 覆盖。
vi.mock('radix-ui', () => ({
  AlertDialog: {
    Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Overlay: () => null,
    Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Title: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Description: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Cancel: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Action: ({ children }: { children?: ReactNode }) => <>{children}</>
  }
}))

const project: Project = {
  id: 'project-locale',
  name: '单细胞分析',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.localStorage.clear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.localStorage.clear()
})

const renderIn = async (language: string): Promise<string> => {
  window.localStorage.setItem('purescience-language', language)
  await act(async () =>
    root.render(
      <LanguageProvider>
        <DeleteProjectDialog
          project={project}
          sessionCount={3}
          hasCompleteSessionCatalog
          canDelete
          isDeleting={false}
          error={undefined}
          onCancel={() => {}}
          onConfirmDelete={() => {}}
        />
      </LanguageProvider>
    )
  )
  return container.textContent ?? ''
}

describe('DeleteProjectDialog 文案随语言走', () => {
  it('中文界面没有英文碎片，且每句都来自字典', async () => {
    const text = await renderIn('zh')

    expect(text).toContain('删除项目？')
    expect(text).toContain('这将永久删除"单细胞分析"。此操作无法撤销。')
    expect(text).toContain('它保存的 3 个对话将一并删除。')
    expect(text).toContain('PureScience 保存的产物与上传文件也会一并删除。')
    expect(text).toContain('项目工作文件夹中的文件不会被删除。')
    // 按钮与关闭 aria-label 也必须是字典来的（此前是硬编码 Cancel / Delete / Deleting… / Close）
    expect(text).toContain('取消')
    expect(text).toContain('删除')
    expect(container.querySelector('[aria-label="关闭"]')).not.toBeNull()
    // 旧缺陷的三个形状：英文碎片、被截断的提示句、拼出来的英文尾巴
    expect(text).not.toContain(' be undone.')
    expect(text).not.toContain(' and its ')
    expect(text).not.toContain('Generated artifacts')
    expect(text).not.toContain('This action cannot')
  })

  it('英文界面读起来是一句完整的话（同一处拼装在两种语言下都成立）', async () => {
    const text = await renderIn('en')

    expect(text).toContain('Delete project?')
    expect(text).toContain('This will permanently delete "单细胞分析". This action cannot be undone.')
    expect(text).toContain('This deletes its 3 saved conversations too.')
    expect(text).toContain('Generated artifacts and uploaded files stored by PureScience will also be deleted.')
    expect(text).toContain("Files in the project's working folder are not deleted.")
    expect(text).not.toContain(' be undone. and its')
  })
})
