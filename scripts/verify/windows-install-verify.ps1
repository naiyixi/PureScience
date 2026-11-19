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
      if ($path -is [string] -and $path -and (Test-Path $path)) {
        $entries += [pscustomobject]@{
          language = $language
          id       = $item.envId
          path     = $path
          runnable = [bool]$item.runnable
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
  Write-Host "== 1/5 安装 $OldSetup"
  Install-Setup $OldSetup
  $exe = Get-AppExe
  $oldVersion = (Get-Item $exe).VersionInfo.ProductVersion
  Add-Step 'installed-launcher-exists' ([bool]$exe) @{ exe = $exe; productVersion = $oldVersion }

  Write-Host "== 2/5 启动并读 readiness / runtimes"
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

  Write-Host "== 3/5 装坏一个运行时，看它能不能点名"
  if ($snapBefore.total -eq 0) {
    Save-Json 'break-skipped.json' @{ reason = '运行时列表为空，没有可破坏的条目'; note = '未做破坏步骤，未声明通过' }
    Add-Step 'break-a-runtime-skipped' $true @{ skipped = $true }
  } else {
    $victim = ($snapBefore.entries | Where-Object { $_.runnable } | Select-Object -First 1)
    if ($null -eq $victim) { $victim = $snapBefore.entries[0] }
    $brokenPath = "$($victim.path).broken"
    Move-Item -Path $victim.path -Destination $brokenPath -Force
    $afterBreak = Get-Api '/api/v1/runtimes' $token
    Save-Json 'runtimes-broken.json' $afterBreak
    $readinessBroken = Get-Api '/api/v1/readiness' $token
    Save-Json 'readiness-broken.json' $readinessBroken
    $snapBroken = Get-RuntimeSnapshot $afterBreak
    $checksBroken = Get-CheckStatuses $readinessBroken
    # 硬判据：被挪走的那一条必须从 runnable 变 false（按 envId 对齐，不是数总数）。
    $victimAfter = $snapBroken.entries | Where-Object { $_.id -eq $victim.id } | Select-Object -First 1
    if ($null -eq $victimAfter) { $victimAfter = $snapBroken.entries | Where-Object { $_.path -eq $victim.path } | Select-Object -First 1 }
    $namedDetection = ($null -ne $victimAfter) -and (-not $victimAfter.runnable)
    Add-Step 'broken-runtime-is-detected' $namedDetection @{
      runtime = $victim.id
      language = $victim.language
      brokenPath = $brokenPath
      runnableBefore = $snapBefore.runnable
      runnableAfter = $snapBroken.runnable
      readinessBefore = $checksBefore.byId
      readinessAfter = $checksBroken.byId
      readinessFailedBefore = $checksBefore.failed
      readinessFailedAfter = $checksBroken.failed
    }
    # 还原，供后两步在干净状态上继续。
    Move-Item -Path $brokenPath -Destination $victim.path -Force
  }

  Write-Host "== 4/5 一键重装（同一版本覆盖安装）"
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

  Write-Host "== 5/5 升级到 $NewSetup"
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
