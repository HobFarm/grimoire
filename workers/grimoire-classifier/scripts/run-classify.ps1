# run-classify.ps1
# Runs /classify for a specific collection until no uncategorized atoms remain
# Usage: .\run-classify.ps1 -Collection "style" -BatchSize 50

param(
  [Parameter(Mandatory=$true)]
  [string]$Collection,
  [int]$BatchSize = 50,
  [string]$WorkerUrl = "https://grimoire-classifier.damp-violet-bf89.workers.dev"
)

$batchNum = 0
$totalWritten = 0
$totalDropped = 0

Write-Host "Classifying collection: $Collection (batch size: $BatchSize)"
Write-Host "Worker: $WorkerUrl"
Write-Host "---"

while ($true) {
  $batchNum++
  Write-Host "Batch $batchNum... " -NoNewline

  try {
    $result = Invoke-RestMethod -Method POST `
      -Uri "$WorkerUrl/classify?batch_size=$BatchSize&collection=$Collection" `
      -ContentType "application/json"

    if ($result.message -and $result.message -like "*No uncategorized*") {
      Write-Host "Done."
      break
    }

    $totalWritten += $result.written_count
    $totalDropped += $result.dropped
    Write-Host "input=$($result.input_count) written=$($result.written_count) dropped=$($result.dropped)"

    Start-Sleep -Seconds 2

  } catch {
    Write-Host "ERROR: $_"
    Write-Host "Stopping. Resume by re-running the script."
    break
  }
}

Write-Host "---"
Write-Host "Collection $Collection complete: $totalWritten written, $totalDropped dropped"

$status = Invoke-RestMethod "$WorkerUrl/status"
Write-Host "Remaining uncategorized: $($status.stats.uncategorized)"
