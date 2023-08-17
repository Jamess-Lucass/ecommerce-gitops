resource "helm_release" "nginix-ingress" {
  name             = "ingress-nginx"
  repository       = "https://kubernetes.github.io/ingress-nginx"
  chart            = "ingress-nginx"
  namespace        = "ingress-nginx"
  create_namespace = true

  # https://kubernetes.github.io/ingress-nginx/deploy/#cloud-deployments
  set {
    name  = "controller.service.externalTrafficPolicy"
    value = "Local"
  }
}