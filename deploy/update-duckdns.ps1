# Keeps ainpc.duckdns.org pointed at this PC's current public IP.
# DuckDNS's own update endpoint figures out the caller's IP automatically
# (the "ip=" query param can be left blank), so this works from behind NAT
# without needing to separately detect the public IP itself.
$domain = "ainpc"
# Kept in a separate, untracked file (see duckdns-token.txt.example) rather
# than hardcoded here, so this script itself is safe to commit to git.
$token = (Get-Content "$PSScriptRoot\duckdns-token.txt" -Raw).Trim()

try {
    $response = Invoke-RestMethod -Uri "https://www.duckdns.org/update?domains=$domain&token=$token&ip="
    Write-Output "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') DuckDNS update: $response"
} catch {
    Write-Output "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') DuckDNS update FAILED: $_"
}
