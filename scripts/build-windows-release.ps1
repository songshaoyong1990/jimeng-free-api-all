# 构建 Windows 便携版（内置 Node，无需用户安装环境）

$ErrorActionPreference = "Stop"



$ProjectRoot = Split-Path -Parent $PSScriptRoot

$ReleaseRoot = Join-Path $ProjectRoot "release\JimengFreeAPI-Windows"

# 使用有 better-sqlite3 预编译包的 LTS 版本

$NodeVersion = "v22.12.0"

$NodeZip = "node-$NodeVersion-win-x64.zip"

$NodeUrl = "https://nodejs.org/dist/$NodeVersion/$NodeZip"

$CacheDir = Join-Path $ProjectRoot ".pack-cache"

$NodeCacheZip = Join-Path $CacheDir $NodeZip

$NodeFullDir = Join-Path $CacheDir "node-$NodeVersion-win-x64"

$BundledNode = Join-Path $NodeFullDir "node.exe"

$BundledNpm = Join-Path $NodeFullDir "node_modules\npm\bin\npm-cli.js"



Set-Location $ProjectRoot



Write-Host "==> 准备内置 Node $NodeVersion ..."

New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null

if (-not (Test-Path $NodeCacheZip)) {

    Invoke-WebRequest -Uri $NodeUrl -OutFile $NodeCacheZip -UseBasicParsing

}

if (-not (Test-Path $BundledNode)) {

    Expand-Archive -Path $NodeCacheZip -DestinationPath $CacheDir -Force

}

if (-not (Test-Path $BundledNode)) { throw "Node 解压失败: $BundledNode" }



Write-Host "==> 构建程序..."

npm install

if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

npm run build

if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }



Write-Host "==> 准备发布目录..."

if (Test-Path $ReleaseRoot) { Remove-Item $ReleaseRoot -Recurse -Force }

$RuntimeDir = Join-Path $ReleaseRoot "runtime"

$DataDir = Join-Path $ReleaseRoot "data"

New-Item -ItemType Directory -Force -Path $RuntimeDir, $DataDir | Out-Null



Write-Host "==> 复制程序文件..."

$CopyItems = @("dist", "configs", "public", "package.json")

foreach ($item in $CopyItems) {

    $src = Join-Path $ProjectRoot $item

    if (-not (Test-Path $src)) { throw "缺少必要文件: $item" }

    Copy-Item $src -Destination $ReleaseRoot -Recurse -Force

}



Write-Host "==> 在发布目录安装运行时依赖（匹配内置 Node）..."
Set-Location $ReleaseRoot
$OldPath = $env:PATH
$env:PATH = "$NodeFullDir;$OldPath"
try {
    & $BundledNode $BundledNpm install --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "release npm install failed" }
} finally {
    $env:PATH = $OldPath
}

$SqliteNode = Get-ChildItem (Join-Path $ReleaseRoot "node_modules\better-sqlite3") -Recurse -Filter "better_sqlite3.node" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $SqliteNode) { throw "better-sqlite3 原生模块安装失败，请检查网络或重试" }



Write-Host "==> 复制内置 Node 运行时..."

Copy-Item $BundledNode -Destination $RuntimeDir -Force



Write-Host "==> 复制启动脚本..."

$PackDir = Join-Path $ProjectRoot "pack\windows"

$PackFiles = @("StartJimeng.bat", "StopJimeng.bat", "README.txt")

foreach ($file in $PackFiles) {

    $src = Join-Path $PackDir $file

    if (-not (Test-Path $src)) { throw "缺少启动脚本: $file" }

    Copy-Item $src -Destination $ReleaseRoot -Force

}



Write-Host "==> 打包 ZIP..."

Set-Location $ProjectRoot

$ZipPath = Join-Path $ProjectRoot "release\JimengFreeAPI-Windows.zip"

if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }

Compress-Archive -Path $ReleaseRoot -DestinationPath $ZipPath -Force



Write-Host ""

Write-Host "完成！" -ForegroundColor Green

Write-Host "便携版目录: $ReleaseRoot"

Write-Host "压缩包:     $ZipPath"

Write-Host "发给用户: 解压 ZIP 后双击 StartJimeng.bat 即可。"


