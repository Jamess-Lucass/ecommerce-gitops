resource "helm_release" "rabbit-mq-operator" {
  name       = "rabbit-mq-operator"
  repository = "https://charts.bitnami.com/bitnami"
  chart      = "rabbitmq-cluster-operator"
  namespace  = "default"
}

resource "kubectl_manifest" "rabbitmq_cluster" {
  yaml_body = <<-EOF
apiVersion: rabbitmq.com/v1beta1
kind: RabbitmqCluster
metadata:
  name: rabbit-mq
  namespace: default
spec:
  resources:
    requests:
      cpu: 200m
      memory: 1Gi
    limits:
      cpu: 200m
      memory: 1Gi
EOF

  depends_on = [
    helm_release.rabbit-mq-operator
  ]
}