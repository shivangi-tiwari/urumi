function Build-Gateway {
  Push-Location services\gateway; npm run build; $ok = $LASTEXITCODE; Pop-Location
  if ($ok -ne 0) { throw "gateway build failed - nothing deployed" }
  docker build -t gateway:local services/gateway
  k3d image import gateway:local -c urumi
}
function Build-Dashboard {
  Push-Location services\dashboard; npm run build; $ok = $LASTEXITCODE; Pop-Location
  if ($ok -ne 0) { throw "dashboard build failed - nothing deployed" }
  docker build --tag dashboard:local --file .\services\dashboard\Dockerfile .\services\dashboard
  k3d image import dashboard:local -c urumi
}
function Deploy-Platform {
  helm dependency update ./charts/platform
  helm upgrade --install urumi ./charts/platform -n urumi --values ./charts/platform/values-local.yaml --values ./charts/platform/secrets.local.yaml --timeout 5m --no-hooks @args
}
function Restart-App($Name) {
  kubectl rollout restart deploy/$Name -n urumi
  kubectl rollout status deploy/$Name -n urumi
}
function Save-Work($Message) {
  git add .
  $pattern = '^\+.*([0-9a-f]{64}|AQ\.[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,})'
  $hits = @(git --no-pager diff --cached -- . ':!charts/platform/Chart.lock' ':!*package-lock.json' | Select-String -Pattern $pattern).Count
  $bad = @(git --no-pager status --short | Select-String -Pattern 'secrets\.local|secrets\.prod|login\.json|cookies')
  if ($hits -gt 0 -or $bad.Count -gt 0) {
    git reset | Out-Null
    Write-Host "STOP: possible secret staged (hits=$hits, unsafe files=$($bad.Count)). Nothing committed."
    return
  }
  git commit -m $Message
  git push
}
