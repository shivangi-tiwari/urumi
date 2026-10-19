helm upgrade --install urumi ./charts/platform -n urumi --values ./charts/platform/values-local.yaml --values ./charts/platform/secrets.local.yaml --timeout 5m @args
