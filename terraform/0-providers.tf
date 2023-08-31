# Configure the Azure provider
terraform {
  cloud {
    organization = "jameslucas1210"

    workspaces {
      name = "ecommerce-prod"
    }
  }

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 3.69.0"
    }

    kubectl = {
      source  = "gavinbunney/kubectl"
      version = ">= 1.14.0"
    }

    azuread = {
      source  = "hashicorp/azuread"
      version = ">= 2.41.0"
    }
  }
}

data "azurerm_client_config" "current" {}
data "azuread_client_config" "current" {}

provider "azurerm" {
  features {}
}

provider "azuread" {
  tenant_id = data.azurerm_client_config.current.tenant_id
}

provider "helm" {
  kubernetes {
    host                   = azurerm_kubernetes_cluster.aks.kube_config.0.host
    client_key             = base64decode(azurerm_kubernetes_cluster.aks.kube_config.0.client_key)
    client_certificate     = base64decode(azurerm_kubernetes_cluster.aks.kube_config.0.client_certificate)
    cluster_ca_certificate = base64decode(azurerm_kubernetes_cluster.aks.kube_config.0.cluster_ca_certificate)
  }
}

provider "kubectl" {
  host                   = azurerm_kubernetes_cluster.aks.kube_config.0.host
  client_key             = base64decode(azurerm_kubernetes_cluster.aks.kube_config.0.client_key)
  client_certificate     = base64decode(azurerm_kubernetes_cluster.aks.kube_config.0.client_certificate)
  cluster_ca_certificate = base64decode(azurerm_kubernetes_cluster.aks.kube_config.0.cluster_ca_certificate)
  load_config_file       = false
}

provider "kubernetes" {
  host                   = azurerm_kubernetes_cluster.aks.kube_config.0.host
  client_key             = base64decode(azurerm_kubernetes_cluster.aks.kube_config.0.client_key)
  client_certificate     = base64decode(azurerm_kubernetes_cluster.aks.kube_config.0.client_certificate)
  cluster_ca_certificate = base64decode(azurerm_kubernetes_cluster.aks.kube_config.0.cluster_ca_certificate)
}