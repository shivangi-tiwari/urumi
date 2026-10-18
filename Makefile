.PHONY: build import deploy

MCP_EVERYTHING_IMAGE := mcp-everything:local
MCP_EVERYTHING_DIR := ./charts/platform/charts/mcp-everything
K3D_CLUSTER := urumi

build:
	docker build --tag $(MCP_EVERYTHING_IMAGE) --file $(MCP_EVERYTHING_DIR)/Dockerfile $(MCP_EVERYTHING_DIR)

import:
	k3d image import $(MCP_EVERYTHING_IMAGE) --cluster $(K3D_CLUSTER)

deploy:
	helm upgrade --install urumi ./charts/platform \
		--namespace urumi \
		--create-namespace \
		--values ./charts/platform/values-local.yaml \
		--values ./charts/platform/secrets.local.yaml
