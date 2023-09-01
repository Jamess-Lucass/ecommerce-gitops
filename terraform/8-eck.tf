locals {
  version = "8.9.1"
  elastic_search_name = "elastic-search"
  kibana_name = "kibana"
  namespace = "elastic"
  kibana_ingress_host = "kibana.jameslucas.uk"
}

# resource "azuread_application" "kibana" {
#   display_name = "Ecommerce Kibana"
#   owners           = [data.azuread_client_config.current.object_id]

#   web {
#     redirect_uris = ["https://${local.kibana_ingress_host}/api/security/oidc/callback"]
#   }
# }

# resource "azuread_application_password" "kibana_sso" {
#   application_object_id = azuread_application.kibana.object_id
#   display_name = "SSO"
#   end_date_relative = "17520h" # 2 years
# }

resource "helm_release" "elastic" {
  name             = "elastic"
  repository       = "https://helm.elastic.co"
  chart            = "eck-operator"
  namespace        = "elastic-system"
  create_namespace = true
}

resource "kubernetes_namespace" "elastic_namespace" {
  metadata {
    name = local.namespace
  }

  depends_on = [
    helm_release.elastic
  ]
}

# resource "kubernetes_secret" "elastic_search_xpack_oidc_azure_secret" {
#   metadata {
#     name = "${local.elastic_search_name}-xpack-oidc-azure-client-secret"
#     namespace = local.namespace
#   }

#   data = {
#     "xpack.security.authc.realms.oidc.azuread.rp.client_secret" = azuread_application_password.kibana_sso.value
#   }
# }

# Elastic
resource "kubectl_manifest" "elastic_search" {
  yaml_body = <<-EOF
apiVersion: elasticsearch.k8s.elastic.co/v1
kind: Elasticsearch
metadata:
  name: ${local.elastic_search_name}
  namespace: ${local.namespace}
spec:
  version: ${local.version}
  nodeSets:
    - name: master
      count: 1
      config:
        node.roles: ["master"]
        node.store.allow_mmap: false
      podTemplate:
        spec:
          containers:
            - name: elasticsearch
              image: docker.elastic.co/elasticsearch/elasticsearch:${local.version}
              resources:
                requests:
                  memory: 1Gi
                  cpu: 200m
                limits:
                  memory: 2Gi
    - name: worker
      count: 2
      config:
        node.roles: ["data", "ingest"]
        node.store.allow_mmap: false
      volumeClaimTemplates:
        - metadata:
            name: elasticsearch-data
          spec:
            accessModes:
              - ReadWriteOnce
            resources:
              requests:
                storage: 20Gi
            storageClassName: default
      podTemplate:
        spec:
          containers:
            - name: elasticsearch
              image: docker.elastic.co/elasticsearch/elasticsearch:${local.version}
              resources:
                requests:
                  memory: 1Gi
                  cpu: 200m
                limits:
                  memory: 2Gi
EOF

  depends_on = [
    helm_release.elastic,
    kubernetes_namespace.elastic_namespace
  ]
}

# secureSettings:
# - secretName: ${local.elastic_search_name}-xpack-oidc-azure-client-secret

# xpack:
#   security:
#     authc:
#       realms:
#         oidc:
#           azuread:
#             order: 2
#             rp.client_id: "${azuread_application.kibana.application_id}"
#             rp.response_type: "code"
#             rp.redirect_uri: "https://${local.kibana_ingress_host}/api/security/oidc/callback"
#             op.issuer: "https://login.microsoftonline.com/${data.azurerm_client_config.current.tenant_id}/v2.0"
#             op.authorization_endpoint: "https://login.microsoftonline.com/${data.azurerm_client_config.current.tenant_id}/oauth2/v2.0/authorize"
#             op.token_endpoint: "https://login.microsoftonline.com/${data.azurerm_client_config.current.tenant_id}/oauth2/v2.0/token"
#             op.userinfo_endpoint: "https://graph.microsoft.com/oidc/userinfo"
#             op.endsession_endpoint: "https://login.microsoftonline.com/${data.azurerm_client_config.current.tenant_id}/oauth2/v2.0/logout"
#             rp.post_logout_redirect_uri: "https://${local.kibana_ingress_host}/logged_out"
#             op.jwkset_path: "https://login.microsoftonline.com/${data.azurerm_client_config.current.tenant_id}/discovery/v2.0/keys"
#             claims.principal: email

# Kibana
resource "kubectl_manifest" "kibana" {
  yaml_body = <<-EOF
apiVersion: kibana.k8s.elastic.co/v1
kind: Kibana
metadata:
  name: ${local.kibana_name}
  namespace: ${local.namespace}
spec:
  version: ${local.version}
  http:
    tls:
      selfSignedCertificate:
        disabled: true
  count: 1
  elasticsearchRef:
    name: ${local.elastic_search_name}
    namespace: ${local.namespace}
  config:
    server.publicBaseUrl: "https://${local.kibana_ingress_host}"
    xpack.fleet.agents.elasticsearch.hosts:
      ["https://${local.elastic_search_name}-es-http.elastic.svc:9200"]
    xpack.fleet.agents.fleet_server.hosts:
      ["https://fleet-server-agent-http.elastic.svc:8220"]
    xpack.fleet.packages:
      - name: system
        version: latest
      - name: elastic_agent
        version: latest
      - name: fleet_server
        version: latest
      - name: apm
        version: latest
    xpack.fleet.agentPolicies:
      - name: Fleet Server on ECK policy
        id: eck-fleet-server
        is_default_fleet_server: true
        namespace: ${local.namespace}
        monitoring_enabled: []
        unenroll_timeout: 900
        package_policies:
          - name: fleet_server-1
            id: fleet_server-1
            package:
              name: fleet_server
      - name: Elastic Agent on ECK policy
        id: eck-agent
        namespace: ${local.namespace}
        monitoring_enabled: []
        unenroll_timeout: 900
        is_default: true
        package_policies:
          - name: system-1
            id: system-1
            package:
              name: system
          - package:
              name: apm
            name: apm-1
            inputs:
              - type: apm
                enabled: true
                vars:
                  - name: host
                    value: 0.0.0.0:8200
EOF

  depends_on = [
    helm_release.elastic,
    kubernetes_namespace.elastic_namespace
  ]
}

# xpack.security.authc.providers:
#   oidc.oidc1:
#     order: 0
#     realm: "azuread"
#     description: "Log in with Azure"

resource "kubernetes_ingress_v1" "kibana_ingress" {
  metadata {
    name      = "kibana-ingress"
    namespace = local.namespace
    annotations = {
      "external-dns.alpha.kubernetes.io/cloudflare-proxied" = "true"
    }
  }

  spec {
    ingress_class_name = "nginx"

    rule {
      host = local.kibana_ingress_host

      http {
        path {
          path = "/"
          backend {
            service {
              name = "${local.kibana_name}-kb-http"
              port {
                number = 5601
              }
            }
          }
        }
      }
    }
  }

  depends_on = [
    helm_release.elastic,
    kubectl_manifest.kibana,
    kubernetes_namespace.elastic_namespace
  ]
}

# Configuration
resource "kubectl_manifest" "heartbeat" {
  yaml_body = <<-EOF
apiVersion: beat.k8s.elastic.co/v1beta1
kind: Beat
metadata:
  name: heartbeat
  namespace: ${local.namespace}
spec:
  type: heartbeat
  version: ${local.version}
  elasticsearchRef:
    name: ${local.elastic_search_name}
    namespace: ${local.namespace}
  config:
    heartbeat.monitors:
      - type: http
        id: identity-service
        tags: ["identity", "service"]
        name: Identity Service
        schedule: "@every 10s"
        hosts: ["ecommerce-identity-service.default.svc:80/api/healthz"]
        check.response:
          status: [200]
          body:
            - Healthy
  deployment:
    podTemplate:
      spec:
        dnsPolicy: ClusterFirstWithHostNet
        securityContext:
          runAsUser: 0

EOF

  depends_on = [
    helm_release.elastic,
    kubernetes_namespace.elastic_namespace
  ]
}