# 视觉基准随「首页用例画廊」刷新（2026-10-31）

## 一 为什么红

`Nightly` run `41096340005`（head `4ab79588`）在 `build / Build macos-arm64` 的
`npm run test:e2e:visual` 步骤红：

```
[visual] home-empty.png differs; surface fingerprint {"header":"PureSciencev2.20.0-nightly.g4ab7958…"}
14795 pixels (ratio 0.02 of all image pixels) are different.   Snapshot: home-empty.png
```

判据是 `maxDiffPixelRatio = 0.002`（darwin）⇒ 2 % 远超阈值，不是抖动。

## 二 真因（本机隔离工作树复现，不是推断）

`2678c1c7`（`feat(workspace): 排版两改 …`）同一个提交里把 **H1 用例画廊**挂进了首页
（`HomePage.tsx:715  <UseCaseGallery />`），而四张 darwin 基准图没跟着刷新 ⇒ 首页截图上多出画廊那一块。

隔离工作树 `/tmp/ps-vis`（`git worktree add … 4ab79588` + `node_modules` 软链）、
先 `npm run build:e2e`（EXIT 0，34.38 s）再 `npx playwright test e2e/visual-regression.spec.ts`：

| 基准 | 读数 | 差异图里是什么 |
| --- | --- | --- |
| `home-empty.png` | **10 222 px（1.02 %）** | 差异图正好是五张用例卡片那块文字区 |
| `project-create-dialog.png` | **4 978 px（0.49 %）** | 裁出对话框区域（410,220–870,580）后，**区域内一条高亮都没有** ⇒ 对话框本体没变，变的是它背后那层被压暗的首页（画廊从背后透出来） |

两条差异同一个因，所以**不需要改阈值、也不需要遮蔽任何产品面**：要改的是「基准图跟产品走」。

## 三 修法

在上面那个隔离工作树里 `--update-snapshots` 重跑同一支 spec：

```
npx playwright test e2e/visual-regression.spec.ts --workers=1 --update-snapshots   → 1 passed (4.9 s)
```

只有这两张变了（`git status` 逐字确认）：

```
M e2e/visual-regression.spec.ts-snapshots/home-empty-darwin.png
M e2e/visual-regression.spec.ts-snapshots/project-create-dialog-darwin.png
```

`settings-general-darwin.png` / `workspace-empty-darwin.png` **没变** —— 这也是本批排版改动
（正文 68ch、折叠摘要 24 px）的一条旁证：它没有移动设置页与空工作台的版式。

更新后把两张图拿回主树，`expectStableScreenshot` 的遮蔽项、`maxDiffPixelRatio`、
`caret`、`animations` 一个字没动（只换基准文件）。本机判据：更新后同一条命令 **1 passed**。

## 四 同一 run 里另一件没修完（具名，别读成已解决）

同一作业里还有 **4 条认证失败**，全在 `references-screening*`，症状是同一句话：

```
Locator: … getByTestId('screening-panel').getByText(/AI decisions N · human overrides 0/)
Error: element(s) not found            （两次尝试相同）
```

面板自己的读数写着 `Finished with failures 2 / 2 processed 0 assessed · 2 failed · Model error: 2`
⇒ 每一轮 pass 都在**模型那一步**失败，不是界面没渲染。

已核过的事实，供下一轮接着定因（本轮**没有**修它）：

1. **不是本批代码**：`git diff --stat 5a9123d2..4ab79588` 只动到 i18n（新增键）、
   `pages/home/**`（H1 画廊）、`pages/workspace/{WorkspaceMessageItem,WorkspaceActivityGroup}.tsx`、
   `packages/purescience/**`（doctor/signature）、`e2e/**`、`docs/**` —— **`src/main/references/**`
   与 `src/main/acp/**` 一个字节没变**；
2. **同一份 screening 代码在上一条绿的 Nightly**（`31a83bf3`，run `41017187951`）**跑过并绿**
   （该 run `105 passed`，失败只有 DOCX 一条与视觉一条）；
3. 该作业整体比上一条绿的时间多出 55 %（41.6 min vs 26.9 min），且四条失败是**同一族的四个 spec
   全部**中招（连 `AI decisions 5` 的那条 coverage spec 也一样）⇒ 指向 runner 侧的一次性条件，
   而不是某一支用例的写法。
4. 失败 spec 的 app-process 日志里**没有任何 ACP 会话行**（`session.new` / `session.prompt` 都没有），
   与「模型那一步失败」自洽 —— 但本轮没有更多读数能把「没被派发」与「派发了没回话」分开。

## 五 下一轮第一步（判据已备好）

推上去之后按**完整 40 位 SHA** 读新 `Nightly` 的 `macos-arm64` 作业：

- `references-screening*` 全绿 ⇒ 记成 runner 侧一次性条件（本轮不改代码的判决成立），
  并把这条读数补进本档；
- 仍红在同一处 ⇒ 用 `scripts/ci-failure-digest.mjs <run-id>` 取作业级日志，
  先看 `screening-model-runner` 那一层抛的是「turn ended without any answer text」
  还是「tool attempted」（两者都落到 `model-error`，修法方向不同），再动代码。
