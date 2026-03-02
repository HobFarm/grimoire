$url = "https://grimoire.damp-violet-bf89.workers.dev/admin/classify-batch"
$batch = 0
$totalClassified = 0
$startTime = Get-Date

while ($true) {
    $batch++
    try {
        $body = '{"limit":25}'
        $response = Invoke-RestMethod -Uri $url -Method POST -ContentType "application/json" -Body $body -TimeoutSec 120
        $totalClassified += $response.classified
        $elapsed = [math]::Round(((Get-Date) - $startTime).TotalMinutes, 1)
        $rate = if ($elapsed -gt 0) { [math]::Round($totalClassified / $elapsed) } else { 0 }
        Write-Host "[$batch] classified=$($response.classified) failed=$($response.failed) remaining=$($response.remaining) | total=$totalClassified rate=$rate/min elapsed=${elapsed}m"

        if ($response.remaining -eq 0) {
            Write-Host "`nDone. $totalClassified atoms classified in ${elapsed}m"
            break
        }

        Start-Sleep -Seconds 5
    }
    catch {
        Write-Host "[$batch] ERROR: $($_.Exception.Message) - retrying in 30s"
        Start-Sleep -Seconds 30
    }
}
