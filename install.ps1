<#
  install.ps1 — 把 skill-usage hook 装进一个 Codex home（Windows）

  用法：
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -CodexHome D:\codex
    powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall

  做的事：
    1. 找可用的 node；找不到就报错退出（不会留下半成品）
    2. 把 skill-usage-hook.mjs 与 run-skill-usage-hook.cmd 复制到 <CodexHome>\hooks
    3. 合并 <CodexHome>\hooks.json：保留你原有的 hook，只替换/追加本 hook 的两条
       （PreToolUse / SessionStart）；写之前备份成 hooks.json.bak-<时间戳>
    4. 跑一次 --check 自检，并打印下一步（重启会话时选 Trust all）

  原生就认得 CODEX_HOME：装了它，或者用 -CodexHome 指到别处。
#>
[CmdletBinding()]
param(
  [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }),
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$srcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$hookDir = Join-Path $CodexHome 'hooks'
$launcher = Join-Path $hookDir 'run-skill-usage-hook.cmd'
$hookScript = Join-Path $hookDir 'skill-usage-hook.mjs'
$hooksJson = Join-Path $CodexHome 'hooks.json'

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
    (Join-Path $env:ProgramFiles 'nodejs\node.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  $cua = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes\cua_node'
  if (Test-Path $cua) {
    $found = Get-ChildItem -Path $cua -Filter 'node.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.FullName }
  }
  return $null
}

function Read-HooksFile([string]$path) {
  if (-not (Test-Path $path)) {
    $empty = [ordered]@{ hooks = [pscustomobject]@{} }
    return [pscustomobject]$empty
  }
  try {
    # 必须显式按 UTF-8 读：Windows PowerShell 5.1 的 Get-Content 会把无 BOM 的 UTF-8
    # 当 ANSI 解码，中文会被写坏（写完再存回去就不可逆了）。
    $parsed = [IO.File]::ReadAllText($path, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
  } catch {
    throw "$path 不是合法 JSON（$($_.Exception.Message)）。先修好或删掉它，再重跑安装脚本——本脚本不会覆盖看不懂的配置。"
  }
  if (-not ($parsed.PSObject.Properties.Name -contains 'hooks') -or $null -eq $parsed.hooks) {
    $parsed | Add-Member -Force -MemberType NoteProperty -Name hooks -Value ([pscustomobject]@{})
  }
  return $parsed
}

function Get-OurHandler([object]$group, [string]$command) {
  foreach ($handler in @($group.hooks)) {
    if ($handler.PSObject.Properties.Name -contains 'command' -and $handler.command -eq $command) { return $handler }
  }
  return $null
}

function Set-HookEntry([object]$hooks, [string]$event, [string]$command, [int]$timeout, [string]$matcher, [string]$statusMessage) {
  # 先剔除指向本 launcher 的旧条目，再追加，保证重复安装不会留下重复项
  $kept = @()
  if ($hooks.PSObject.Properties.Name -contains $event) {
    foreach ($group in @($hooks.$event)) {
      if (-not (Get-OurHandler $group $command)) { $kept += $group }
    }
  }
  $handler = [ordered]@{ type = 'command'; command = $command; timeout = $timeout }
  if ($statusMessage) { $handler['statusMessage'] = $statusMessage }
  $group = [ordered]@{ matcher = $matcher; hooks = @([pscustomobject]$handler) }
  $kept += [pscustomobject]$group
  $hooks | Add-Member -Force -MemberType NoteProperty -Name $event -Value ([object[]]$kept)
}

function Remove-HookEntry([object]$hooks, [string]$event, [string]$command) {
  if (-not ($hooks.PSObject.Properties.Name -contains $event)) { return }
  $kept = @()
  foreach ($group in @($hooks.$event)) {
    if (-not (Get-OurHandler $group $command)) { $kept += $group }
  }
  if ($kept.Count -eq 0) { $hooks.PSObject.Properties.Remove($event) }
  else { $hooks | Add-Member -Force -MemberType NoteProperty -Name $event -Value ([object[]]$kept) }
}

function Write-JsonUtf8([string]$path, [object]$value) {
  [IO.File]::WriteAllText($path, ($value | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
}

Write-Host "Codex home : $CodexHome"
Write-Host "Launcher   : $launcher"

$node = Find-Node
if (-not $node) {
  throw "找不到 node（PATH / Codex 自带 cua_node / 常见安装位置都没有）。hook 不会工作，先装 Node.js 再重跑。"
}
Write-Host "node       : $node"

if ($Uninstall) {
  if (Test-Path $hooksJson) {
    $config = Read-HooksFile $hooksJson
    Remove-HookEntry $config.hooks 'SessionStart' $launcher
    Remove-HookEntry $config.hooks 'PreToolUse' $launcher
    if (@($config.hooks.PSObject.Properties).Count -eq 0) {
      Remove-Item -LiteralPath $hooksJson -Force
      Write-Host "hooks.json 里没有别的 hook 了，已删除：$hooksJson"
    } else {
      Copy-Item -LiteralPath $hooksJson -Destination "$hooksJson.bak-$((Get-Date).ToString('yyyyMMdd-HHmmss'))" -Force
      Write-JsonUtf8 $hooksJson $config
      Write-Host "已从 hooks.json 移除本 hook（其它 hook 原样保留）"
    }
  }
  foreach ($file in @($hookScript, $launcher)) {
    if (Test-Path $file) { Remove-Item -LiteralPath $file -Force; Write-Host "已删除 $file" }
  }
  Write-Host "日志 / 状态文件没有动：$CodexHome\skill-usage.*（要清就自己删）"
  return
}

New-Item -ItemType Directory -Force -Path $hookDir | Out-Null
foreach ($name in @('skill-usage-hook.mjs', 'run-skill-usage-hook.cmd')) {
  $from = Join-Path $srcDir $name
  if (-not (Test-Path $from)) { throw "源文件缺失：$from" }
  Copy-Item -LiteralPath $from -Destination (Join-Path $hookDir $name) -Force
}
Write-Host "已复制脚本到 $hookDir"

$config = Read-HooksFile $hooksJson
if (Test-Path $hooksJson) {
  $backup = "$hooksJson.bak-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
  Copy-Item -LiteralPath $hooksJson -Destination $backup -Force
  Write-Host "已备份原配置到 $backup"
}
Set-HookEntry $config.hooks 'SessionStart' $launcher 30 'startup|resume|clear' '索引 skill / 插件 / MCP'
Set-HookEntry $config.hooks 'PreToolUse' $launcher 10 '*' ''
Write-JsonUtf8 $hooksJson $config
Write-Host "已写入 $hooksJson"

Write-Host ''
Write-Host '--- 自检（node skill-usage-hook.mjs --check） ---'
$env:CODEX_HOME = $CodexHome
& $node --no-warnings $hookScript --check

Write-Host ''
Write-Host '下一步：'
Write-Host '  1. 重启 Codex 会话；它会提示 hooks 需要确认，选 Trust all and continue（或 CLI 里用 /hooks）'
Write-Host '  2. 会话启动后应出现一行  ⚙️ HOOK ▸ skill-usage  —  已索引 N 技能 / N 插件 / N MCP'
Write-Host '  3. 想调开关：改 <CodexHome>\skill-usage.config.json（改脚本/配置都不用重新信任，只有改 hooks.json 才要）'
