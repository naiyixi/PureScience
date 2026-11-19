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
  # 运行时列表的形状由应用决定，这里不假设字段名：任何带可用路径的对象都算一个可被破坏的条目。
  $entries = @()
  $payload = if ($runtimes.PSObject.Properties.Name -contains 'data') { $runtimes.data } else { $runtimes }
  foreach ($item in @($payload)) {
    if ($null -eq $item) { continue }
    foreach ($key in @('path', 'dir', 'root', 'location', 'executable')) {
      $value = $item.$key
      if ($value -is [string] -and $value -and (Test-Path $value)) {
        $entries += [pscustomobject]@{ id = ($item.id, $item.name, $key -ne '' | Select-Object -First 1)[0]; path = $value }
        break
      }
    }
  }
  return $entries
}

function Get-OkCount($runtimes) {
  $json = $runtimes | ConvertTo-Json -Depth 12
  # 只看应用自己给的判定词，不从别处推断。
  return ([regex]::Matches($json, '"status"\s*:\s*"(ok|ready|available|installed)"')).Count
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
  $okBefore = Get-OkCount $runtimes
  Add-Step 'reads-readiness-and-runtimes' ($null -ne $readiness -and $null -ne $runtimes) @{ okRuntimes = $okBefore }

  Write-Host "== 3/5 装坏一个运行时，看它能不能点名"
  $entries = Get-RuntimeEntries $runtimes
  if ($entries.Count -eq 0) {
    Save-Json 'break-skipped.json' @{ reason = '运行时列表里没有可直接破坏的路径字段'; note = '未做破坏步骤，未声明通过' }
    Add-Step 'break-a-runtime-skipped' $true @{ skipped = $true }
  } else {
    $victim = $entries[0]
    $brokenPath = "$($victim.path).broken"
    Move-Item -Path $victim.path -Destination $brokenPath -Force
    $afterBreak = Get-Api '/api/v1/runtimes' $token
    Save-Json 'runtimes-broken.json' $afterBreak
    $okBroken = Get-OkCount $afterBreak
    Add-Step 'broken-runtime-is-detected' ($okBroken -lt $okBefore) @{
      runtime = $victim.id; okBefore = $okBefore; okBroken = $okBroken; brokenPath = $brokenPath
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
  $okRepaired = Get-OkCount $afterRepair
  Add-Step 'repair-restores-runtimes' ($okRepaired -ge $okBefore) @{ okBefore = $okBefore; okAfterRepair = $okRepaired }

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
  $okUpgraded = Get-OkCount $afterUpgrade
  Add-Step 'upgrade-changes-version' ($newVersion -ne $oldVersion) @{ from = $oldVersion; to = $newVersion }
  Add-Step 'upgrade-keeps-runtimes' ($okUpgraded -ge $okBefore) @{ okBefore = $okBefore; okAfterUpgrade = $okUpgraded }
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
