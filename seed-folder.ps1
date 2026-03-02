param([string]$Folder)
$base = "https://grimoire.damp-violet-bf89.workers.dev"

$files = Get-ChildItem -Path $Folder -Filter "*.txt"
Write-Host "Found $($files.Count) files in $Folder`n"

$totalNew = 0
$totalExist = 0
$totalErrors = 0

foreach ($file in $files) {
    Write-Host "=== $($file.Name) ===" -ForegroundColor Cyan
    $lines = Get-Content $file.FullName | Where-Object { $_.Trim() -ne "" }

    $i = 0
    foreach ($line in $lines) {
        $i++
        $text = $line.Trim().Replace('"','\"').Replace("'","''")
        $body = "{`"concept`":`"$text`",`"source_app`":`"seed`"}"
        try {
            $result = Invoke-RestMethod -Method POST -Uri "$base/atoms/decompose" -ContentType "application/json" -Body $body
            $new = $result.atoms_created.Count
            $exist = $result.atoms_existing.Count
            $totalNew += $new
            $totalExist += $exist
            Write-Host "  [$i/$($lines.Count)] $text -> $new new, $exist existing"
        } catch {
            $totalErrors++
            Write-Host "  [$i/$($lines.Count)] ERROR - $text" -ForegroundColor Red
        }
        Start-Sleep -Milliseconds 1500
    }
    Write-Host ""
}

Write-Host "=== SUMMARY ===" -ForegroundColor Green
Write-Host "Files: $($files.Count)"
Write-Host "Atoms created: $totalNew"
Write-Host "Atoms existing: $totalExist"
Write-Host "Errors: $totalErrors"
Write-Host ""
Invoke-RestMethod "$base/atoms/stats"