' Runs as the interactive user (via a "log on" scheduled task trigger), not
' as a Windows service - LocalSystem repeatedly failed to run Caddy for
' reasons that weren't fully diagnosable through service logs, while running
' as the normal logged-in user has worked reliably every time it was tested
' manually. WScript.Shell.Run with windowStyle 0 keeps this fully invisible,
' same trick as update-duckdns.vbs.
CreateObject("WScript.Shell").Run "powershell.exe -ExecutionPolicy Bypass -Command ""& 'C:\Users\Amm0niA5090\AppData\Local\Microsoft\WinGet\Packages\CaddyServer.Caddy_Microsoft.Winget.Source_8wekyb3d8bbwe\caddy.exe' run --config 'C:\AI NPC 0901\deploy\Caddyfile'""", 0, False
