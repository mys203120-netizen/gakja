param([string]$Ports = '', [string]$ExtraPids = '')
$ErrorActionPreference = 'Stop'
$portNumbers = @($Ports.Split(',') | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
$extraNumbers = @($ExtraPids.Split(',') | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $portNumbers -contains $_.LocalPort } | Select-Object LocalPort, OwningProcess -Unique)
$lookup = @{}
function Read-ProcessIdentity([int]$processNumber) {
  if ($lookup.ContainsKey($processNumber)) { return $lookup[$processNumber] }
  $item = Get-CimInstance Win32_Process -Filter "ProcessId=$processNumber" -ErrorAction SilentlyContinue
  if ($null -eq $item) { return $null }
  $identity = [PSCustomObject]@{ pid = [int]$item.ProcessId; parentPid = [int]$item.ParentProcessId; name = $item.Name; commandLine = $item.CommandLine; createdAt = $item.CreationDate.ToUniversalTime().ToString('o') }
  $lookup[$processNumber] = $identity
  return $identity
}
$rows = @($listeners | ForEach-Object {
  $listener = $_; $chain = @(); $nextNumber = [int]$listener.OwningProcess; $childCreatedAt = $null
  for ($depth = 0; $depth -lt 12 -and $nextNumber -gt 0; $depth++) {
    $identity = Read-ProcessIdentity $nextNumber
    if ($null -eq $identity -or @($chain.pid) -contains $identity.pid) { break }
    if ($null -ne $childCreatedAt -and [datetime]$identity.createdAt -gt [datetime]$childCreatedAt) { break }
    $chain += $identity; $nextNumber = $identity.parentPid; $childCreatedAt = $identity.createdAt
  }
  [PSCustomObject]@{ port = [int]$listener.LocalPort; pid = [int]$listener.OwningProcess; chain = @($chain) }
})
$extra = @($extraNumbers | ForEach-Object { Read-ProcessIdentity $_ } | Where-Object { $null -ne $_ })
[PSCustomObject]@{ listeners = @($rows); processes = @($extra) } | ConvertTo-Json -Depth 6 -Compress
