locals {
  workload_namespace = "default"
  workload_name      = "workload-identity-sa"
  vnet_name          = "vnet-01"
  kubernetes_version = "1.27.3"
}

resource "azurerm_resource_group" "rg" {
  name     = "rg-ecommerce-demo-01"
  location = "uksouth"
}

resource "azurerm_network_security_group" "aks_nodepool_subnet_nsg" {
  name                = "nsg-${local.vnet_name}-nodepools"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
}

// VNet
resource "azurerm_virtual_network" "virtual_network_01" {
  name                = local.vnet_name
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  address_space       = ["10.240.0.0/16"]
}

resource "azurerm_subnet" "cluster_nodes_subnet" {
  name                 = "snet-clusternodes"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.virtual_network_01.name

  address_prefixes                              = ["10.240.0.0/22"]
  private_endpoint_network_policies_enabled     = false
  private_link_service_network_policies_enabled = false
}

resource "azurerm_subnet_network_security_group_association" "cluster_nodes_subnet_vnet_nsg_association" {
  subnet_id                 = azurerm_subnet.cluster_nodes_subnet.id
  network_security_group_id = azurerm_network_security_group.aks_nodepool_subnet_nsg.id
}

resource "azurerm_kubernetes_cluster" "aks" {
  name                = "aks-ecommerce-demo-01"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  kubernetes_version        = local.kubernetes_version
  dns_prefix                = "jamess-lucass-ecommerce-demo"
  oidc_issuer_enabled       = true
  workload_identity_enabled = true

  key_vault_secrets_provider {
    secret_rotation_enabled = true
  }

  default_node_pool {
    name                        = "np-system"
    node_count                  = 3
    vm_size                     = "Standard_DS2_v2"
    os_disk_size_gb             = 80
    os_disk_type                = "Ephemeral"
    os_sku                      = "Ubuntu"
    temporary_name_for_rotation = "akstempnode"
    vnet_subnet_id              = azurerm_subnet.cluster_nodes_subnet.id
    min_count                   = 3
    max_count                   = 5
    enable_auto_scaling         = true
    type                        = "VirtualMachineScaleSets"
    enable_node_public_ip       = false
    custom_ca_trust_enabled = false
    enable_host_encryption      = false
    fips_enabled                = false
    orchestrator_version        = local.kubernetes_version
    upgrade_settings {
      max_surge = "33%"
    }

    node_taints = ["CriticalAddonsOnly=true:NoSchedule"]

    tags = {
      type = "system"
    }
  }

  identity {
    type = "SystemAssigned"
  }

  depends_on = [
    azurerm_resource_group.rg
  ]
}

resource "azurerm_kubernetes_cluster_node_pool" "user_node_pool" {
  name                  = "npuser01"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.aks.id

  mode           = "User"
  vm_size        = "Standard_DS3_v2"
  node_count     = 3
  vnet_subnet_id = azurerm_subnet.cluster_nodes_subnet.id

  tags = {
    type = "user"
  }
}

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