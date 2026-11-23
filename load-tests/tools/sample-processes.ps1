# Samples the CPU and memory of Windows processes (the API and worker under load) while a k6 run
# lasts, so a result says whether Node, Postgres or the load generator was the limit. Called by
# run.sh when API_PIDS is set; Windows only (the processes run outside Docker there).
#   powershell -File sample-processes.ps1 -Pids "1234,5678" -Seconds 120 -Out api-cpu.csv
# CPU is in percent of ONE logical processor (200 = two cores busy), over each 2-second interval.
param(
  [Parameter(Mandatory)] [string] $Pids,
  [Parameter(Mandatory)] [int] $Seconds,
  [Parameter(Mandatory)] [string] $Out,
  [int] $IntervalSeconds = 2
)
$ErrorActionPreference = 'Stop'
$ids = @($Pids -split ',' | ForEach-Object { [int]$_ })
'elapsed_s,pid,cpu_pct_of_one_core,working_set_mb' | Set-Content -Encoding ascii $Out
$previous = @{}
foreach ($id in $ids) { $previous[$id] = (Get-Process -Id $id).TotalProcessorTime.TotalMilliseconds }
$clock = [Diagnostics.Stopwatch]::StartNew()
$last = 0.0
while ($clock.Elapsed.TotalSeconds -lt $Seconds) {
  Start-Sleep -Seconds $IntervalSeconds
  $now = $clock.Elapsed.TotalSeconds
  $span = ($now - $last) * 1000
  $last = $now
  foreach ($id in $ids) {
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    $cpu = $p.TotalProcessorTime.TotalMilliseconds
    $pct = ($cpu - $previous[$id]) / $span * 100
    $previous[$id] = $cpu
    $line = [string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0:0},{1},{2:0.0},{3:0}',
      $now, $id, $pct, ($p.WorkingSet64 / 1MB))
    Add-Content -Encoding ascii $Out $line
  }
}
