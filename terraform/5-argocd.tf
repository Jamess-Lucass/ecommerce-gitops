locals { 
  argocd_ingress_host = "argocd.jameslucas.uk"
}

variable "ARGO_CD_ADMIN_EMAIL" {
  type        = string
  description = "Email Address of user in Azure AD who wants to be assigned Admin role in Argo CD."
}

resource "azuread_group" "argocd_admins" {
  display_name     = "ArgoCD Admins"
  owners           = [data.azuread_client_config.current.object_id]
  security_enabled = true
}

# https://argo-cd.readthedocs.io/en/stable/operator-manual/user-management/microsoft/
resource "azuread_application" "argocd" {
  display_name = "Ecommerce ArgoCD"
  owners           = [data.azuread_client_config.current.object_id]

  web {
    redirect_uris = ["https://${local.argocd_ingress_host}/auth/callback"]
  }

  public_client {
    redirect_uris = ["http://localhost:8085/auth/callback"]
  }

  required_resource_access {
    resource_app_id = "00000003-0000-0000-c000-000000000000" # Microsoft Graph

    resource_access {
      id   = "e1fe6dd8-ba31-4d61-89e7-88639da4683d" # User.Read
      type = "Scope"
    }
  }

  optional_claims {
    access_token {
      name = "groups"
    }

    id_token {
      name = "groups"
    }

    saml2_token {
      name = "groups"
    }
  }

  group_membership_claims = ["ApplicationGroup"]
}

resource "azuread_application_password" "argocd_sso" {
  application_object_id = azuread_application.argocd.object_id
  display_name = "SSO"
  end_date_relative = "17520h" # 2 years
}

resource "helm_release" "argocd" {
  name             = "argocd"
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-cd"
  namespace        = "argocd"
  create_namespace = true

  values = [yamlencode({
    server = {
      extraArgs = ["--insecure"]
      ingress = {
        enabled = true
        annotations = {
          "external-dns.alpha.kubernetes.io/cloudflare-proxied" = true
        }
        ingressClassName = "nginx"
        hosts = [local.argocd_ingress_host]
      }
    }

    configs = {
      cm = {
        url = "https://${local.argocd_ingress_host}"
        "admin.enabled" = false
        "oidc.config" = yamlencode({
          name = "Azure"
          issuer = "https://login.microsoftonline.com/${data.azurerm_client_config.current.tenant_id}/v2.0"
          clientID = "${azuread_application.argocd.application_id}"
          clientSecret = "$oidc.azure.clientSecret"
          requestedIDTokenClaims = {
            groups = {
              essential= true
            }
          }
          requestedScopes = ["openid", "profile", "email"]
        })
      }

      secret = {
        extra = {
          "oidc.azure.clientSecret" = azuread_application_password.argocd_sso.value
        }
      }

      rbac = {
        "policy.default" = "role:readonly"
        "policy.csv" = <<-EOT
          g, ${var.ARGO_CD_ADMIN_EMAIL}, role:admin
        EOT
        "scopes" = "[groups, email]"
      }
    }
  })]
}

resource "helm_release" "argocd-image-updater" {
  name             = "argocd-image-updater"
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argocd-image-updater"
  namespace        = "argocd"
  create_namespace = true
}