# ecommerce-gitops

kubectl get secret/argocd-initial-admin-secret -n argocd -o jsonpath='{.data.password}' | base64 -d

kubectl get secret/elastic-search-es-elastic-user -n elastic -o jsonpath='{.data.elastic}' | base64 -d
