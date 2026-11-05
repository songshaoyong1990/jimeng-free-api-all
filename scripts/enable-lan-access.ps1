#Requires -RunAsAdministrator
<#
.SYNOPSIS
  将局域网 8001 转发到当前 WSL 中的 Docker 服务。
#>

$ErrorActionPreference = "Stop"
$ListenPort = 8001

$wslIp = (wsl -e bash -lc "hostname -I").Trim().Split(" ", [System.StringSplitOptions]::RemoveEmptyEntries)[0]
if (-not $wslIp) { throw "无法获取 WSL IP" }

# 确认 WSL 内服务可用
$probe = wsl -e bash -lc "curl -s --connect-timeout 3 http://127.0.0.1:$ListenPort/ping"
if ($probe -ne "pong") {
  throw "WSL 内服务未就绪（/ping=$probe），请先 docker compose up -d"
}

Write-Host "WSL IP: $wslIp"

# 清理旧规则
@(
  @{ a = "0.0.0.0"; p = $ListenPort },
  @{ a = "127.0.0.1"; p = $ListenPort }
) | ForEach-Object {
  netsh interface portproxy delete v4tov4 listenaddress=$_.a listenport=$_.p 2>$null | Out-Null
}

$lanIps = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object {
    ($_.IPAddress -like "192.168.*" -or $_.IPAddress -like "10.*") -and
    $_.InterfaceAlias -notmatch "WSL|vEthernet|Loopback|Docker|VMware|VirtualBox"
  } |
  Select-Object -ExpandProperty IPAddress -Unique

foreach ($ip in $lanIps) {
  netsh interface portproxy delete v4tov4 listenaddress=$ip listenport=$ListenPort 2>$null | Out-Null
  netsh interface portproxy add v4tov4 listenaddress=$ip listenport=$ListenPort connectaddress=$wslIp connectport=$ListenPort | Out-Null
  Write-Host "转发: ${ip}:$ListenPort -> ${wslIp}:$ListenPort"
}

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort connectaddress=$wslIp connectport=$ListenPort | Out-Null
Write-Host "转发: 0.0.0.0:$ListenPort -> ${wslIp}:$ListenPort"

netsh advfirewall firewall delete rule name="jimeng-free-api-8001" 2>$null | Out-Null
netsh advfirewall firewall add rule name="jimeng-free-api-8001" dir=in action=allow protocol=TCP localport=$ListenPort profile=any | Out-Null

Set-Service iphlpsvc -StartupType Automatic
Restart-Service iphlpsvc -Force

Write-Host ""
netsh interface portproxy show all
Write-Host ""
Write-Host "访问地址:"
foreach ($ip in $lanIps) {
  Write-Host "  http://${ip}:$ListenPort"
  try {
    $r = & curl.exe -s --connect-timeout 3 "http://${ip}:$ListenPort/ping"
    Write-Host "  自测: $r"
  } catch {
    Write-Host "  自测失败"
  }
}
