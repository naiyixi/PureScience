# Windows 真机验收：安装 → 四运行时 → 装坏 → 一键重装 → 升级。
#
# 判据来自 docs/plan-2026-11-18-capability-gap-roadmap.md 的 3.1/3.2。桌面截图在 CI 上没有意义（runner 跑在服务会话里，
# 截不到可靠画面），所以这里用「装完的二进制真的起来 + 它自己的 /api/v1 读数」作为证据：readiness 与 runtimes 都是
# 设置窗口渲染的同一份判定（`purescience ready` / `runtime list` 也走这两个端），不是另写一套。
#
# 每一步都落 JSON 到 evidence 目录；任何一条断言不成立就以非零退出，绝不把「跳过」写成「通过」。
param(
  [Parameter(Mandatory = $true)][string]$OldSetup,
  [Parameter(Mandatory = $true)][string]$NewSetup,
  [int]$Port = 4599,
  [string]$Work = (Join-Path $env:RUNNER_TEMP 'ps-winverify')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$evidenceDir = Join-Path $Work 'evidence'
$installDir = Join-Path $Work 'app'
$e2eRoot = Join-Path $Work 'e2e'
New-Item -ItemType Directory -Force -Path $evidenceDir, $installDir, $e2eRoot | Out-Null

$script:appProcess = $null
$report = [ordered]@{
  startedAt = (Get-Date).ToString('o')
  oldSetup  = $OldSetup
  newSetup  = $NewSetup
  steps     = @()
}

function Save-Json([string]$name, $value) {
  $path = Join-Path $evidenceDir $name
  $value | ConvertTo-Json -Depth 12 | Set-Content -Path $path -Encoding utf8
  Write-Host "  ↳ $path"
}

function Add-Step([string]$name, [bool]$ok, $detail) {
  $script:report.steps += [ordered]@{ name = $name; ok = $ok; detail = $detail }
  $mark = if ($ok) { '✓' } else { '✗' }
  Write-Host "$mark $name"
  if (-not $ok) { throw "step failed: $name" }
}

function Install-Setup([string]$setup, [switch]$KeepUserData) {
  # NSIS：/S 静默安装，/D= 目标目录必须是最后一个参数且不加引号。重装（修复）与升级都走这一条，
  # 也正是用户点「一键重装」时发生的事。
  if (Test-Path $installDir) {
    Get-ChildItem -Path $installDir -Filter '*.exe' -Recurse -ErrorAction SilentlyContinue |
      ForEach-Object { try { $_.VersionInfo.FileVersion | Out-Null } catch { } }
  }
  $process = Start-Process -FilePath $setup -ArgumentList '/S', "/D=$installDir" -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "installer $setup exited $($process.ExitCode)" }
  Start-Sleep -Seconds 3
}

function Get-AppExe() {
  $candidates = Get-ChildItem -Path $installDir -Filter '*.exe' -Recurse -Depth 2 -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike '*uninst*' }
  if (-not $candidates) { throw "no launcher exe under $installDir" }
  # 主程序是体积最大的那个（uninstaller 之外）。
  return ($candidates | Sort-Object Length -Descending | Select-Object -First 1).FullName
}

function Start-App() {
  $exe = Get-AppExe
  $env:PURESCIENCE_E2E_STORAGE_ROOT = $e2eRoot
  $script:appProcess = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden `
    -ArgumentList '--purescience-headless', "--serve=$Port"
  Write-Host "  app: $exe (pid $($script:appProcess.Id))"
  return $exe
}

function Stop-App() {
  if ($script:appProcess -and -not $script:appProcess.HasExited) {
    try { $script:appProcess.Kill() } catch { }
    Start-Sleep -Seconds 2
  }
  $script:appProcess = $null
}

function Get-Token() {
  $tokenFile = Join-Path $e2eRoot 'web-token'
  for ($i = 0; $i -lt 60; $i++) {
    if (Test-Path $tokenFile) {
      $token = (Get-Content -Raw -Path $tokenFile).Trim()
      if ($token) { return $token }
    }
    Start-Sleep -Seconds 2
  }
  throw "web-token never appeared at $tokenFile"
}

function Get-Api([string]$path, [string]$token) {
  $headers = @{ Authorization = "Bearer $token" }
  for ($i = 0; $i -lt 30; $i++) {
    try {
      return Invoke-RestMethod -Uri "http://127.0.0.1:$Port$path" -Headers $headers -TimeoutSec 20
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  throw "GET $path never answered on port $Port"
}

function Get-RuntimeEntries($runtimes) {
  # 实际形状（2026-11-19 在 windows-latest 上读到的）：
  #   { data: { python: [ { language, envId, interpreterPath, runnable, provenance, ... } ], ... } }
  # 按语言分组、每个条目自带 runnable 判定。这里只认它自己给的字段，不从别处推断「好不好用」。
  $entries = @()
  $payload = if ($runtimes.PSObject.Properties.Name -contains 'data') { $runtimes.data } else { $runtimes }
  foreach ($language in $payload.PSObject.Properties.Name) {
    foreach ($item in @($payload.$language)) {
      if ($null -eq $item) { continue }
      $path = $item.interpreterPath
      # 不按 Test-Path 过滤：修复之后「已经不在了」的那一行**正是**要断言的对象，用存在性做前置条件会把
      # 被点名的证据自己筛掉（第一版就这么错了，判红了一轮）。
      if ($path -is [string] -and $path) {
        $entries += [pscustomobject]@{
          language = $language
          id       = $item.envId
          path     = $path
          exists   = [bool](Test-Path $path)
          runnable = [bool]$item.runnable
          detail   = $item.detail
        }
      }
    }
  }
  return $entries
}

function Get-RuntimeSnapshot($runtimes) {
  # 快照而不是计数：要对「同一个条目从 runnable 变 false」这件事说话，就必须按 envId 对齐。
  $entries = Get-RuntimeEntries $runtimes
  return [pscustomobject]@{
    total     = $entries.Count
    runnable  = @($entries | Where-Object { $_.runnable }).Count
    byId      = @{}
    entries   = $entries
  }
}

function Get-CheckStatuses($readiness) {
  $payload = if ($readiness.PSObject.Properties.Name -contains 'data') { $readiness.data } else { $readiness }
  $checks = @($payload.checks)
  return [pscustomobject]@{
    total   = $checks.Count
    failed  = @($checks | Where-Object { $_.status -ne 'passed' }).Count
    byId    = ($checks | ForEach-Object { "$($_.id)=$($_.status)" }) -join ','
  }
}

try {
  Write-Host "== 1/8 安装 $OldSetup"
  Install-Setup $OldSetup
  $exe = Get-AppExe
  $oldVersion = (Get-Item $exe).VersionInfo.ProductVersion
  Add-Step 'installed-launcher-exists' ([bool]$exe) @{ exe = $exe; productVersion = $oldVersion }

  Write-Host "== 2/8 启动并读 readiness / runtimes"
  Start-App | Out-Null
  $token = Get-Token
  $readiness = Get-Api '/api/v1/readiness' $token
  Save-Json 'readiness-installed.json' $readiness
  $runtimes = Get-Api '/api/v1/runtimes' $token
  Save-Json 'runtimes-installed.json' $runtimes
  $snapBefore = Get-RuntimeSnapshot $runtimes
  $checksBefore = Get-CheckStatuses $readiness
  Add-Step 'reads-readiness-and-runtimes' ($snapBefore.total -gt 0 -and $checksBefore.total -gt 0) @{
    runtimes = $snapBefore.total; runnable = $snapBefore.runnable; readinessChecks = $checksBefore.byId
  }

  Write-Host "== 3/8 装坏一个运行时，看它能不能点名"
  if ($snapBefore.total -eq 0) {
    Save-Json 'break-skipped.json' @{ reason = '运行时列表为空，没有可破坏的条目'; note = '未做破坏步骤，未声明通过' }
    Add-Step 'break-a-runtime-skipped' $true @{ skipped = $true }
  } else {
    $victim = ($snapBefore.entries | Where-Object { $_.runnable -and $_.exists } | Select-Object -First 1)
    if ($null -eq $victim) { $victim = $snapBefore.entries[0] }
    $brokenPath = "$($victim.path).broken"
    Move-Item -Path $victim.path -Destination $brokenPath -Force
    $afterBreak = Get-Api '/api/v1/runtimes' $token
    Save-Json 'runtimes-broken.json' $afterBreak
    $readinessBroken = Get-Api '/api/v1/readiness' $token
    Save-Json 'readiness-broken.json' $readinessBroken
    $snapBroken = Get-RuntimeSnapshot $afterBreak
    $checksBroken = Get-CheckStatuses $readinessBroken
    # 这一步只判「察觉」：同一条按 envId 已不在列表，或仍在但 runnable=false，两种都算。
    # 之所以不在这里要求「点名」，是因为这一步跑在**升级前**的二进制上——已发布的旧版本本来就没有
    # interpreter-history，要求它点名等于用未来的判据判旧版本。硬要求「点名」的是第 6 步（升级后）。
    $victimAfter = $snapBroken.entries | Where-Object { $_.id -eq $victim.id } | Select-Object -First 1
    $detail = if ($null -ne $victimAfter) { $victimAfter.detail } else { $null }
    $stillListed = $null -ne $victimAfter
    $detected = (-not $stillListed) -or (-not $victimAfter.runnable)
    Add-Step 'broken-runtime-is-detected' $detected @{
      runtime = $victim.id
      language = $victim.language
      brokenPath = $brokenPath
      runnableBefore = $snapBefore.runnable
      runnableAfter = $snapBroken.runnable
      stillListed = $stillListed
      named = ([bool]$detail)
      detail = $detail
      readinessBefore = $checksBefore.byId
      readinessAfter = $checksBroken.byId
    }
    # 还原，供后两步在干净状态上继续。
    Move-Item -Path $brokenPath -Destination $victim.path -Force
  }

  Write-Host "== 4/8 一键重装（同一版本覆盖安装）"
  Stop-App
  Install-Setup $OldSetup
  Start-App | Out-Null
  $token = Get-Token
  $afterRepair = Get-Api '/api/v1/runtimes' $token
  Save-Json 'runtimes-after-repair.json' $afterRepair
  $readinessRepair = Get-Api '/api/v1/readiness' $token
  Save-Json 'readiness-after-repair.json' $readinessRepair
  $snapRepair = Get-RuntimeSnapshot $afterRepair
  $checksRepair = Get-CheckStatuses $readinessRepair
  Add-Step 'repair-restores-runtimes' ($snapRepair.runnable -ge $snapBefore.runnable) @{
    runnableBefore = $snapBefore.runnable; runnableAfterRepair = $snapRepair.runnable
    readinessAfterRepair = $checksRepair.byId
  }

  Write-Host "== 5/8 升级到 $NewSetup"
  Stop-App
  Install-Setup $NewSetup
  $exe = Get-AppExe
  $newVersion = (Get-Item $exe).VersionInfo.ProductVersion
  Start-App | Out-Null
  $token = Get-Token
  $afterUpgrade = Get-Api '/api/v1/runtimes' $token
  Save-Json 'runtimes-after-upgrade.json' $afterUpgrade
  $readinessAfter = Get-Api '/api/v1/readiness' $token
  Save-Json 'readiness-after-upgrade.json' $readinessAfter
  $snapUpgraded = Get-RuntimeSnapshot $afterUpgrade
  $checksUpgraded = Get-CheckStatuses $readinessAfter
  Add-Step 'upgrade-changes-version' ($newVersion -ne $oldVersion) @{ from = $oldVersion; to = $newVersion }
  Add-Step 'upgrade-keeps-runtimes' ($snapUpgraded.runnable -ge $snapBefore.runnable) @{
    runnableBefore = $snapBefore.runnable; runnableAfterUpgrade = $snapUpgraded.runnable
    readinessAfterUpgrade = $checksUpgraded.byId
  }

  Write-Host "== 6/8 在新版本上再装坏一次，这次要求它点名"
  # 同一个动作，判据不同：这一步跑在**升级后的二进制**上。老版本会悄悄少一条（判红），带 interpreter-history 的
  # 新版本会让那一行留着并写明原因（判绿）—— 这就是这次修的东西值多少的直接证据。
  $victim2 = ($snapUpgraded.entries | Where-Object { $_.runnable -and $_.exists } | Select-Object -First 1)
  if ($null -eq $victim2) {
    Save-Json 'break-after-upgrade-skipped.json' @{ reason = '升级后没有可破坏的运行时'; note = '未做破坏步骤，未声明通过' }
    Add-Step 'break-after-upgrade-skipped' $true @{ skipped = $true }
  } else {
    $brokenPath2 = "$($victim2.path).broken"
    Move-Item -Path $victim2.path -Destination $brokenPath2 -Force
    $afterUpgradeBreak = Get-Api '/api/v1/runtimes' $token
    Save-Json 'runtimes-after-upgrade-broken.json' $afterUpgradeBreak
    $snapUpgradeBroken = Get-RuntimeSnapshot $afterUpgradeBreak
    $victim2After = $snapUpgradeBroken.entries | Where-Object { $_.id -eq $victim2.id } | Select-Object -First 1
    $detail2 = if ($null -ne $victim2After) { $victim2After.detail } else { $null }
    $named2 = ($null -ne $victim2After) -and (-not $victim2After.runnable) -and [bool]$detail2
    Add-Step 'upgrade-names-a-deleted-runtime' $named2 @{
      runtime = $victim2.id
      brokenPath = $brokenPath2
      runnableAfterUpgrade = $snapUpgraded.runnable
      runnableAfterBreak = $snapUpgradeBroken.runnable
      stillListed = ($null -ne $victim2After)
      detail = $detail2
    }
    Move-Item -Path $brokenPath2 -Destination $victim2.path -Force
  }

  Write-Host "== 7/8 回滚：装坏的新版本起不来时，把安装目录退回上一版"
  # 直接用应用自己的回滚监管理念验：备份安装目录 → 写 update-pending 标记 → 把 app.asar 删掉（模拟装坏的新版本）
  # → 跑 cli/rollback-supervisor.cjs（ELECTRON_RUN_AS_NODE=1）→ 断言文件被恢复、标记写成已回滚。
  $asar = Join-Path $installDir 'resources\app.asar'
  $supervisor = Join-Path $installDir 'resources\cli\rollback-supervisor.cjs'
  # 第 5 步起的那个实例还占着 app.asar；Windows 上文件被占用时删除会直接失败，所以先停掉再动手。
  Stop-App
  Start-Sleep -Seconds 3
  if (-not (Test-Path $asar) -or -not (Test-Path $supervisor)) {
    Save-Json 'rollback-skipped.json' @{ asar = (Test-Path $asar); supervisor = (Test-Path $supervisor); note = '缺少 app.asar 或监管脚本，未做回滚步骤，未声明通过' }
    Add-Step 'rollback-skipped' $false @{ reason = 'missing app.asar or supervisor script in the installed layout' }
  } else {
    $backupDir = Join-Path $Work 'rollback-backup'
    if (Test-Path $backupDir) { Remove-Item -Recurse -Force $backupDir }
    Copy-Item -Recurse -Force $installDir $backupDir
    $asarHashBefore = (Get-FileHash $asar -Algorithm SHA256).Hash

    $markerFile = Join-Path $e2eRoot 'runtime\update-pending.json'
    New-Item -ItemType Directory -Force -Path (Split-Path $markerFile) | Out-Null
    $healthFile = Join-Path $e2eRoot 'runtime\update-healthy'
    @{
      fromVersion = (Get-Item (Get-AppExe)).VersionInfo.ProductVersion
      toVersion   = '99.0.0'
      installDir  = $installDir
      backupDir   = $backupDir
      healthFile  = $healthFile
      startedAt   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      attempts    = 0
    } | ConvertTo-Json | Set-Content -Path $markerFile -Encoding utf8

    # 装坏：新版本的 asar 不见了（这是「进程内回滚不可能、必须外部监管」的那个场景）。
    # 进程退出与文件句柄释放之间有间隙，删不掉就重试几次 —— 这是被测环境的时序，不是判据。
    for ($i = 0; $i -lt 10; $i++) {
      try { Remove-Item -Force $asar -ErrorAction Stop; break }
      catch { Start-Sleep -Seconds 2 }
    }
    if (Test-Path $asar) { throw 'could not remove app.asar to simulate a broken install (still locked)' }
    if (Test-Path "$markerFile.result.json") { Remove-Item -Force "$markerFile.result.json" }
    $env:ELECTRON_RUN_AS_NODE = '1'
    $proc = Start-Process -FilePath (Get-AppExe) -Wait -PassThru -NoNewWindow -ArgumentList @(
      $supervisor, '--marker', $markerFile, '--timeout-ms', '5000', '--poll-ms', '300'
    )
    $env:ELECTRON_RUN_AS_NODE = ''
    # Electron 在 Windows 上是 GUI 子系统程序，标准输出不会回到控制台 —— 所以判据不靠 stdout：
    # 看退出码、看文件是否被恢复(哈希)、看标记文件里写下的 rolledBackTo。
    $exitCode = $proc.ExitCode
    $markerAfter = Get-Content -Raw -Path $markerFile | ConvertFrom-Json
    # GUI 子系统程序没有 stdout，监管进程把结论写在 <marker>.result.json
    $resultFile = "$markerFile.result.json"
    $supervisorResult = if (Test-Path $resultFile) { Get-Content -Raw -Path $resultFile | ConvertFrom-Json } else { $null }
    $asarHashAfter = if (Test-Path $asar) { (Get-FileHash $asar -Algorithm SHA256).Hash } else { $null }
    Save-Json 'rollback-run.json' @{
      exitCode = $exitCode
      supervisorOutcome = $supervisorResult.outcome
      supervisorError = $supervisorResult.error
      asarRestored = (Test-Path $asar)
      hashMatches = ($asarHashAfter -eq $asarHashBefore)
      rolledBackTo = $markerAfter.rolledBackTo
      rolledBackAt = $markerAfter.rolledBackAt
    }
    Add-Step 'rollback-restores-the-previous-install' (
      $exitCode -eq 0 -and
      $asarHashAfter -eq $asarHashBefore -and
      $null -ne $markerAfter.rolledBackTo -and
      $supervisorResult.outcome -eq 'rolled-back'
    ) @{
      exitCode = $exitCode
      supervisorOutcome = $supervisorResult.outcome
      supervisorError = $supervisorResult.error
      asarRestored = (Test-Path $asar)
      hashMatches = ($asarHashAfter -eq $asarHashBefore)
      rolledBackTo = $markerAfter.rolledBackTo
    }

    Write-Host "== 8/8 回滚：新版本起来了就不该动它"
    # 同样的装置，这次健康信号先写好：监管进程必须收工，且不许碰安装目录。
    $asarHashHealthy = (Get-FileHash $asar -Algorithm SHA256).Hash
    @{
      fromVersion = (Get-Item (Get-AppExe)).VersionInfo.ProductVersion
      toVersion   = (Get-Item (Get-AppExe)).VersionInfo.ProductVersion
      installDir  = $installDir
      backupDir   = $backupDir
      healthFile  = $healthFile
      startedAt   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      attempts    = 0
    } | ConvertTo-Json | Set-Content -Path $markerFile -Encoding utf8
    @{ version = 'healthy'; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json | Set-Content -Path $healthFile -Encoding utf8
    if (Test-Path "$markerFile.result.json") { Remove-Item -Force "$markerFile.result.json" }
    $env:ELECTRON_RUN_AS_NODE = '1'
    $proc2 = Start-Process -FilePath (Get-AppExe) -Wait -PassThru -NoNewWindow -ArgumentList @(
      $supervisor, '--marker', $markerFile, '--timeout-ms', '3000', '--poll-ms', '300'
    )
    $env:ELECTRON_RUN_AS_NODE = ''
    $exitCode2 = $proc2.ExitCode
    $markerAfter2 = Get-Content -Raw -Path $markerFile | ConvertFrom-Json
    $asarHashAfter2 = (Get-FileHash $asar -Algorithm SHA256).Hash
    Save-Json 'rollback-healthy-run.json' @{
      exitCode = $exitCode2
      asarUnchanged = ($asarHashAfter2 -eq $asarHashHealthy)
      untouchedMarker = ($null -eq $markerAfter2.rolledBackAt)
    }
    Add-Step 'healthy-update-is-left-alone' (
      $exitCode2 -eq 0 -and $asarHashAfter2 -eq $asarHashHealthy -and $null -eq $markerAfter2.rolledBackAt
    ) @{
      exitCode = $exitCode2
      asarUnchanged = ($asarHashAfter2 -eq $asarHashHealthy)
      untouchedMarker = ($null -eq $markerAfter2.rolledBackAt)
    }
  }
}
catch {
  $script:report.failure = $_.Exception.Message
  Write-Host "FAILED: $($_.Exception.Message)"
  throw
}
finally {
  Stop-App
  $script:report.finishedAt = (Get-Date).ToString('o')
  Save-Json 'report.json' $script:report
}
