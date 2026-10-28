# 安装 dsh-text-tool-call-recovery 插件到 DSH profile
#
# 用法:
#   .\install-stepfix.ps1 [-ProfileDir <path>] [-DshHome <path>]
#
#   -ProfileDir  默认 $DSH_HOME\profiles\desktop
#   -DshHome     默认 $env:DSH_HOME，再回退 $env:USERPROFILE\.dsh
#
# 特性:
#   - 幂等: 重复运行不会重复注册插件条目
#   - 自动备份 cordis.patch.yml 到系统临时目录（不污染仓库）
#   - 安装后自检: 文件存在 / 语法 / patch 条目形态
#   - 不破坏已有 profile 配置

param(
	[string]$ProfileDir,
	[string]$DshHome = $env:DSH_HOME
)
$ErrorActionPreference = "Stop"

# ---- 解析路径 ----
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE ".dsh" }
if (-not $ProfileDir) { $ProfileDir = Join-Path $DshHome "profiles\desktop" }

if (-not (Test-Path $ProfileDir)) {
	Write-Host "ERROR: profile 目录不存在: $ProfileDir" -ForegroundColor Red
	Write-Host "       请确认 DSH 已至少启动过一次，或用 -ProfileDir 指定正确路径。"
	exit 1
}

$patchFile = Join-Path $ProfileDir "cordis.patch.yml"
if (-not (Test-Path $patchFile)) {
	Write-Host "ERROR: 找不到 $patchFile" -ForegroundColor Red
	exit 1
}

$src = $PSScriptRoot
$dest = Join-Path $ProfileDir "node_modules\@zhaozehao10\dsh-text-tool-call-recovery"
$pluginName = "@zhaozehao10/dsh-text-tool-call-recovery"
$entryId = "text-tool-call-recovery"

# 备份目录用系统临时目录（早期版本用仓库内 .tmp，目录不存在会导致 Copy-Item 失败）
$backupDir = Join-Path ([System.IO.Path]::GetTempPath()) "dsh-install-backup"
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Force -Path $backupDir | Out-Null }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

Write-Host "== 1/4 备份 profile 配置 =="
$backupFile = Join-Path $backupDir "cordis.patch.yml.bak-$stamp"
# ---- 友好的错误处理（缺陷 95）----
# 权限不足 / 文件被占用 / 磁盘满时，直接让 .NET 异常冒出来会给用户看
# 一大段 UnauthorizedAccessException 堆栈 —— 他既不知道发生了什么，
# 也不知道怎么修。这里统一捕获，给出**可操作**的提示。
try {
	Copy-Item $patchFile $backupFile -Force -ErrorAction Stop
} catch {
	Write-Host ""
	Write-Host "ERROR: 无法备份 cordis.patch.yml" -ForegroundColor Red
	Write-Host "  源文件: $patchFile"
	Write-Host "  备份到: $backupFile"
	Write-Host "  原因: $($_.Exception.Message)"
	Write-Host ""
	Write-Host "可能的原因与处理方式:" -ForegroundColor Yellow
	Write-Host "  · 文件只读或权限不足 → 右键文件 > 属性 > 取消「只读」，或确认你对 profile 目录有写权限"
	Write-Host "  · 文件被其他程序占用 → 完全退出 DeepSeek Harness 后重试"
	Write-Host "  · 磁盘空间不足     → 清理磁盘后重试"
	Write-Host ""
	Write-Host "尚未修改任何配置，可以安全重试。" -ForegroundColor Green
	exit 1
}
Write-Host "   backup -> $backupFile"

# ---- 备份轮转（缺陷 96）----
# 早期版本每次运行都新建备份但**从不清理**，实测累积到 1114 个文件。
# 长期使用会无限增长。这里保留最近 $KeepBackups 个，其余删除。
# **位置很关键**：必须在**创建完本次备份之后**执行，否则本次备份
# 会被自己删掉，或留下 11 个（先轮转再创建）。
# 只删本脚本自己产生的 `cordis.patch.yml.bak-*`，不动目录里的其他文件。
$KeepBackups = 10
try {
	$oldBackups = @(Get-ChildItem -Path $backupDir -Filter "cordis.patch.yml.bak-*" -File -ErrorAction SilentlyContinue |
		Sort-Object LastWriteTime -Descending |
		Select-Object -Skip $KeepBackups)
	if ($oldBackups.Count -gt 0) {
		$oldBackups | Remove-Item -Force -ErrorAction SilentlyContinue
		Write-Host "   pruned $($oldBackups.Count) old backup(s) (keeping newest $KeepBackups)"
	}
} catch {
	# 轮转失败不应阻断安装 —— 只是磁盘占用，不影响正确性
	Write-Host "   (backup rotation skipped: $($_.Exception.Message))"
}

Write-Host "== 2/4 复制插件到 profile/node_modules =="
try {
	if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Force -Path $dest -ErrorAction Stop | Out-Null }
	Copy-Item (Join-Path $src "lib") $dest -Recurse -Force -ErrorAction Stop
	Copy-Item (Join-Path $src "package.json") $dest -Force -ErrorAction Stop
} catch {
	Write-Host ""
	Write-Host "ERROR: 无法复制插件到 profile" -ForegroundColor Red
	Write-Host "  目标: $dest"
	Write-Host "  原因: $($_.Exception.Message)"
	Write-Host ""
	Write-Host "可能的原因与处理方式:" -ForegroundColor Yellow
	Write-Host "  · 目标目录权限不足 → 确认你对 $ProfileDir\node_modules 有写权限"
	Write-Host "  · 旧版本文件被占用 → 完全退出 DeepSeek Harness 后重试"
	Write-Host ""
	Write-Host "配置文件备份已完成，尚未修改 cordis.patch.yml。" -ForegroundColor Green
	exit 1
}
Write-Host "   installed -> $dest"

Write-Host "== 3/4 注册插件条目到 cordis.patch.yml（幂等） =="
# ---- 编码处理（缺陷 93）----
# cordis.patch.yml 是 UTF-8 **无 BOM** 且可能含非 ASCII 字符（例如模型名里的
# 中文）。PowerShell 5.1 的 `Get-Content -Raw` 在**不指定 -Encoding** 时按
# ANSI（中文系统是 GBK / 代码页 936）解码，随后 `WriteAllText` 再以 UTF-8
# 写回 —— 中文会被**永久损坏**（实测：「书生专用」→「涔︾敓涓撶敤」）。
#
# 正确做法：用 .NET 显式按 UTF-8 读写，并**保留原有 BOM 状态**，
# 避免改变文件编码影响其他工具。
$patchBytes = [System.IO.File]::ReadAllBytes($patchFile)
$hadBom = ($patchBytes.Length -ge 3 -and $patchBytes[0] -eq 0xEF -and $patchBytes[1] -eq 0xBB -and $patchBytes[2] -eq 0xBF)
$patch = [System.Text.Encoding]::UTF8.GetString($patchBytes)
if ($hadBom) { $patch = $patch.TrimStart([char]0xFEFF) }

if ($patch -match $entryId) {
	Write-Host "   entry already present, skip"
} else {
	$nl = [Environment]::NewLine
	$block = "- insert:" + $nl + "    - id: " + $entryId + $nl + "      name: " + [char]34 + $pluginName + [char]34 + $nl
	if (-not $patch.EndsWith($nl)) { $patch += $nl }
	$patch += $block
	# 以 UTF-8 写回，BOM 状态与原始文件保持一致
	$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
	$outText = if ($hadBom) { [char]0xFEFF + $patch } else { $patch }
	# 友好的错误处理（缺陷 95）：写回失败时给出可操作提示，并告知备份位置
	try {
		[System.IO.File]::WriteAllText($patchFile, $outText, $utf8NoBom)
	} catch {
		Write-Host ""
		Write-Host "ERROR: 无法写入 cordis.patch.yml" -ForegroundColor Red
		Write-Host "  文件: $patchFile"
		Write-Host "  原因: $($_.Exception.Message)"
		Write-Host ""
		Write-Host "可能的原因与处理方式:" -ForegroundColor Yellow
		Write-Host "  · 文件只读或权限不足 → 右键文件 > 属性 > 取消「只读」后重试"
		Write-Host "  · 文件被其他程序占用 → 完全退出 DeepSeek Harness 后重试"
		Write-Host ""
		Write-Host "插件文件已复制完成，但**配置未修改** —— 插件不会生效。" -ForegroundColor Yellow
		Write-Host "原始配置的备份在: $backupFile" -ForegroundColor Green
		exit 1
	}
	Write-Host "   entry appended (insert form)"
}

Write-Host "== 4/4 自检 =="
$ok = $true
foreach ($f in @((Join-Path $dest "package.json"), (Join-Path $dest "lib\index.js"))) {
	if (Test-Path $f) {
		Write-Host "   OK $f"
	} else {
		Write-Host "   MISSING $f" -ForegroundColor Red
		$ok = $false
	}
}

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
	& $nodeCmd.Source --check (Join-Path $dest "lib\index.js")
	if ($LASTEXITCODE -ne 0) {
		Write-Host "   syntax check FAILED" -ForegroundColor Red
		$ok = $false
	} else {
		Write-Host "   OK syntax"
	}
} else {
	Write-Host "   (node 不在 PATH，跳过语法检查)"
}

# 自检 patch 条目形态：必须包在 insert: 下（普通条目会被静默跳过）
# 同样显式按 UTF-8 读取（缺陷 93）：这里只读不写，但若用 ANSI 解码，
# 含非 ASCII 的条目可能匹配失败，导致**假报警**。
$final = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($patchFile))
$hasInsert = $final -match "- insert:"
$hasId = $final -match ("id: " + $entryId)
$hasName = $final.Contains($pluginName)
if ($hasInsert -and $hasId -and $hasName) {
	Write-Host "   OK patch entry present (insert form)"
} else {
	Write-Host "   patch entry check FAILED (insert=" + $hasInsert + " id=" + $hasId + " name=" + $hasName + ")" -ForegroundColor Red
	$ok = $false
}

if ($ok) {
	Write-Host ""
	Write-Host "INSTALL OK - 请重启 DeepSeek Harness 使插件生效" -ForegroundColor Green
	Write-Host "  备份位置: $backupFile"
	exit 0
} else {
	Write-Host ""
	Write-Host "INSTALL INCOMPLETE - 请检查上方输出" -ForegroundColor Red
	exit 1
}
