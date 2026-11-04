# 分发面：首个 Homebrew cask（2026-11-05）

## 一句话

`brew info --cask purescience` 从「No Cask with this name exists」变成能解析出 **2.26.0**：tap 仓库
`naiyixi/homebrew-tap` 已建，cask 指向 2.26.0 的两枚 mac dmg，**校验值不是抄来的**——独立下载 arm64 dmg
复算 sha256，与发布页 `SHA256SUMS.txt` 里那一行逐字符相同。

## 一 交付

| 位置 | 内容 |
| --- | --- |
| `naiyixi/homebrew-tap`（新建 public 仓库）`Casks/purescience.rb` | `version "2.26.0"`；`sha256 arm: …, intel: …` 双架构；`url` 按架构选 `-mac-arm64.dmg` / `-mac-x64.dmg`；`livecheck :github_latest`；`app "PureScience.app"`；`zap trash` 收 `~/.purescience` 与 `~/.purescience-project`；caveats 明写「ad-hoc 签名、未公证，必要时 `--no-quarantine`」 |
| `README.md` / `README.en.md` | Quick Start 增一段 macOS（Homebrew）安装命令，三段必须连写：`brew tap` → `brew trust` → `brew install --cask` |

tap 仓库两笔：`3f28506`（首版）＋ 一笔收尾（去掉 Homebrew 7 已弃用的 `verified:` 参数、补 `zap`）。

## 二 读数（全部实跑）

1. 发布页资产：`zerolink-purescience-2.26.0-mac-arm64.dmg` **284,892,933 B**；`-mac-x64.dmg` 300,329,114 B。
2. **独立下载 arm64 dmg 后自算**：字节数 **284,892,933**（与资产 size 一致），
   `sha256 4848c62a5970779d1d70f22500948c3c17a109b457180bff37c004225a1414ea` —— 与 `SHA256SUMS.txt`
   里 `zerolink-purescience-2.26.0-mac-arm64.dmg` 那一行**逐字符相同**。cask 里那个值就是它。
3. **只读挂载该 dmg**（`hdiutil attach -readonly`）：内含 `PureScience.app`，
   `CFBundleIdentifier=com.zerolink.purescience`、`CFBundleShortVersionString=2.26.0`、
   `codesign Signature=adhoc`、`TeamIdentifier=not set` ⇒ cask 的 caveats 与 v2.27.0 的阻塞是同一件事的两面，
   不是措辞谨慎。
4. `brew tap naiyixi/tap` → `Tapped 1 cask`。**`brew trust naiyixi/tap` 是 Homebrew 7 的新门槛**：不信任时
   `brew info` 直接报 `Refusing to load cask naiyixi/tap/purescience from untrusted tap` ⇒ README 的三段命令
   少一段，用户只会撞到这句拒绝。
5. `brew info --cask purescience` → `purescience (PureScience): 2.26.0`，Artifacts 为 `PureScience.app (App)`，
   caveats 原样显示（此前同一命令：`Cask 'purescience' is unavailable: No Cask with this name exists`）。
6. `brew audit --cask --new naiyixi/tap/purescience`：首跑 **3 problems** ⇒ 修掉「未声明最低系统版本」后复跑
   **2 problems**，剩下的两条都是结构性的，不是文件写错：
   - `Signature verification failed: … not signed by a distributor that meets the system Gatekeeper requirements`
     —— ad-hoc 签名，与 v2.27.0 的证书是同一件事；
   - `GitHub repository not notable enough (<30 forks, <30 watchers and <75 stars)` —— 那是**进 Homebrew 官方
     cask 库**的策略门，自建 tap 不受它限制（audit 对第三方 tap 仍会记这条）。
   两轮之间还踩了 Homebrew 7 的两处弃用，都已改掉：`url … verified:` 参数、`depends_on macos: ">= :monterey"`
   字符串比较写法（正解 `depends_on macos: :monterey`）。

## 三 排期档核对（动手之前先看那一行还在不在）

| 排期项 | 现状 | 判据 |
| --- | --- | --- |
| v2.22.0 把 `statics.zerolink.com` 换成真实 feed | **✅ 已交付（内容随 v2.23.0 发布）** | `electron-builder.yml:170-178` 的 `publish:` 已是 `provider: github / owner: naiyixi / repo: PureScience`，注释写明该镜像域名从未解析；`CHANGELOG.md:84-88` 记「v2.22.0 的全部内容随 v2.23.0 一起发布；tag `v2.22.0` 保留为历史标记，不产出资产」 |
| v2.22.0 README 删掉 51.8 s 自陈 | **✅ 已满足** | `grep -n "unoptimis" README.md README.en.md` 零命中（§291 §五 已记，勿再改） |
| v2.22.0 更新提示明说 mac 需手动重装 | **✅ 已交付** | 键 `update.macManualInstallNote` 九语言齐全（`zh.ts:2528` / `en.ts:2717` / …），`UpdateDialog.tsx:168-172` 在 darwin 且非 restart 时渲染；`create-strategy.ts:80-87` 在缺 Team ID 时记具名日志 `mac-team-id-not-provisioned` |
| v2.22.0 换自有 Team ID | **⛔ 仍阻塞（外部）** | 本轮挂载读数：`Signature=adhoc`、`TeamIdentifier=not set` ⇒ 要采购 Developer ID 证书；代码侧已改成「按**实际签名**判断能否原地更新 + 保守回落到手动安装」，不再借别人的 Team ID |
| v2.24.0 npm 发布 | **✅ 已交付，但名字与档里写的不一样** | `npm view purescience version` → **0.1.2**；档里写的是 `@zerolink/purescience`（该名字 404）。首发改成非 scoped 的 `purescience`（`2b90ace7`） |
| v2.24.0 Homebrew cask | **✅ 本轮交付** | 见上两节 |

结论：v2.22.0 的四条**没有一条是代码缺口**（三条早已交付、一条卡外部证书）；v2.24.0 的 npm 早已发、只差 cask，
本轮补齐 ⇒ **这一版只剩 v2.27.0 的证书这一条外部阻塞**，不需要为 cask 抬版本号（纯分发与文档）。

## 四 边界（不许读成更强）

- **没有实装**：`brew install --cask purescience` 未跑。它会下载 272 MB 并把同名应用写进本机 `/Applications`，
  与用户正在用的那份冲突 —— 无人值守时替换用户的应用不是验证，是破坏。替代读数是「独立下载 + 复算校验值 +
  只读挂载读 bundle 版本与签名」。缺的那一步具名在此。
- **intel 那份 dmg 未重新下载复算**：它的 sha256 取自同一次发布的 `SHA256SUMS.txt`（与 arm 同源、同一台构建机产出），
  本机是 arm64，不为一行校验值再拉 300 MB。
- README 那段三段命令是**新文案**：本轮读数是「`brew info` 能解析 + audit 结论」，不是「照 README 走一遍能装上」。
- 排期档里 v2.22.0 的四个勾**没有改**：该档此刻被并行会话持有（工作区里它有未提交的 §案例排序 改写），
  判据留给持有者或下一轮翻勾。
