$Base = "http://app.127.0.0.1.nip.io"

function Get-AdminPassword {
  (Select-String -Path charts\platform\secrets.local.yaml -Pattern '^\s+adminPassword:' | Select-Object -Last 1).Line.Split(':',2)[1].Trim().Trim('"')
}
function Invoke-Login($Email, $Password, $Jar) {
  $f = Join-Path $env:TEMP "login.json"
  Set-Content -Encoding ascii $f (@{ email = $Email; password = $Password } | ConvertTo-Json -Compress)
  curl.exe -s -c $Jar -H "Content-Type: application/json" --data "@$f" "$Base/api/login"
  Remove-Item $f -ErrorAction SilentlyContinue
}
function New-ApiKey($Jar) { (curl.exe -s -X POST -b $Jar "$Base/api/keys" | ConvertFrom-Json).key }
function New-Member($Jar, $Email, $Password) {
  $f = Join-Path $env:TEMP "member.json"
  Set-Content -Encoding ascii $f (@{ email = $Email; password = $Password } | ConvertTo-Json -Compress)
  curl.exe -s -b $Jar -H "Content-Type: application/json" --data "@$f" "$Base/api/members"
  Remove-Item $f -ErrorAction SilentlyContinue
}
function Invoke-Mcp($Key, $Method, $Params) {
  $body = @{ jsonrpc = "2.0"; id = 1; method = $Method }
  if ($null -ne $Params) { $body["params"] = $Params }
  $f = Join-Path $env:TEMP "mcp.json"
  Set-Content -Encoding ascii $f ($body | ConvertTo-Json -Depth 10 -Compress)
  $raw = (curl.exe -s -H "Authorization: Bearer $Key" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" --data "@$f" "$Base/mcp") -join "`n"
  Remove-Item $f -ErrorAction SilentlyContinue
  $data = @($raw -split "`n" | Where-Object { $_ -like 'data:*' })
  if ($data.Count -gt 0) { $data[0].Substring(5) | ConvertFrom-Json } else { $raw }
}
function Get-Tools($Key) {
  $r = Invoke-Mcp $Key "tools/list" $null
  if ($r.result) { $r.result.tools | ForEach-Object { $_.name } } else { $r }
}
function Invoke-Tool($Key, $Name, $Arguments) {
  if ($null -eq $Arguments) { $Arguments = @{} }
  $r = Invoke-Mcp $Key "tools/call" @{ name = $Name; arguments = $Arguments }
  if ($r.result) { $r.result.content[0].text } else { $r }
}
function Invoke-Chat($Jar, $Text) {
  $f = Join-Path $env:TEMP "chat.json"
  Set-Content -Encoding ascii $f (@{ messages = @(@{ role = "user"; content = $Text }) } | ConvertTo-Json -Depth 5 -Compress)
  $r = curl.exe -s -b $Jar -H "Content-Type: application/json" --data "@$f" "$Base/api/chat" | ConvertFrom-Json
  Remove-Item $f -ErrorAction SilentlyContinue
  $r.answer
  $r.toolCalls | Select-Object name, ok, durationMs | Format-Table -AutoSize
}
function Show-Audit($Jar, $Limit = 15) {
  (curl.exe -s -b $Jar "$Base/api/audit?limit=$Limit" | ConvertFrom-Json).entries |
    Select-Object startedAt, userEmail, source, serverSlug, tool, outcome, errorMessage | Format-Table -AutoSize
}
function Get-Servers($Jar) { (curl.exe -s -b $Jar "$Base/api/servers" | ConvertFrom-Json).servers }
function Set-ServerEnabled($Jar, $Slug, [bool]$Enabled) {
  $s = Get-Servers $Jar | Where-Object { $_.slug -eq $Slug }
  $f = Join-Path $env:TEMP "enable.json"
  Set-Content -Encoding ascii $f (@{ enabled = $Enabled } | ConvertTo-Json -Compress)
  curl.exe -s -X PATCH -b $Jar -H "Content-Type: application/json" --data "@$f" "$Base/api/servers/$($s.id)"
  Remove-Item $f -ErrorAction SilentlyContinue
}
