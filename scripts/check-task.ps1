$f = 'C:\Users\xkxxk\AppData\Local\Temp\claude\C--Users-xkxxk-grimoire\be34e3b9-b9fb-4819-8064-2253326c76ba\tasks\b98xujrf9.output'
$c = Get-Content $f
Write-Host ("Total lines: " + $c.Count)
Write-Host ("OK: " + ($c | Where-Object { $_ -match '^\s*\[ok\]' }).Count)
Write-Host ("FAIL: " + ($c | Where-Object { $_ -match '^\s*\[fail\]' }).Count)
Write-Host ("Last write: " + (Get-Item $f).LastWriteTime)
Write-Host ("Now: " + (Get-Date))
Write-Host '--- last 8 lines ---'
$c | Select-Object -Last 8
