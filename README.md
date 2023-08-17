# ecommerce-gitops

kubectl get secrets/argocd-initial-admin-secret -n argocd -o jsonpath='{.data.password}' | base64 -d