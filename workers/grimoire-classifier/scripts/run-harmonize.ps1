# run-harmonize.ps1
# Runs /harmonize until all categorized atoms have harmonics
# Usage: .\run-harmonize.ps1 -BatchSize 100

param(
  [int]$BatchSize = 100,
  [string]$WorkerUrl = "https://grimoire-classifier.damp-violet-bf89.workers.dev"
)

$batchNum = 0
$totalHarmonized = 0

Write-Host "Harmonizing all categorized atoms (batch size: $BatchSize)"
Write-Host "Worker: $WorkerUrl"
Write-Host "---"

while ($true) {
  $batchNum++
  Write-Host "Batch $batchNum... " -NoNewline

  try {
    $result = Invoke-RestMethod -Method POST `
      -Uri "$WorkerUrl/harmonize?batch_size=$BatchSize" `
      -ContentType "application/json"

    if ($result.message -and $result.message -like "*All categorized*") {
      Write-Host "Done."
      break
    }

    $totalHarmonized += $result.harmonized_count
    Write-Host "input=$($result.input_count) harmonized=$($result.harmonized_count)"

    Start-Sleep -Seconds 2

  } catch {
    Write-Host "ERROR: $_"
    Write-Host "Stopping. Resume by re-running the script."
    break
  }
}

Write-Host "---"
Write-Host "Total harmonized: $totalHarmonized"

$status = Invoke-RestMethod "$WorkerUrl/status"
Write-Host "Final: total=$($status.stats.total) categorized=$($status.stats.categorized) has_harmonics=$($status.stats.has_harmonics)"
