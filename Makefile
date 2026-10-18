.PHONY: build import deploy

MCP_EVERYTHING_IMAGE := mcp-everything:local
MCP_EVERYTHING_DIR := ./charts/platform/charts/mcp-everything
MCP_DASHBOARD_IMAGE := dashboard:local
MCP_DASHBOARD_DIR := ./services/dashboard
MCP_GATEWAY_IMAGE := gateway:local
MCP_GATEWAY_DIR := ./services/gateway
K3D_CLUSTER := urumi

build:
	docker build --tag $(MCP_EVERYTHING_IMAGE) --file $(MCP_EVERYTHING_DIR)/Dockerfile $(MCP_EVERYTHING_DIR)
	docker build --tag $(MCP_DASHBOARD_IMAGE) --file $(MCP_DASHBOARD_DIR)/Dockerfile $(MCP_DASHBOARD_DIR)
	docker build --tag $(MCP_GATEWAY_IMAGE) $(MCP_GATEWAY_DIR)

import:
	k3d image import $(MCP_EVERYTHING_IMAGE) --cluster $(K3D_CLUSTER)
	k3d image import $(MCP_DASHBOARD_IMAGE) --cluster $(K3D_CLUSTER)
	k3d image import $(MCP_GATEWAY_IMAGE) --cluster $(K3D_CLUSTER)

deploy:
	helm upgrade --install urumi ./charts/platform \
		--namespace urumi \
		--create-namespace \
		--values ./charts/platform/values-local.yaml \
		--values ./charts/platform/secrets.local.yaml
