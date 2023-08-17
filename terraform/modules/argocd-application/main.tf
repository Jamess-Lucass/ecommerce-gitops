resource "kubectl_manifest" "application" {
  yaml_body  = <<-EOF
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${var.name}
  namespace: argocd
  annotations:
    argocd-image-updater.argoproj.io/image-list: myimage=${var.image_name}:${var.image_tag}
    argocd-image-updater.argoproj.io/myimage.update-strategy: digest
spec:
  project: default
  source:
    repoURL: ${var.repo}
    targetRevision: HEAD
    path: ${var.path}
  destination:
    server: https://kubernetes.default.svc
    namespace: default
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas
    - group: autoscaling
      kind: HorizontalPodAutoscaler
      jsonPointers:
        - /spec/metrics
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
EOF
}