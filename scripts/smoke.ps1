# End-to-end smoke test, all providers mocked (free, offline).
# Usage: npm run build; powershell -ExecutionPolicy Bypass -File scripts\smoke.ps1 [-Port 3921]
# Uses a throwaway DB and storage folder under %TEMP%\recallcast-smoke. Never reads .env.local values:
# provider modes and paths are forced through process env vars, which take precedence.
param([int]$Port = 3921)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path $env:TEMP 'recallcast-smoke'
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory -Force $work | Out-Null

# All providers mocked; isolated DB and storage. Process env beats .env files in Next.
$env:YOUTUBE_PROVIDER = 'mock'; $env:TRANSCRIPT_PROVIDER = 'mock'
$env:AI_PROVIDER = 'mock'
$env:ANTHROPIC_API_KEY = ''; $env:YOUTUBE_API_KEY = ''
$env:DATABASE_PATH = (Join-Path $work 'smoke.db')
$env:STORAGE_DIR = (Join-Path $work 'storage')
$env:WORKER_ENABLED = '1'
$env:APP_URL = "http://localhost:$Port"

$base = "http://localhost:$Port"
$results = New-Object System.Collections.Generic.List[string]
$fail = 0
function Check($name, $ok, $detail) {
  $s = if ($ok) { 'PASS' } else { 'FAIL' }
  if (-not $ok) { $script:fail++ }
  $line = "[$s] $name - $detail"
  $script:results.Add($line); Write-Output $line
}
$jarA = Join-Path $work 'a.txt'; $jarB = Join-Path $work 'b.txt'
function Invoke-Curl([string[]]$a) { & curl.exe -s @a }
function JsonFile($obj) { $f = Join-Path $work ([guid]::NewGuid().ToString() + '.json'); [IO.File]::WriteAllText($f, ($obj | ConvertTo-Json -Compress)); return $f }
function Post($path, $obj, $jar) {
  $f = JsonFile $obj
  $out = Invoke-Curl @('-o', (Join-Path $work 'body.txt'), '-w', '%{http_code}', '-b', $jar, '-c', $jar, '-H', 'Content-Type: application/json', '-H', "Origin: $base", '-X', 'POST', '--data-binary', "@$f", "$base$path")
  return @{ code = [int]$out; body = (Get-Content -Raw (Join-Path $work 'body.txt') -ErrorAction SilentlyContinue) }
}
# Same as Post for any method (PATCH, DELETE); $obj may be $null for a request without a body.
function Send($method, $path, $obj, $jar, $origin = $base) {
  $a = @('-o', (Join-Path $work 'body.txt'), '-w', '%{http_code}', '-b', $jar, '-c', $jar, '-H', "Origin: $origin", '-X', $method)
  if ($null -ne $obj) { $f = JsonFile $obj; $a += @('-H', 'Content-Type: application/json', '--data-binary', "@$f") }
  $a += "$base$path"
  $out = Invoke-Curl $a
  return @{ code = [int]$out; body = (Get-Content -Raw (Join-Path $work 'body.txt') -ErrorAction SilentlyContinue) }
}
# An episode is a clip: whole seconds start < end, 1-255 s long, or the whole video when it is short.
function ClipOk($ep, $videos) {
  if (-not $ep -or -not $ep.clip -or -not $ep.youtubeVideoId) { return $false }
  $s = $ep.clip.start; $e = $ep.clip.end; $dur = $ep.durationS
  if ($null -eq $s -or $null -eq $e -or $s -lt 0 -or $e -le $s) { return $false }
  if ($dur -ne ($e - $s)) { return $false }
  $v = @($videos | Where-Object { $_.id -eq $ep.videoId })[0]
  $whole = $v -and $s -eq 0 -and $e -eq $v.durationS
  return (($dur -ge 1 -and $dur -le 255) -or $whole)
}
function GetU($path, $jar, [string[]]$extra = @()) {
  $args2 = @('-o', (Join-Path $work 'body.txt'), '-w', '%{http_code}')
  if ($jar) { $args2 += @('-b', $jar, '-c', $jar) }
  $args2 += $extra; $args2 += "$base$path"
  $out = Invoke-Curl $args2
  return @{ code = [int]$out; body = (Get-Content -Raw (Join-Path $work 'body.txt') -ErrorAction SilentlyContinue) }
}

$log = Join-Path $work 'server.log'; $errlog = Join-Path $work 'server.err.log'
$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "npx next start -p $Port" -WorkingDirectory $root -RedirectStandardOutput $log -RedirectStandardError $errlog -PassThru -WindowStyle Hidden
$proc2 = $null
try {
  $up = $false
  for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Milliseconds 500; $h = GetU '/api/health' $null; if ($h.code -eq 200) { $up = $true; break } }
  Check 'server up (/api/health)' $up "health=$($h.code) $($h.body)"
  if (-not $up) { throw 'server did not start' }

  $r = GetU '/api/playlists' $null
  Check 'unauthenticated GET /api/playlists -> 401' ($r.code -eq 401) "$($r.code) $($r.body)"
  $r = GetU '/app' $null
  Check 'unauthenticated /app -> 307 to /login' ($r.code -eq 307) "$($r.code)"

  $emailA = "smoke-a-$([guid]::NewGuid().ToString('N').Substring(0,8))@example.com"
  $r = Post '/api/auth/signup' @{ email = $emailA; password = 'correct-horse-9' } $jarA
  Check 'signup -> 201' ($r.code -eq 201) "$($r.code) $($r.body)"
  Remove-Item $jarA -ErrorAction SilentlyContinue
  $r = Post '/api/auth/login' @{ email = $emailA; password = 'wrong-password' } $jarA
  Check 'login wrong password -> 401' ($r.code -eq 401) "$($r.code) $($r.body)"
  $r = Post '/api/auth/login' @{ email = $emailA; password = 'correct-horse-9' } $jarA
  Check 'login -> 200' ($r.code -eq 200) "$($r.code) $($r.body)"
  $r = GetU '/api/me' $jarA
  Check 'GET /api/me with cookie -> 200' ($r.code -eq 200 -and $r.body -match [regex]::Escape($emailA)) "$($r.code)"

  $r = Post '/api/playlists' @{ url = 'not a url' } $jarA
  Check 'POST /api/playlists bad url -> 400' ($r.code -eq 400) "$($r.code) $($r.body)"
  $r = Post '/api/playlists' @{ url = 'https://www.youtube.com/playlist?list=PLsmokeTest12345' } $jarA
  Check 'POST /api/playlists -> 201' ($r.code -eq 201) "$($r.code) $($r.body)"
  $pid1 = ($r.body | ConvertFrom-Json).id

  $sw = [Diagnostics.Stopwatch]::StartNew(); $status = ''; $d = $null
  while ($sw.Elapsed.TotalSeconds -lt 120) {
    $g = GetU "/api/playlists/$pid1" $jarA
    if ($g.code -eq 200) { $d = $g.body | ConvertFrom-Json; $status = $d.playlist.status; if ($status -in @('ready', 'partial', 'failed')) { break } }
    Start-Sleep -Seconds 2
  }
  Check 'playlist reaches ready within 120s' ($status -eq 'ready') "status=$status after $([int]$sw.Elapsed.TotalSeconds)s; progress=$($d.progress | ConvertTo-Json -Compress)"
  $eps = @($d.episodes)
  $vids = @($d.videos)
  Check 'one episode per video' ($eps.Count -eq 3 -and $eps.Count -eq @($vids | Where-Object { $_.status -eq 'ready' }).Count) "episodes=$($eps.Count) videos=$($vids.Count) ready=$(@($vids | Where-Object { $_.status -eq 'ready' }).Count)"
  $badClips = @($eps | Where-Object { -not (ClipOk $_ $vids) })
  Check 'episodes: clip.start/end, youtubeVideoId, durationS 1-255 or whole video' ($eps.Count -gt 0 -and $badClips.Count -eq 0) "clips=$(($eps | ForEach-Object { "$($_.clip.start)-$($_.clip.end)/$($_.durationS)s" }) -join ',')"
  Check 'mock AI -> heuristic pick with title and summary' (-not ($eps | Where-Object { $_.clip.picked -ne 'heuristic' -or -not $_.clip.title -or -not $_.clip.summary })) "picked=$(($eps | ForEach-Object { $_.clip.picked }) -join ',')"
  $stale = @($eps | Where-Object { $_.audioUrl -or $_.script -or $_.kind -eq 'recap' }) + @($vids | Where-Object { $_.knowledge })
  Check 'no removed fields (audioUrl, script, recap, knowledge)' ($stale.Count -eq 0) "stale=$($stale.Count)"

  # Reels: each video's one-minute moments (mock AI = the heuristic), cut by a job after the episode.
  $sw = [Diagnostics.Stopwatch]::StartNew(); $feed = $null
  while ($sw.Elapsed.TotalSeconds -lt 60) {
    $g = GetU "/api/reels?playlist=$pid1" $jarA
    if ($g.code -eq 200) { $feed = $g.body | ConvertFrom-Json; if ($feed.pending -eq 0 -and $feed.total -gt 0) { break } }
    Start-Sleep -Seconds 1
  }
  $reels = @($feed.reels)
  Check 'reels are cut for every video' ($reels.Count -ge 3 -and $feed.pending -eq 0 -and $feed.total -eq $reels.Count) "total=$($feed.total) pending=$($feed.pending) videos=$($feed.videos)"
  $badReels = @($reels | Where-Object { ($_.end - $_.start) -lt 30 -or ($_.end - $_.start) -gt 80 -or -not $_.hook -or -not $_.youtubeVideoId -or @($_.captions).Count -eq 0 -or $_.picked -ne 'heuristic' -or $_.basis -ne 'transcript' })
  Check 'reels: 30-80 s windows with a hook and captions' ($badReels.Count -eq 0) "windows=$(($reels | ForEach-Object { "$($_.start)-$($_.end)" }) -join ',')"
  $d = (GetU "/api/playlists/$pid1" $jarA).body | ConvertFrom-Json
  Check 'playlist detail counts its reels' ($d.reels.ready -eq $reels.Count -and $d.reels.pending -eq 0 -and $null -eq $d.shareSlug) "reels=$($d.reels | ConvertTo-Json -Compress)"
  $reel = $reels[0]
  $r = Send 'PATCH' "/api/reels/$($reel.id)" @{ saved = $true } $jarA
  Check 'PATCH reel saved -> 200' ($r.code -eq 200 -and ($r.body | ConvertFrom-Json).saved -eq $true) "$($r.code) $($r.body)"
  $g = GetU '/api/reels?saved=1' $jarA
  Check 'saved feed lists it' ($g.code -eq 200 -and ($g.body | ConvertFrom-Json).total -eq 1) "$($g.code)"
  $r = Send 'PATCH' "/api/reels/$($reel.id)" @{ seen = $true } $jarA
  $g = GetU "/api/reels?playlist=$pid1" $jarA
  $order = @(($g.body | ConvertFrom-Json).reels)
  Check 'a seen reel moves behind the unseen ones' ($r.code -eq 200 -and $order[-1].id -eq $reel.id -and $order[-1].seen -eq $true) "last=$($order[-1].id -eq $reel.id)"
  $r = Send 'PATCH' "/api/reels/$($reel.id)" @{ saved = $true } $jarA 'https://evil.example'
  Check 'cross-origin PATCH reel -> 403' ($r.code -eq 403) "$($r.code)"
  $r = Send 'PATCH' "/api/reels/$($reel.id)" @{ seen = $false } $jarA
  Check 'PATCH reel bad body -> 400' ($r.code -eq 400) "$($r.code) $($r.body)"
  # Viewing reports (seconds played, played to the end, swiped away early) order the owner's feed.
  $r = Send 'PATCH' "/api/reels/$($reels[1].id)" @{ watched = 12.5; completed = $true } $jarA
  $r2 = Send 'PATCH' "/api/reels/$($reels[1].id)" @{ watched = 9999 } $jarA
  Check 'PATCH reel viewing report -> 200, out of range -> 400' ($r.code -eq 200 -and ($r.body | ConvertFrom-Json).seen -eq $true -and $r2.code -eq 400) "$($r.code) $($r.body) / $($r2.code)"

  # Share links: public by slug, no account needed, indexable (canonical link), revocable.
  $r = Send 'POST' "/api/reels/$($reel.id)/share" @{} $jarA
  $slug = ($r.body | ConvertFrom-Json).slug
  Check 'POST reel share -> 200 with a 22-char slug' ($r.code -eq 200 -and $slug -match '^[A-Za-z0-9_-]{22}$') "$($r.code) $($r.body)"
  $g = GetU "/r/$slug" $null
  $indexable = $g.body -match '<meta name="robots" content="index, follow"' -and $g.body -match ('<link rel="canonical" href="' + [regex]::Escape("$base/r/$slug") + '"')
  Check 'shared reel /r/<slug> -> 200 signed out, indexable, canonical link' ($g.code -eq 200 -and $indexable -and $g.body -notmatch 'Application error|__next_error__' -and $g.body -notmatch [regex]::Escape($emailA)) "$($g.code) bytes=$($g.body.Length) indexable=$indexable"
  $r = Send 'POST' "/api/playlists/$pid1/share" @{} $jarA
  $feedSlug = ($r.body | ConvertFrom-Json).slug
  $g = GetU "/r/$feedSlug" $null
  Check 'shared playlist feed /r/<slug> -> 200 signed out' ($r.code -eq 200 -and $g.code -eq 200 -and $feedSlug -ne $slug) "$($r.code) $($g.code)"
  $g = GetU '/robots.txt' $null
  Check 'robots.txt: app and API closed, sitemap named' ($g.code -eq 200 -and $g.body -match 'Disallow: /app/' -and $g.body -match 'Disallow: /api/' -and $g.body -match ('Sitemap: ' + [regex]::Escape("$base/sitemap.xml"))) "$($g.code) $(($g.body -split "`n") -join ' | ')"
  $g = GetU '/sitemap.xml' $null
  Check 'sitemap.xml lists the landing page and no shared links' ($g.code -eq 200 -and $g.body -match ('<loc>' + [regex]::Escape("$base/") + '</loc>') -and $g.body -notmatch '/r/') "$($g.code) bytes=$($g.body.Length)"
  $g = GetU '/' $null
  Check 'landing page without SAMPLE_FEED offers no sample' ($g.code -eq 200 -and $g.body -notmatch 'Watch a sample feed' -and $g.body -notmatch 'href="/r/') "$($g.code)"

  # SAMPLE_FEED: a second server on the same database, started with the copied link (no worker).
  $port2 = $Port + 1; $base2 = "http://localhost:$port2"
  $env:SAMPLE_FEED = "$base/r/$feedSlug"; $env:WORKER_ENABLED = '0'
  $proc2 = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "npx next start -p $port2" -WorkingDirectory $root -RedirectStandardOutput (Join-Path $work 'server2.log') -RedirectStandardError (Join-Path $work 'server2.err.log') -PassThru -WindowStyle Hidden
  $env:SAMPLE_FEED = ''; $env:WORKER_ENABLED = '1'
  $up2 = $false
  for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Milliseconds 500; if ((Invoke-Curl @('-o', 'NUL', '-w', '%{http_code}', "$base2/api/health")) -eq '200') { $up2 = $true; break } }
  $home2 = (Invoke-Curl @("$base2/")) -join "`n"
  $map2 = (Invoke-Curl @("$base2/sitemap.xml")) -join "`n"
  Check 'landing page with SAMPLE_FEED links to the sample feed' ($up2 -and $home2 -match 'Watch a sample feed' -and $home2 -match ('href="/r/' + [regex]::Escape($feedSlug) + '"') -and $home2 -match 'Watch all \d+ reels') "up=$up2 bytes=$($home2.Length)"
  Check 'sitemap.xml with SAMPLE_FEED lists the sample feed' ($map2 -match ('<loc>' + [regex]::Escape("$base/r/$feedSlug") + '</loc>')) "bytes=$($map2.Length)"

  $r = Send 'DELETE' "/api/reels/$($reel.id)/share" $null $jarA
  $g = GetU "/r/$slug" $null
  Check 'revoked share -> 204, then /r/<slug> -> 404 and noindex' ($r.code -eq 204 -and $g.code -eq 404 -and $g.body -match 'noindex') "$($r.code) $($g.code)"
  $r = Send 'DELETE' "/api/playlists/$pid1/share" $null $jarA
  $home2 = (Invoke-Curl @("$base2/")) -join "`n"
  Check 'sample feed revoked -> landing page drops it' ($r.code -eq 204 -and $home2 -match 'Create an account' -and $home2 -notmatch 'Watch a sample feed' -and $home2 -notmatch 'href="/r/') "$($r.code) bytes=$($home2.Length)"
  & taskkill.exe /PID $proc2.Id /T /F | Out-Null; $proc2 = $null
  $r = Send 'POST' "/api/playlists/$pid1/share" @{} $jarA
  $feedSlug = ($r.body | ConvertFrom-Json).slug
  Check 'sharing the playlist again makes a new link' ($r.code -eq 200 -and $feedSlug -match '^[A-Za-z0-9_-]{22}$') "$($r.code)"
  $g = GetU '/r/AAAAAAAAAAAAAAAAAAAAAA' $null
  Check 'unknown share slug -> 404' ($g.code -eq 404) "$($g.code)"
  $g = GetU '/app/reels' $jarA
  Check 'HTML /app/reels -> 200, no error markers' ($g.code -eq 200 -and $g.body -notmatch 'Application error|__next_error__') "$($g.code) bytes=$($g.body.Length)"
  $g = GetU '/api/reels' $null
  Check 'unauthenticated GET /api/reels -> 401' ($g.code -eq 401) "$($g.code)"

  $hdr = Join-Path $work 'hdr.txt'
  $code = Invoke-Curl @('-o', 'NUL', '-D', $hdr, '-w', '%{http_code}', '-b', $jarA, "$base/app/p/$pid1")
  $hdrs = Get-Content -Raw $hdr
  Check 'CSP allows the YouTube player' ([int]$code -eq 200 -and $hdrs -match 'frame-src[^;]*https://www\.youtube-nocookie\.com' -and $hdrs -match 'script-src[^;]*https://www\.youtube\.com') "$code"

  foreach ($p in @('/', '/login', '/signup', '/app', "/app/p/$pid1")) {
    $j = if ($p -in @('/', '/login', '/signup')) { $null } else { $jarA }
    $g = GetU $p $j
    $bad = $g.body -match 'Application error|Internal Server Error|__next_error__|Unhandled Runtime Error'
    $ok = $g.code -eq 200 -and -not $bad
    if ($p -in @('/login', '/signup') -and $j) { $ok = $g.code -in @(200, 307) }
    Check "HTML $p -> 200, no error markers" $ok "$($g.code) bytes=$($g.body.Length) errorMarker=$bad"
  }
  $g = GetU '/app/p/00000000-0000-4000-8000-000000000000' $jarA
  Check '/app/p/<unknown> -> 404' ($g.code -eq 404) "$($g.code)"

  # Second user
  $emailB = "smoke-b-$([guid]::NewGuid().ToString('N').Substring(0,8))@example.com"
  $r = Post '/api/auth/signup' @{ email = $emailB; password = 'another-pass-7' } $jarB
  Check 'signup user B -> 201' ($r.code -eq 201) "$($r.code)"
  $r = GetU "/api/playlists/$pid1" $jarB
  Check 'user B GET user A playlist -> 404' ($r.code -in @(403, 404)) "$($r.code) $($r.body)"
  $g = GetU "/app/p/$pid1" $jarB
  Check 'user B /app/p/<A playlist> -> 404' ($g.code -eq 404) "$($g.code)"
  $r = GetU '/api/playlists' $jarB
  Check 'user B playlist list is empty' ($r.code -eq 200 -and @(($r.body | ConvertFrom-Json).playlists).Count -eq 0) "$($r.code) $($r.body)"
  $code = Invoke-Curl @('-o', 'NUL', '-w', '%{http_code}', '-b', $jarB, '-X', 'DELETE', '-H', "Origin: $base", "$base/api/playlists/$pid1")
  Check 'user B DELETE user A playlist -> 404' ([int]$code -in @(403, 404)) "$code"
  $r = Send 'PATCH' "/api/reels/$($reel.id)" @{ saved = $false } $jarB
  $r2 = Send 'POST' "/api/reels/$($reel.id)/share" @{} $jarB
  $r3 = Send 'DELETE' "/api/playlists/$pid1/share" $null $jarB
  $g = GetU "/api/reels?playlist=$pid1" $jarB
  Check 'user B cannot save, share, unshare or list user A reels' ($r.code -eq 404 -and $r2.code -eq 404 -and $r3.code -eq 404 -and ($g.body | ConvertFrom-Json).total -eq 0) "$($r.code) $($r2.code) $($r3.code)"
  $g = GetU "/r/$feedSlug" $null
  Check 'user A shared feed still up after user B tried to revoke it' ($g.code -eq 200) "$($g.code)"

  # CSRF: cross-origin POST
  $f = JsonFile @{ url = 'https://youtu.be/dQw4w9WgXcQ' }
  $code = Invoke-Curl @('-o', 'NUL', '-w', '%{http_code}', '-b', $jarA, '-H', 'Content-Type: application/json', '-H', 'Origin: https://evil.example', '-X', 'POST', '--data-binary', "@$f", "$base/api/playlists")
  Check 'cross-origin POST /api/playlists -> 403' ([int]$code -eq 403) "$code"

  # Single video URL path
  $r = Post '/api/playlists' @{ url = 'https://youtu.be/dQw4w9WgXcQ' } $jarA
  Check 'POST single video URL -> 201' ($r.code -eq 201) "$($r.code) $($r.body)"
  $pid2 = ($r.body | ConvertFrom-Json).id
  $sw = [Diagnostics.Stopwatch]::StartNew(); $status = ''
  while ($sw.Elapsed.TotalSeconds -lt 60) {
    $g = GetU "/api/playlists/$pid2" $jarA
    if ($g.code -eq 200) { $d2 = $g.body | ConvertFrom-Json; $status = $d2.playlist.status; if ($status -in @('ready', 'partial', 'failed')) { break } }
    Start-Sleep -Seconds 2
  }
  Check 'single video playlist reaches ready' ($status -eq 'ready') "status=$status kind=$($d2.playlist.kind) episodes=$(@($d2.episodes).Count)"
  $e2 = @($d2.episodes)[0]
  Check 'single video episode is a valid clip' ((@($d2.episodes).Count -eq 1) -and (ClipOk $e2 @($d2.videos))) "clip=$($e2.clip.start)-$($e2.clip.end) durationS=$($e2.durationS) yt=$($e2.youtubeVideoId)"

  # No captions: mock transcript provider returns null for ids containing NOCAP. The video is still
  # ready, with a default window after the intro (picked 'nocaptions') and transcript needs_manual.
  $r = Post '/api/playlists' @{ url = 'https://www.youtube.com/watch?v=NOCAPvid001' } $jarA
  Check 'POST no-caption video -> 201' ($r.code -eq 201) "$($r.code) $($r.body)"
  $pid3 = ($r.body | ConvertFrom-Json).id
  $sw = [Diagnostics.Stopwatch]::StartNew(); $status = ''
  while ($sw.Elapsed.TotalSeconds -lt 60) {
    $g = GetU "/api/playlists/$pid3" $jarA
    if ($g.code -eq 200) { $d3 = $g.body | ConvertFrom-Json; $status = $d3.playlist.status; if ($status -in @('ready', 'partial', 'failed')) { break } }
    Start-Sleep -Seconds 2
  }
  $v3 = @($d3.videos)[0]
  Check 'no-caption video -> needs_manual' ($v3.transcriptStatus -eq 'needs_manual' -or $v3.transcript_status -eq 'needs_manual') "playlist=$status video=$($v3.status) transcript=$($v3.transcriptStatus)$($v3.transcript_status) error=$($v3.error)"
  $e3 = @($d3.episodes)[0]
  Check 'no-caption video -> default clip (nocaptions)' ($status -eq 'ready' -and $e3.clip.picked -eq 'nocaptions' -and (ClipOk $e3 @($d3.videos))) "playlist=$status picked=$($e3.clip.picked) clip=$($e3.clip.start)-$($e3.clip.end)"
  # Still in the reels feed: cut at the creator's chapter marks (the mock video has some).
  $sw = [Diagnostics.Stopwatch]::StartNew(); $nf = $null
  while ($sw.Elapsed.TotalSeconds -lt 30) {
    $g = GetU "/api/reels?playlist=$pid3" $jarA
    if ($g.code -eq 200) { $nf = $g.body | ConvertFrom-Json; if ($nf.pending -eq 0 -and @($nf.reels).Count -gt 0) { break } }
    Start-Sleep -Seconds 1
  }
  $nr = @($nf.reels)
  Check 'no-caption video still has reels, cut at its chapter marks' ($nr.Count -ge 1 -and @($nr | Where-Object { $_.basis -ne 'chapters' -or -not $_.hook -or ($_.end - $_.start) -lt 30 }).Count -eq 0) "count=$($nr.Count) basis=$(($nr | ForEach-Object { $_.basis }) -join ',') hooks=$(($nr | ForEach-Object { $_.hook }) -join ' | ')"
  # "Check captions again" re-runs the video; the mock still has none, so it ends playable as before.
  $r = Send 'POST' "/api/playlists/$pid3/recheck" @{} $jarA
  Check 'recheck captions -> 202, 1 video queued' ($r.code -eq 202 -and ($r.body | ConvertFrom-Json).rechecked -eq 1) "$($r.code) $($r.body)"
  $sw = [Diagnostics.Stopwatch]::StartNew(); $status = ''
  while ($sw.Elapsed.TotalSeconds -lt 60) {
    Start-Sleep -Seconds 1
    $g = GetU "/api/playlists/$pid3" $jarA
    if ($g.code -eq 200) { $d3 = $g.body | ConvertFrom-Json; $status = $d3.playlist.status; if ($status -in @('ready', 'partial', 'failed')) { break } }
  }
  $v3 = @($d3.videos)[0]; $e3 = @($d3.episodes)[0]
  Check 'after the recheck: still no captions, still playable' ($status -eq 'ready' -and $v3.transcriptStatus -eq 'needs_manual' -and $e3.clip.picked -eq 'nocaptions') "playlist=$status transcript=$($v3.transcriptStatus) picked=$($e3.clip.picked)"
  $g = GetU "/app/p/$pid3" $jarA
  Check '/app/p/<needs_manual> renders 200' ($g.code -eq 200 -and $g.body -notmatch 'Application error') "$($g.code)"
  $text = "0:00 Welcome to this short talk about spaced repetition and why it works.`n0:12 The forgetting curve shows memory decays quickly unless we revisit material.`n0:30 Reviewing at growing intervals strengthens recall each time, so you need fewer reviews later.`n0:48 A good analogy is a path through grass that gets clearer every time you walk it.`n1:05 Try testing yourself instead of rereading, because retrieval is what builds memory."
  $r = Post "/api/videos/$($v3.id)/transcript" @{ text = $text } $jarA
  Check 'POST manual transcript -> 202' ($r.code -eq 202) "$($r.code) $($r.body)"
  $sw = [Diagnostics.Stopwatch]::StartNew(); $status = ''; $picked = ''
  while ($sw.Elapsed.TotalSeconds -lt 60) {
    Start-Sleep -Seconds 2
    $g = GetU "/api/playlists/$pid3" $jarA
    if ($g.code -eq 200) {
      $d3 = $g.body | ConvertFrom-Json; $status = $d3.playlist.status; $picked = "$(@($d3.episodes)[0].clip.picked)"
      if ($status -eq 'failed' -or ($status -eq 'ready' -and $picked -and $picked -ne 'nocaptions')) { break }
    }
  }
  $e3 = @($d3.episodes)[0]
  Check 'manual transcript -> ready with a picked clip' ($status -eq 'ready' -and $picked -eq 'heuristic' -and (ClipOk $e3 @($d3.videos))) "status=$status episodes=$(@($d3.episodes).Count) picked=$picked clip=$($e3.clip.start)-$($e3.clip.end)"
  $r = Post "/api/videos/$($v3.id)/transcript" @{ text = 'too short' } $jarA
  Check 'manual transcript too short -> 400/409' ($r.code -in @(400, 409)) "$($r.code) $($r.body)"

  # Daily cap (5 per rolling 24h): user A has created 3; 2 more succeed, the 6th is 429
  $codes = @()
  foreach ($i in 1..3) { $codes += (Post '/api/playlists' @{ url = "https://www.youtube.com/playlist?list=PLcapTest0000$i" } $jarA).code }
  Check 'daily cap: 4th,5th 201 then 429' ($codes[0] -eq 201 -and $codes[1] -eq 201 -and $codes[2] -eq 429) "codes=$($codes -join ',')"

  # Logout
  $r = Post '/api/auth/logout' @{} $jarA
  Check 'logout -> 204' ($r.code -eq 204) "$($r.code)"
  $r = GetU '/api/me' $jarA
  Check '/api/me after logout -> 401' ($r.code -eq 401) "$($r.code)"

  # DELETE (log back in)
  $r = Post '/api/auth/login' @{ email = $emailA; password = 'correct-horse-9' } $jarA
  $code = Invoke-Curl @('-o', 'NUL', '-w', '%{http_code}', '-b', $jarA, '-X', 'DELETE', '-H', "Origin: $base", "$base/api/playlists/$pid1")
  Check 'DELETE playlist -> 204' ([int]$code -eq 204) "$code"
  $r = GetU "/api/playlists/$pid1" $jarA
  Check 'deleted playlist -> 404' ($r.code -eq 404) "$($r.code)"

  # Daily cap counts creations, not live rows: after the delete user A is still at the cap
  $r = Post '/api/playlists' @{ url = 'https://www.youtube.com/playlist?list=PLcapAfterDel1' } $jarA
  Check 'daily cap survives DELETE -> 429' ($r.code -eq 429) "$($r.code)"

  # Oversized JSON body is refused (413) without being buffered
  $big = Join-Path $work 'big.json'
  [IO.File]::WriteAllText($big, '{"email":"x@example.com","password":"' + ('a' * 2000000) + '"}')
  $code = Invoke-Curl @('-o', 'NUL', '-w', '%{http_code}', '-H', 'Content-Type: application/json', '-H', "Origin: $base", '-X', 'POST', '--data-binary', "@$big", "$base/api/auth/login")
  Check 'oversized login body -> 413' ([int]$code -eq 413) "$code"

  # Sign-up limit is keyed on the TCP peer: a new X-Forwarded-For per request does not reset it
  # (2 sign-ups from this machine above; the limit is 10 per hour)
  $codes = @()
  foreach ($i in 1..10) {
    $f = JsonFile @{ email = "smoke-x$i-$([guid]::NewGuid().ToString('N').Substring(0,6))@example.com"; password = 'spoof-pass-123' }
    $codes += [int](Invoke-Curl @('-o', 'NUL', '-w', '%{http_code}', '-H', 'Content-Type: application/json', '-H', "Origin: $base", '-H', "X-Forwarded-For: 10.$i.$i.$i", '-X', 'POST', '--data-binary', "@$f", "$base/api/auth/signup"))
  }
  $ok201 = @($codes | Where-Object { $_ -eq 201 }).Count
  Check 'spoofed X-Forwarded-For cannot bypass the sign-up limit' ($ok201 -eq 8 -and $codes[-1] -eq 429) "codes=$($codes -join ',')"
}
finally {
  # Kill the server process trees
  if ($proc2) { & taskkill.exe /PID $proc2.Id /T /F | Out-Null }
  & taskkill.exe /PID $proc.Id /T /F | Out-Null
  Start-Sleep -Milliseconds 500
}
$errs = Select-String -Path $log, $errlog -Pattern 'error|Error|ERR' -SimpleMatch:$false | Where-Object { $_.Line -notmatch 'no errors' }
Write-Output "---- server log lines containing 'error' ($(@($errs).Count)) ----"
$errs | Select-Object -First 30 | ForEach-Object { Write-Output $_.Line }
Write-Output "---- SUMMARY: $($results.Count - $fail) passed, $fail failed ----"
