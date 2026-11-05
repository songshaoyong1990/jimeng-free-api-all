# 启动 Windows 原生中继：0.0.0.0:8002 -> 127.0.0.1:8001
param([int]$ListenPort = 8002)
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -ErrorAction SilentlyContinue
if (-not $root) { $root = "e:\projecte\jimeng-free-api-all" }
$script = Join-Path $PSScriptRoot "lan-relay.mjs"
$env:LAN_PORT = "$ListenPort"
Write-Host "启动中继端口 $ListenPort ..."
Write-Host "局域网请访问: http://<本机IP>:$ListenPort"
node $script
