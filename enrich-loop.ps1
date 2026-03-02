# enrich-loop.ps1
# Run from any directory. Ctrl+C to stop.
# Idempotent: safe to restart at any time.
#
# PREREQUISITE: The Grimoire Worker's /admin/enrich-harmonics endpoint
# needs its SQL filter updated to catch empty-object harmonics:
#
#   BEFORE: WHERE harmonics IS NULL
#   AFTER:  WHERE harmonics IS NULL OR harmonics = '{}'
#
# Without this fix, the 22K atoms with harmonics='{}' won't be selected.
# File: grimoire/workers/grimoire/src/index.ts (or wherever the enrich route lives)
# Deploy after fixing: npx wrangler deploy --remote

$url = "https://grimoire.damp-violet-bf89.workers.dev/admin/enrich-harmonics"
$batchSize = 200      # up from 100; Gemini handles it, Worker might not
$body = "{`"limit`": $batchSize}"
$delay = 2            # seconds between successful calls
$errorDelay = 15      # seconds after error (was 30)
$maxRetries = 3       # consecutive errors before backing off harder
$batchNum = 0
$totalEnriched = 0
$totalFailed = 0
$consecutiveErrors = 0
$startTime = Get-Date

Write-Host "Starting enrichment loop (batch=$batchSize, delay=${delay}s)"
Write-Host "Target: atoms with harmonics IS NULL OR harmonics = '{}'"
Write-Host "---"

while ($true) {
    $batchNum++
    try {
        $response = Invoke-RestMethod -Uri $url -Method POST -ContentType "application/json" -Body $body -TimeoutSec 120
        $consecutiveErrors = 0
        $totalEnriched += $response.enriched
        $totalFailed += $response.failed
        $remaining = $response.remaining
        $elapsed = [math]::Round(((Get-Date) - $startTime).TotalMinutes, 1)
        $rate = if ($elapsed -gt 0) { [math]::Round($totalEnriched / $elapsed, 0) } else { 0 }

        Write-Host "[$batchNum] enriched=$($response.enriched) failed=$($response.failed) remaining=$remaining | total=$totalEnriched rate=$rate/min elapsed=${elapsed}m"

        if ($response.enriched -eq 0 -and $remaining -eq 0) {
            Write-Host "`nDone. $totalEnriched enriched, $totalFailed failed in ${elapsed} minutes."
            break
        }

        # If nothing was enriched but remaining > 0, the Worker filter
        # probably still uses IS NULL and can't see the '{}' atoms
        if ($response.enriched -eq 0 -and $remaining -gt 0) {
            Write-Host "`nWARNING: 0 enriched but $remaining remaining."
            Write-Host "The Worker filter likely needs the '{}' fix. See script header."
            break
        }

        Start-Sleep -Seconds $delay
    }
    catch {
        $consecutiveErrors++
        $backoff = if ($consecutiveErrors -ge $maxRetries) { 60 } else { $errorDelay }

        Write-Host "[$batchNum] ERROR ($consecutiveErrors): $($_.Exception.Message) - retrying in ${backoff}s"

        if ($consecutiveErrors -ge ($maxRetries * 2)) {
            Write-Host "`nToo many consecutive errors ($consecutiveErrors). Stopping."
            Write-Host "Total enriched before failure: $totalEnriched"
            break
        }

        Start-Sleep -Seconds $backoff
    }
}
