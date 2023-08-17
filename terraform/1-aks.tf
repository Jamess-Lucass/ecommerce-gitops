locals {
  workload_namespace = "default"
  workload_name      = "workload-identity-sa"
}

resource "azurerm_resource_group" "rg" {
  name     = "rg-ecommerce-demo-01"
  location = "uksouth"
}

resource "azurerm_kubernetes_cluster" "aks" {
  name                      = "aks-ecommerce-demo-01"
  location                  = azurerm_resource_group.rg.location
  resource_group_name       = azurerm_resource_group.rg.name
  dns_prefix                = "jamess-lucass-ecommerce-demo"
  oidc_issuer_enabled       = true
  workload_identity_enabled = true

  key_vault_secrets_provider {
    secret_rotation_enabled = true
  }

  default_node_pool {
    name                        = "default"
    node_count                  = 2
    vm_size                     = "Standard_D4s_v3"
    temporary_name_for_rotation = "akstempnode"
  }

  identity {
    type = "SystemAssigned"
  }

  tags = {
    Environment = "Development"
  }

  depends_on = [
    azurerm_resource_group.rg
  ]
}

data "azurerm_client_config" "current" {}

resource "azurerm_user_assigned_identity" "aks_workload_identity" {
  location            = azurerm_resource_group.rg.location
  name                = "aks-workload-identity"
  resource_group_name = azurerm_resource_group.rg.name

  depends_on = [
    azurerm_resource_group.rg
  ]
}

resource "azurerm_federated_identity_credential" "workload_identity_credentials" {
  name                = "workload-identity-credentials"
  resource_group_name = azurerm_resource_group.rg.name
  audience            = ["api://AzureADTokenExchange"]
  issuer              = azurerm_kubernetes_cluster.aks.oidc_issuer_url
  parent_id           = azurerm_user_assigned_identity.aks_workload_identity.id
  subject             = "system:serviceaccount:${local.workload_namespace}:${local.workload_name}"

  depends_on = [
    azurerm_kubernetes_cluster.aks,
    azurerm_user_assigned_identity.aks_workload_identity
  ]
}

resource "azurerm_key_vault" "key_vault" {
  name                        = "kv-ecommerce-demo-01"
  location                    = azurerm_resource_group.rg.location
  resource_group_name         = azurerm_resource_group.rg.name
  enabled_for_disk_encryption = true
  tenant_id                   = data.azurerm_client_config.current.tenant_id
  soft_delete_retention_days  = 7
  purge_protection_enabled    = false
  enable_rbac_authorization   = true

  sku_name = "standard"

  depends_on = [
    azurerm_resource_group.rg,
    azurerm_user_assigned_identity.aks_workload_identity
  ]
}

resource "azurerm_role_assignment" "aks_workload_identity_key_vault_secrets_user_role_assignment" {
  scope              = azurerm_key_vault.key_vault.id
  role_definition_id = "/subscriptions/${data.azurerm_client_config.current.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6"
  principal_id       = azurerm_user_assigned_identity.aks_workload_identity.principal_id
}

resource "azurerm_role_assignment" "aks_workload_identity_key_vault_reader_role_assignment" {
  scope              = azurerm_key_vault.key_vault.id
  role_definition_id = "/subscriptions/${data.azurerm_client_config.current.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/21090545-7ca7-4776-b22c-e363652d74d2"
  principal_id       = azurerm_user_assigned_identity.aks_workload_identity.principal_id
}

resource "azurerm_role_assignment" "service_principal_key_vault_secrets_officer_assignment" {
  scope              = azurerm_key_vault.key_vault.id
  role_definition_id = "/subscriptions/${data.azurerm_client_config.current.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/b86a8fe4-44ce-4948-aee5-eccb2c155cd7"
  principal_id       = data.azurerm_client_config.current.object_id
}

resource "helm_release" "external-secrets" {
  name             = "external-secrets"
  repository       = "https://charts.external-secrets.io"
  chart            = "external-secrets"
  namespace        = "default"
  create_namespace = true
}

resource "kubernetes_service_account" "aks_workload_service_account" {
  metadata {
    name      = local.workload_name
    namespace = local.workload_namespace
    annotations = {
      "azure.workload.identity/client-id" = azurerm_user_assigned_identity.aks_workload_identity.client_id
      "azure.workload.identity/tenant-id" = data.azurerm_client_config.current.tenant_id
    }
    labels = {
      "azure.workload.identity/use" = "true"
    }
  }

  depends_on = [
    azurerm_user_assigned_identity.aks_workload_identity
  ]
}

resource "kubectl_manifest" "external_secrets_secret_store" {
  yaml_body = <<-EOF
apiVersion: external-secrets.io/v1beta1
kind: SecretStore
metadata:
  name: azure-store
spec:
  provider:
    azurekv:
      authType: WorkloadIdentity
      vaultUrl: "${azurerm_key_vault.key_vault.vault_uri}"
      serviceAccountRef:
        name: ${local.workload_name}
EOF

  depends_on = [
    azurerm_key_vault.key_vault,
    helm_release.external-secrets
  ]
}