module "argocd_application_ecommerce-login-ui" {
  source = "./modules/argocd-application"

  name       = "ecommerce-login-ui"
  image_name = "ghcr.io/jamess-lucass/ecommerce-login-ui"
  image_tag  = "main"
  repo       = "https://github.com/Jamess-Lucass/ecommerce-login-ui"
  path       = "deploy/envs/prod"

  depends_on = [
    helm_release.argocd
  ]
}

module "argocd_application_ecommerce-identity-service" {
  source = "./modules/argocd-application"

  name       = "ecommerce-identity-service"
  image_name = "ghcr.io/jamess-lucass/ecommerce-identity-service"
  image_tag  = "main"
  repo       = "https://github.com/Jamess-Lucass/ecommerce-identity-service"
  path       = "deploy/envs/prod"

  depends_on = [
    helm_release.argocd
  ]
}

module "argocd_application_ecommerce-user-service" {
  source = "./modules/argocd-application"

  name       = "ecommerce-user-service"
  image_name = "ghcr.io/jamess-lucass/ecommerce-user-service"
  image_tag  = "main"
  repo       = "https://github.com/Jamess-Lucass/ecommerce-user-service"
  path       = "deploy/envs/prod"

  depends_on = [
    helm_release.argocd
  ]
}

module "argocd_application_ecommerce-shop-ui" {
  source = "./modules/argocd-application"

  name       = "ecommerce-shop-ui"
  image_name = "ghcr.io/jamess-lucass/ecommerce-shop-ui"
  image_tag  = "main"
  repo       = "https://github.com/Jamess-Lucass/ecommerce-shop-ui"
  path       = "deploy/envs/prod"

  depends_on = [
    helm_release.argocd
  ]
}

module "argocd_application_ecommerce-internal-ui" {
  source = "./modules/argocd-application"

  name       = "ecommerce-internal-ui"
  image_name = "ghcr.io/jamess-lucass/ecommerce-internal-ui"
  image_tag  = "main"
  repo       = "https://github.com/Jamess-Lucass/ecommerce-internal-ui"
  path       = "deploy/envs/prod"

  depends_on = [
    helm_release.argocd
  ]
}

module "argocd_application_ecommerce-catalog-service" {
  source = "./modules/argocd-application"

  name       = "ecommerce-catalog-service"
  image_name = "ghcr.io/jamess-lucass/ecommerce-catalog-service"
  image_tag  = "main"
  repo       = "https://github.com/Jamess-Lucass/ecommerce-catalog-service"
  path       = "deploy/envs/prod"

  depends_on = [
    helm_release.argocd
  ]
}

module "argocd_application_ecommerce-basket-service" {
  source = "./modules/argocd-application"

  name       = "ecommerce-basket-service"
  image_name = "ghcr.io/jamess-lucass/ecommerce-basket-service"
  image_tag  = "main"
  repo       = "https://github.com/Jamess-Lucass/ecommerce-basket-service"
  path       = "deploy/envs/prod"

  depends_on = [
    helm_release.argocd
  ]
}

module "argocd_application_ecommerce-order-service" {
  source = "./modules/argocd-application"

  name       = "ecommerce-order-service"
  image_name = "ghcr.io/jamess-lucass/ecommerce-order-service"
  image_tag  = "main"
  repo       = "https://github.com/Jamess-Lucass/ecommerce-order-service"
  path       = "deploy/envs/prod"

  depends_on = [
    helm_release.argocd
  ]
}

module "argocd_application_ecommerce-email-service" {
  source = "./modules/argocd-application"

  name       = "ecommerce-email-service"
  image_name = "ghcr.io/jamess-lucass/ecommerce-email-service"
  image_tag  = "main"
  repo       = "https://github.com/Jamess-Lucass/ecommerce-email-service"
  path       = "deploy/envs/prod"

  depends_on = [
    helm_release.argocd
  ]
}