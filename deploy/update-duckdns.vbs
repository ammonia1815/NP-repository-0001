' powershell.exe's -WindowStyle Hidden doesn't reliably suppress the console
' window when launched from Task Scheduler - it still briefly flashes before
' hiding. WScript.Shell.Run with windowStyle 0 launches it truly hidden from
' the start, with no flash at all.
CreateObject("WScript.Shell").Run "powershell.exe -ExecutionPolicy Bypass -File ""C:\AI NPC 0901\deploy\update-duckdns.ps1""", 0, False
