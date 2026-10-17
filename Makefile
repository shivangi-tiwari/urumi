.PHONY: build import deploy

build:
	@echo "Phase 0 uses the upstream nginx image; there are no local service images to build."

import:
	@echo "Phase 0 uses the upstream nginx image; there are no local images to import into k3d."

deploy:
	helm upgrade --install urumi ./charts/platform \
		--namespace urumi \
		--create-namespace \
		--values ./charts/platform/values-local.yaml \
		--values ./charts/platform/secrets.local.yaml
