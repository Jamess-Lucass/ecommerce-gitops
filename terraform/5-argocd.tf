locals { 
  argocd_ingress_host = "argocd.jameslucas.uk"
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

  set {
    name  = "server.extraArgs[0]"
    value = "--insecure"
  }

  set {
    name  = "server.ingress.enabled"
    value = true
  }

  set {
    name  = "server.ingress.annotations.external-dns.alpha.kubernetes.io/cloudflare-proxied"
    value = "true"
  }

  set {
    name  = "server.ingress.ingressClassName"
    value = "nginx"
  }

  set {
    name  = "server.ingress.hosts[0]"
    value = local.argocd_ingress_host
  }

  set {
    name  = "configs.cm.url"
    value = "https://${local.argocd_ingress_host}"
  }

  set {
    name  = "configs.cm.oidc\\.config"
    value = <<-EOF
      name: Azure
      issuer: https://login.microsoftonline.com/${data.azurerm_client_config.current.tenant_id}/v2.0
      clientID: ${azuread_application.argocd.application_id}
      clientSecret: ${azuread_application_password.argocd_sso.value}
      requestedIDTokenClaims:
        groups:
            essential: true
      requestedScopes:
        - openid
        - profile
        - email
    EOF
  }

  set {
    name = "configs.secret.extra.oidc\\.azure\\.clientSecret"
    value = azuread_application_password.argocd_sso.value
  }

  set {
    name = "configs.rbac.policy\\.default"
    value = "role:readonly"
  }

  set {
    name = "configs.rbac.policy\\.csv"
    value = <<-EOF
      g, "${azuread_group.argocd_admins.object_id}", role:admin
    EOF
  }

  set {
    name = "configs.rbac.scopes"
    value = "{groups, email}"
  }
}

resource "helm_release" "argocd-image-updater" {
  name             = "argocd-image-updater"
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argocd-image-updater"
  namespace        = "argocd"
  create_namespace = true
}