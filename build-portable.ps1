<#
  构建便携版（免安装文件夹）

  产出：dist\素材管理器-便携版\
    素材管理器.exe        主程序（Electron 运行时改名而来）
    *.dll / *.pak / *.bin 运行时依赖
    locales\              语言包（已裁剪到中英文，40MB → 1MB）
    resources\app\        程序本体（src + package.json）
    plugins\              插件（随程序走，可自行增删）
    data\                 数据（素材库配置、索引、缩略图）
    使用说明.txt / 启动.cmd

  为什么做成便携版而不是安装包：
    程序零运行时依赖（dependencies 为空），数据目录固定在「程序旁的 data\」，
    所以拷走文件夹就带走全部配置，放 U 盘也能用，卸载 = 删文件夹。

  用法：powershell -ExecutionPolicy Bypass -File build-portable.ps1
#>

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

$electronDir = Join-Path $root 'node_modules\electron\dist'
$out = Join-Path $root 'dist\素材管理器-便携版'
$appName = '素材管理器'

function Write-Step($n, $msg) { Write-Host "[$n/6] $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "      $msg" -ForegroundColor DarkGray }

Write-Host ''
Write-Host '============================================' -ForegroundColor White
Write-Host '  构建便携版素材管理器' -ForegroundColor White
Write-Host '============================================' -ForegroundColor White
Write-Host ''

# ── 前置检查 ──
if (-not (Test-Path (Join-Path $electronDir 'electron.exe'))) {
  Write-Host "[错误] 找不到 Electron 运行时：$electronDir\electron.exe" -ForegroundColor Red
  Write-Host '       请先在项目目录执行：npm install' -ForegroundColor Red
  exit 1
}
if (-not (Test-Path (Join-Path $root 'src\main\index.js'))) {
  Write-Host '[错误] 找不到程序入口 src\main\index.js' -ForegroundColor Red
  exit 1
}

# ── 1. 清理旧产物 ──
Write-Step 1 '清理旧产物…'
if (Test-Path (Join-Path $root 'dist')) {
  try {
    Remove-Item (Join-Path $root 'dist') -Recurse -Force
    Write-Ok '已清理 dist\'
  } catch {
    Write-Host '[错误] 无法清理 dist\，可能便携版正在运行，请先关闭。' -ForegroundColor Red
    exit 1
  }
} else {
  Write-Ok '无旧产物'
}
New-Item -ItemType Directory -Path $out -Force | Out-Null

# ── 2. 复制运行时 ──
Write-Step 2 '复制运行时（约 220 MB，请稍候）…'
$copied = 0
Get-ChildItem $electronDir -File | ForEach-Object {
  Copy-Item $_.FullName -Destination $out -Force
  $copied++
}
Write-Ok "已复制 $copied 个文件"

# 改名成产品名。Electron 按 exe 同目录找资源，改名不影响运行。
$exeSrc = Join-Path $out 'electron.exe'
$exeDst = Join-Path $out "$appName.exe"
if (Test-Path $exeSrc) {
  Move-Item $exeSrc $exeDst -Force
  Write-Ok "electron.exe → $appName.exe"
}

# ── 3. 裁剪语言包 ──
# 只留中英文。Electron 找不到所需语言会回退 en-US，不会崩；
# 这样能从 40 MB 压到约 1 MB。
Write-Step 3 '裁剪语言包…'
$localesOut = Join-Path $out 'locales'
New-Item -ItemType Directory -Path $localesOut -Force | Out-Null
$keep = @('zh-CN.pak', 'zh-TW.pak', 'en-US.pak', 'en-GB.pak')
$keptCount = 0
foreach ($l in $keep) {
  $src = Join-Path $electronDir "locales\$l"
  if (Test-Path $src) { Copy-Item $src -Destination $localesOut -Force; $keptCount++ }
}
$srcTotal = (Get-ChildItem (Join-Path $electronDir 'locales') -File | Measure-Object Length -Sum).Sum
$dstTotal = (Get-ChildItem $localesOut -File | Measure-Object Length -Sum).Sum
Write-Ok ("保留 $keptCount 个语言包：{0:N1} MB → {1:N1} MB" -f ($srcTotal/1MB), ($dstTotal/1MB))

# ── 4. 复制程序本体 ──
# 放进 resources\app\，并**保持与源码相同的目录层级**：
# 主程序里 plugins / data 都用 __dirname 往上两级定位，层级一致就不用改代码。
Write-Step 4 '复制程序本体…'
$appDir = Join-Path $out 'resources\app'
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
Copy-Item (Join-Path $root 'src') -Destination $appDir -Recurse -Force
Copy-Item (Join-Path $root 'package.json') -Destination $appDir -Force
if (Test-Path (Join-Path $root 'README.md')) {
  Copy-Item (Join-Path $root 'README.md') -Destination $appDir -Force
}
$srcSize = (Get-ChildItem (Join-Path $appDir 'src') -Recurse -File | Measure-Object Length -Sum).Sum
Write-Ok ('src 已复制（{0:N0} KB）' -f ($srcSize/1KB))

# ── 5. 复制插件与初始数据 ──
#
# 放在 resources\app\ 下 —— 与源码目录结构**完全一致**。
# 原因：主程序用 __dirname 定位这两处
#     DATA_DIR   = <src/main>/../../data
#     pluginsDir = <src/main>/../../plugins
# 从 resources\app\src\main 往上两级正好是 resources\app\，
# 所以照搬源码结构就不用改任何代码；放便携版根目录反而读不到。
Write-Step 5 '复制插件与初始数据…'
Copy-Item (Join-Path $root 'plugins') -Destination $appDir -Recurse -Force
$pluginCount = (Get-ChildItem (Join-Path $appDir 'plugins') -Directory | Measure-Object).Count
Write-Ok "已复制 $pluginCount 个插件 → resources\app\plugins\"

$dataDir = Join-Path $appDir 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
# 只带设置（素材库路径），不带索引 —— 索引是缓存，里面存的是绝对路径，
# 原样带到新机器可能指向不存在的目录，反而要重扫。首次启动自动重建。
$settingsSrc = Join-Path $root 'data\settings.json'
if (Test-Path $settingsSrc) {
  Copy-Item $settingsSrc -Destination $dataDir -Force
  Write-Ok '已带上 settings.json（不含索引，首次启动会重建）'
} else {
  Write-Ok '无 settings.json，首次启动会新建'
}

# ── 6. 生成启动脚本与说明 ──
Write-Step 6 '生成启动脚本与说明…'

# 启动.cmd 用 GBK 写入：cmd.exe 默认按系统 ANSI 代码页读批处理，
# 写 UTF-8 会让中文路径变乱码。
$launcher = "@echo off`r`ncd /d `"%~dp0`"`r`nstart `"`" `"$appName.exe`"`r`n"
[System.IO.File]::WriteAllText((Join-Path $out '启动.cmd'), $launcher, [System.Text.Encoding]::GetEncoding('GB2312'))

$readme = @"
素材管理器 · 便携版
============================================

【怎么用】
  双击「$appName.exe」即可运行，无需安装。

【便携性】
  所有配置和数据都随程序走（见下方「目录说明」）。
  整个文件夹拷到 U 盘或别的电脑，配置照常保留。
  卸载 = 直接删掉这个文件夹，不留任何系统残留。

【插件】
  插件放在 resources\app\plugins\ 下。没有插件时程序照常运行，
  只是不显示任何文件（因为「什么算素材」完全由插件定义）。
  内置：mmd模型（.pmx/.pmd）、blender工程（.blend）。

  也可以直接在界面里安装插件 zip（「插件」页 → 安装插件）。
  安装第三方插件前请注意：插件以完整权限运行，
  可读写你电脑上的任意文件。请只安装来源可信的插件。

【目录说明】
  素材管理器.exe                主程序
  resources\app\                程序本体
  resources\app\plugins\        插件
  resources\app\data\           数据（见下）
  locales\                      语言包（中/英）

  data\settings.json            素材库路径等设置
  data\index\                   各素材库的索引（首次启动自动生成）
  data\plugin-settings.json     插件自己的设置
  想恢复出厂状态：删掉整个 data\ 文件夹再启动。

【常见问题】
  Q: 双击没反应？
  A: 检查路径里有没有特殊字符；也确认杀毒软件没有拦截。

  Q: 界面显示英文？
  A: 语言包已裁剪到中英文。如需其它语言，从 Electron 官方
     发行的 locales\ 里拷对应 .pak 到本目录 locales\ 下。

  Q: 能放到 Program Files 吗？
  A: 可以运行，但那里默认不可写，设置会存不下来。
     便携版建议放在用户目录或 U 盘里。
"@
[System.IO.File]::WriteAllText((Join-Path $out '使用说明.txt'), $readme, [System.Text.Encoding]::UTF8)
Write-Ok '已生成 启动.cmd 与 使用说明.txt'

# ── 统计 ──
$total = (Get-ChildItem $out -Recurse -File | Measure-Object Length -Sum).Sum

Write-Host ''
Write-Host '============================================' -ForegroundColor Green
Write-Host '  构建完成' -ForegroundColor Green
Write-Host '============================================' -ForegroundColor Green
Write-Host ''
Write-Host "  输出目录: dist\素材管理器-便携版"
Write-Host ("  总大小:   {0:N1} MB" -f ($total/1MB))
Write-Host ''
Write-Host "  运行方式: 双击「$appName.exe」"
Write-Host ''
