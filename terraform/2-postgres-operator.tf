resource "helm_release" "postgres-operator" {
  name             = "postgres-operator"
  repository       = "https://opensource.zalando.com/postgres-operator/charts/postgres-operator"
  chart            = "postgres-operator"
  namespace        = "default"
  create_namespace = true

  depends_on = [
    azurerm_kubernetes_cluster.aks
  ]
}

# move out
resource "helm_release" "mongodb-operator" {
  name             = "mongodb-operator"
  repository       = "https://mongodb.github.io/helm-charts"
  chart            = "community-operator"
  namespace        = "default"
  create_namespace = true

  depends_on = [
    azurerm_kubernetes_cluster.aks
  ]
}