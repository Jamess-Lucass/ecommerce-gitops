import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";
import * as azuread from "@pulumi/azuread";
import * as cluster from "./cluster";
import * as config from "./config";
import { ArgoCDApplication } from "./components";

const projectConfig = new pulumi.Config();
const azureNativeConfig = new pulumi.Config("azure-native");

const current = azuread.getClientConfig({});
const argocdIngressHost = "argocd.jameslucas.uk";

const k8sProvider = new kubernetes.Provider(
  "k8s-provider",
  {
    kubeconfig: cluster.kubeConfig,
  },
  { dependsOn: [cluster.aks] }
);

const externalSecrets = new kubernetes.helm.v3.Release(
  "external-secrets",
  {
    chart: "external-secrets",
    namespace: "default",
    repositoryOpts: {
      repo: "https://charts.external-secrets.io",
    },
  },
  { provider: k8sProvider }
);

new kubernetes.core.v1.ServiceAccount(
  "aks-keyvault-workload-service-account",
  {
    metadata: {
      name: config.workloadName,
      namespace: config.workloadNamespace,
      annotations: {
        "azure.workload.identity/client-id": cluster.keyvaultAddonProfile.apply(
          (x) => x.identity.clientId!
        ),
        "azure.workload.identity/tenant-id":
          azureNativeConfig.get("tenantId") ?? "",
      },
      labels: {
        "azure.workload.identity/use": "true",
      },
    },
  },
  { provider: k8sProvider }
);

new kubernetes.apiextensions.CustomResource(
  "external-secrets-secret-store",
  {
    apiVersion: "external-secrets.io/v1beta1",
    kind: "SecretStore",
    metadata: {
      name: "azure-store",
    },
    spec: {
      provider: {
        azurekv: {
          authType: "WorkloadIdentity",
          vaultUrl: cluster.kv.properties.vaultUri,
          serviceAccountRef: {
            name: config.workloadName,
          },
        },
      },
    },
  },
  { provider: k8sProvider, dependsOn: [externalSecrets] }
);

new kubernetes.helm.v3.Release(
  "postgres-operator",
  {
    chart: "postgres-operator",
    namespace: "default",
    createNamespace: true,
    repositoryOpts: {
      repo: "https://opensource.zalando.com/postgres-operator/charts/postgres-operator",
    },
  },
  { provider: k8sProvider }
);

new kubernetes.helm.v3.Release(
  "mongodb-operator",
  {
    chart: "community-operator",
    namespace: "default",
    createNamespace: true,
    repositoryOpts: {
      repo: "https://mongodb.github.io/helm-charts",
    },
  },
  { provider: k8sProvider }
);

new kubernetes.helm.v3.Release(
  "nginx-ingress",
  {
    chart: "ingress-nginx",
    namespace: "ingress-nginx",
    createNamespace: true,
    repositoryOpts: {
      repo: "https://kubernetes.github.io/ingress-nginx",
    },
    values: {
      controller: {
        service: {
          externalTrafficPolicy: "Local",
        },
      },
    },
  },
  { provider: k8sProvider }
);

new kubernetes.helm.v3.Release(
  "external-dns",
  {
    chart: "external-dns",
    namespace: "default",
    createNamespace: true,
    repositoryOpts: {
      repo: "https://charts.bitnami.com/bitnami",
    },
    values: {
      provider: "cloudflare",
      cloudflare: {
        apiToken: projectConfig.get("cloudflareAPIToken"),
      },
    },
  },
  { provider: k8sProvider }
);

//
// ArgoCD
//

const argoCDAdminsGroup = new azuread.Group("argocd-admins-group", {
  displayName: "ArgoCD Admins",
  owners: [current.then((current) => current.objectId)],
  securityEnabled: true,
});

const argoCDApplication = new azuread.Application("argocd", {
  displayName: "Ecommerce ArgoCD",
  owners: [current.then((current) => current.objectId)],

  web: {
    redirectUris: [`https://${argocdIngressHost}/auth/callback`],
  },

  publicClient: {
    redirectUris: ["http://localhost:8085/auth/callback"],
  },

  requiredResourceAccesses: [
    {
      resourceAppId: "00000003-0000-0000-c000-000000000000", // Microsoft Graph
      resourceAccesses: [
        {
          id: "e1fe6dd8-ba31-4d61-89e7-88639da4683d", // User.Read
          type: "Scope",
        },
      ],
    },
  ],

  optionalClaims: {
    accessTokens: [{ name: "groups" }],
    idTokens: [{ name: "groups" }],
    saml2Tokens: [{ name: "groups" }],
  },

  groupMembershipClaims: ["ApplicationGroup"],
});

const argoCDApplicationSSOSecret = new azuread.ApplicationPassword(
  "argcd-application-password-SSO",
  {
    applicationObjectId: argoCDApplication.objectId,
    displayName: "SSO",
    endDateRelative: "17520h", // 2 years
  }
);

const argocd = new kubernetes.helm.v3.Release(
  "argo-cd",
  {
    chart: "argo-cd",
    namespace: "argocd",
    createNamespace: true,
    repositoryOpts: {
      repo: "https://argoproj.github.io/argo-helm",
    },
    values: {
      server: {
        extraArgs: ["--insecure"],
        ingress: {
          enabled: true,
          annotations: {
            "external-dns.alpha.kubernetes.io/cloudflare-proxied": true,
          },
          ingressClassName: "nginx",
          hosts: [argocdIngressHost],
        },
      },
      configs: {
        cm: {
          url: `https://${argocdIngressHost}`,
          "admin.enabled": false,
          "oidc.config": argoCDApplication.applicationId.apply(
            (applicationId) =>
              `name: Azure\nissuer: https://login.microsoftonline.com/${azureNativeConfig.get(
                "tenantId"
              )}/v2.0\nclientID: ${applicationId}\nclientSecret: $oidc.azure.clientSecret\nrequestedIDTokenClaims:\n  groups:\n    essential: true\nrequestedScopes:\n- openid\n- profile\n- email\n`
          ),
        },
        secret: {
          extra: {
            "oidc.azure.clientSecret": argoCDApplicationSSOSecret.value,
          },
        },
        rbac: {
          "policy.default": "role:readonly",
          "policy.csv": argoCDAdminsGroup.objectId.apply(
            (id) => `g, "${id}", role:admin\n`
          ),
          scopes: "[groups, email]",
        },
      },
    },
  },
  { provider: k8sProvider }
);

new kubernetes.helm.v3.Release(
  "argocd-image-updater",
  {
    chart: "argocd-image-updater",
    namespace: "argocd",
    createNamespace: true,
    repositoryOpts: {
      repo: "https://argoproj.github.io/argo-helm",
    },
  },
  { provider: k8sProvider }
);

//
// RabbitMQ
//

const rabbitMQ = new kubernetes.helm.v3.Release(
  "rabbitmq-cluster-operator",
  {
    chart: "rabbitmq-cluster-operator",
    namespace: "default",
    createNamespace: true,
    repositoryOpts: {
      repo: "https://charts.bitnami.com/bitnami",
    },
  },
  { provider: k8sProvider }
);

new kubernetes.apiextensions.CustomResource(
  "rabbitmq-cluster",
  {
    apiVersion: "rabbitmq.com/v1beta1",
    kind: "RabbitmqCluster",
    metadata: {
      name: "rabbit-mq",
      namespace: "default",
    },
    spec: {
      resources: {
        requests: {
          cpu: "200m",
          memory: "1Gi",
        },
        limits: {
          cpu: "200m",
          memory: "1Gi",
        },
      },
    },
  },
  { provider: k8sProvider, dependsOn: [rabbitMQ] }
);

//
// ArgoCD Applications
//
new ArgoCDApplication(
  "ecommerce-login-ui",
  {
    name: "ecommerce-login-ui",
    imageName: "ghcr.io/jamess-lucass/ecommerce-login-ui",
    imageTag: "main",
    repoURL: "https://github.com/Jamess-Lucass/ecommerce-login-ui",
    path: "deploy/envs/prod",
  },
  { dependsOn: [argocd], provider: k8sProvider }
);

new ArgoCDApplication(
  "ecommerce-identity-service",
  {
    name: "ecommerce-identity-service",
    imageName: "ghcr.io/jamess-lucass/ecommerce-identity-service",
    imageTag: "main",
    repoURL: "https://github.com/Jamess-Lucass/ecommerce-identity-service",
    path: "deploy/envs/prod",
  },
  { dependsOn: [argocd], provider: k8sProvider }
);

new ArgoCDApplication(
  "ecommerce-user-service",
  {
    name: "ecommerce-user-service",
    imageName: "ghcr.io/jamess-lucass/ecommerce-user-service",
    imageTag: "main",
    repoURL: "https://github.com/Jamess-Lucass/ecommerce-user-service",
    path: "deploy/envs/prod",
  },
  { dependsOn: [argocd], provider: k8sProvider }
);

new ArgoCDApplication(
  "ecommerce-shop-ui",
  {
    name: "ecommerce-shop-ui",
    imageName: "ghcr.io/jamess-lucass/ecommerce-shop-ui",
    imageTag: "main",
    repoURL: "https://github.com/Jamess-Lucass/ecommerce-shop-ui",
    path: "deploy/envs/prod",
  },
  { dependsOn: [argocd], provider: k8sProvider }
);

new ArgoCDApplication(
  "ecommerce-internal-ui",
  {
    name: "ecommerce-internal-ui",
    imageName: "ghcr.io/jamess-lucass/ecommerce-internal-ui",
    imageTag: "main",
    repoURL: "https://github.com/Jamess-Lucass/ecommerce-internal-ui",
    path: "deploy/envs/prod",
  },
  { dependsOn: [argocd], provider: k8sProvider }
);

new ArgoCDApplication(
  "ecommerce-catalog-service",
  {
    name: "ecommerce-catalog-service",
    imageName: "ghcr.io/jamess-lucass/ecommerce-catalog-service",
    imageTag: "main",
    repoURL: "https://github.com/Jamess-Lucass/ecommerce-catalog-service",
    path: "deploy/envs/prod",
  },
  { dependsOn: [argocd], provider: k8sProvider }
);

new ArgoCDApplication(
  "ecommerce-basket-service",
  {
    name: "ecommerce-basket-service",
    imageName: "ghcr.io/jamess-lucass/ecommerce-basket-service",
    imageTag: "main",
    repoURL: "https://github.com/Jamess-Lucass/ecommerce-basket-service",
    path: "deploy/envs/prod",
  },
  { dependsOn: [argocd], provider: k8sProvider }
);

new ArgoCDApplication(
  "ecommerce-order-service",
  {
    name: "ecommerce-order-service",
    imageName: "ghcr.io/jamess-lucass/ecommerce-order-service",
    imageTag: "main",
    repoURL: "https://github.com/Jamess-Lucass/ecommerce-order-service",
    path: "deploy/envs/prod",
  },
  { dependsOn: [argocd], provider: k8sProvider }
);

new ArgoCDApplication(
  "ecommerce-email-service",
  {
    name: "ecommerce-email-service",
    imageName: "ghcr.io/jamess-lucass/ecommerce-email-service",
    imageTag: "main",
    repoURL: "https://github.com/Jamess-Lucass/ecommerce-email-service",
    path: "deploy/envs/prod",
  },
  { dependsOn: [argocd], provider: k8sProvider }
);

new ArgoCDApplication(
  "user-service",
  {
    name: "ecommerce-email-service",
    imageName: "ghcr.io/jamess-lucass/ecommerce-email-service",
    imageTag: "main",
    repoURL: "https://github.com/Jamess-Lucass/ecommerce-email-service",
    path: "deploy/envs/prod",
  },
  { dependsOn: [argocd], provider: k8sProvider }
);

//
// Elastic Cloud on Kubernetes (ECK)
//
const elasticVersion = "8.10.0";
const kibanaIngressHost = "kibana.jameslucas.uk";

const eck = new kubernetes.helm.v3.Release(
  "eck-operator",
  {
    chart: "eck-operator",
    namespace: "elastic-system",
    createNamespace: true,
    repositoryOpts: {
      repo: "https://helm.elastic.co",
    },
  },
  { provider: k8sProvider }
);

const elasticNamespace = new kubernetes.core.v1.Namespace(
  "elastic-namespace",
  {
    metadata: {
      name: "elastic",
    },
  },
  { provider: k8sProvider }
);

const elasticSearch = new kubernetes.apiextensions.CustomResource(
  "elastic-search",
  {
    apiVersion: "elasticsearch.k8s.elastic.co/v1",
    kind: "Elasticsearch",
    metadata: {
      name: "elastic-search",
      namespace: elasticNamespace.metadata.name,
    },
    spec: {
      version: elasticVersion,
      nodeSets: [
        {
          name: "master",
          count: 1,
          config: {
            "node.roles": ["master"],
            "node.store.allow_mmap": false,
          },
          podTemplate: {
            spec: {
              containers: [
                {
                  name: "elasticsearch",
                  image: `docker.elastic.co/elasticsearch/elasticsearch:${elasticVersion}`,
                  resources: {
                    requests: {
                      memory: "1Gi",
                      cpu: "200m",
                    },
                    limits: {
                      memory: "2Gi",
                    },
                  },
                },
              ],
            },
          },
        },
        {
          name: "worker",
          count: 2,
          config: {
            "node.roles": ["data", "ingest"],
            "node.store.allow_mmap": false,
          },
          volumeClaimTemplates: [
            {
              metadata: {
                name: "elasticsearch-data",
              },
              spec: {
                accessModes: ["ReadWriteOnce"],
                resources: {
                  requests: {
                    storage: "20Gi",
                  },
                },
                storageClassName: "default",
              },
            },
          ],
          podTemplate: {
            spec: {
              containers: [
                {
                  name: "elasticsearch",
                  image: `docker.elastic.co/elasticsearch/elasticsearch:${elasticVersion}`,
                  resources: {
                    requests: {
                      memory: "1Gi",
                      cpu: "200m",
                    },
                    limits: {
                      memory: "2Gi",
                    },
                  },
                },
              ],
            },
          },
        },
      ],
    },
  },
  {
    provider: k8sProvider,
    dependsOn: [eck],
  }
);

const fleetServerECKPolicyId = "eck-fleet-server";
const fleetServerName = "fleet-server";
const elasticAgentECKPolicyId = "eck-agent";

const kibana = new kubernetes.apiextensions.CustomResource(
  "kibana",
  {
    apiVersion: "kibana.k8s.elastic.co/v1",
    kind: "Kibana",
    metadata: {
      name: "kibana",
      namespace: elasticNamespace.metadata.name,
    },
    spec: {
      version: elasticVersion,
      http: {
        tls: {
          selfSignedCertificate: {
            disabled: true,
          },
        },
      },
      count: 1,
      elasticsearchRef: {
        name: elasticSearch.metadata.name,
        namespace: elasticSearch.metadata.namespace,
      },
      config: {
        "server.publicBaseUrl": `https://${kibanaIngressHost}`,
        "xpack.fleet.agents.elasticsearch.hosts": [
          elasticSearch.metadata.name.apply(
            (name) => `https://${name}-es-http.elastic.svc:9200`
          ),
        ],
        "xpack.fleet.agents.fleet_server.hosts": [
          `https://${fleetServerName}-agent-http.elastic.svc:8220`,
        ],
        "xpack.fleet.packages": [
          {
            name: "system",
            version: "latest",
          },
          {
            name: "elastic_agent",
            version: "latest",
          },
          {
            name: "fleet_server",
            version: "latest",
          },
          {
            name: "apm",
            version: "latest",
          },
        ],
        "xpack.fleet.agentPolicies": [
          {
            name: "Fleet Server on ECK policy",
            id: fleetServerECKPolicyId,
            is_default_fleet_server: true,
            namespace: elasticNamespace.metadata.name,
            monitoring_enabled: [],
            unenroll_timeout: 900,
            package_policies: [
              {
                name: "fleet_server-1",
                id: "fleet_server-1",
                package: {
                  name: "fleet_server",
                },
              },
            ],
          },
          {
            name: "Elastic Agent on ECK policy",
            id: elasticAgentECKPolicyId,
            namespace: elasticNamespace.metadata.name,
            monitoring_enabled: [],
            unenroll_timeout: 900,
            is_default: true,
            package_policies: [
              {
                name: "system-1",
                id: "system-1",
                package: {
                  name: "system",
                },
              },
              {
                package: {
                  name: "apm",
                },
                name: "apm-1",
                inputs: [
                  {
                    type: "apm",
                    enabled: true,
                    vars: [
                      {
                        name: "host",
                        value: "0.0.0.0:8200",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  },
  { provider: k8sProvider, dependsOn: [eck] }
);

new kubernetes.networking.v1.Ingress(
  "kibana-ingress",
  {
    metadata: {
      name: "kibana-ingress",
      namespace: elasticNamespace.metadata.name,
      annotations: {
        "external-dns.alpha.kubernetes.io/cloudflare-proxied": "true",
      },
    },
    spec: {
      ingressClassName: "nginx",
      rules: [
        {
          host: kibanaIngressHost,
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: {
                  service: {
                    name: kibana.metadata.name.apply(
                      (name) => `${name}-kb-http`
                    ),
                    port: {
                      number: 5601,
                    },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  },
  { provider: k8sProvider }
);

const heartbeat = new kubernetes.apiextensions.CustomResource(
  "heartbeat",
  {
    apiVersion: "beat.k8s.elastic.co/v1beta1",
    kind: "Beat",
    metadata: {
      name: "heartbeat",
      namespace: elasticNamespace.metadata.name,
    },
    spec: {
      type: "heartbeat",
      version: elasticVersion,
      elasticsearchRef: {
        name: elasticSearch.metadata.name,
        namespace: elasticSearch.metadata.namespace,
      },
      config: {
        "heartbeat.monitors": [
          {
            type: "http",
            id: "identity-service",
            tags: ["identity", "service"],
            name: "Identity Service",
            schedule: "@every 10s",
            hosts: ["ecommerce-identity-service.default.svc:80/api/healthz"],
            "check.response": {
              status: [200],
              body: ["Healthy"],
            },
          },
          {
            type: "http",
            id: "user-service",
            tags: ["user", "service"],
            name: "User Service",
            schedule: "@every 10s",
            hosts: ["ecommerce-user-service.default.svc:80/api/healthz"],
            "check.response": {
              status: [200],
              body: ["Healthy"],
            },
          },
          {
            type: "http",
            id: "catalog-service",
            tags: ["catalog", "service"],
            name: "Catalog Service",
            schedule: "@every 10s",
            hosts: ["ecommerce-catalog-service.default.svc:80/api/healthz"],
            "check.response": {
              status: [200],
              body: ["Healthy"],
            },
          },
          {
            type: "http",
            id: "basket-service",
            tags: ["basket", "service"],
            name: "Basket Service",
            schedule: "@every 10s",
            hosts: ["ecommerce-basket-service.default.svc:80/api/healthz"],
            "check.response": {
              status: [200],
              body: ["Healthy"],
            },
          },
          {
            type: "http",
            id: "order-service",
            tags: ["order", "service"],
            name: "Order Service",
            schedule: "@every 10s",
            hosts: ["ecommerce-order-service.default.svc:80/api/healthz"],
            "check.response": {
              status: [200],
              body: ["Healthy"],
            },
          },
          {
            type: "http",
            id: "email-service",
            tags: ["email", "service"],
            name: "Email Service",
            schedule: "@every 10s",
            hosts: ["ecommerce-email-service.default.svc:80/api/healthz"],
            "check.response": {
              status: [200],
              body: ["Healthy"],
            },
          },
          {
            type: "http",
            id: "login-ui",
            tags: ["login", "ui"],
            name: "Login UI",
            schedule: "@every 10s",
            urls: "ecommerce-login-ui.default.svc:80",
            "check.response": {
              status: [200],
            },
          },
          {
            type: "http",
            id: "shop-ui",
            tags: ["shop", "ui"],
            name: "Shop UI",
            schedule: "@every 10s",
            urls: "ecommerce-shop-ui.default.svc:80",
            "check.response": {
              status: [200],
            },
          },
          {
            type: "http",
            id: "internal-ui",
            tags: ["internal", "ui"],
            name: "Internal UI",
            schedule: "@every 10s",
            urls: "ecommerce-internal-ui.default.svc:80",
            "check.response": {
              status: [200],
            },
          },
        ],
      },
      deployment: {
        podTemplate: {
          spec: {
            dnsPolicy: "ClusterFirstWithHostNet",
            securityContext: {
              runAsUser: 0,
            },
          },
        },
      },
    },
  },
  { provider: k8sProvider, dependsOn: [eck] }
);

const filebeatServiceAccount = new kubernetes.core.v1.ServiceAccount(
  "filebeat",
  {
    metadata: {
      name: "filebeat",
      namespace: elasticNamespace.metadata.name,
    },
  },
  { provider: k8sProvider }
);

new kubernetes.rbac.v1.ClusterRoleBinding(
  "filebeat",
  {
    metadata: {
      name: "filebeat",
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: filebeatServiceAccount.metadata.name,
        namespace: filebeatServiceAccount.metadata.namespace,
      },
    ],
    roleRef: {
      kind: "ClusterRole",
      name: "view", // Role created by AKS
      apiGroup: "rbac.authorization.k8s.io",
    },
  },
  { provider: k8sProvider }
);

new kubernetes.apiextensions.CustomResource(
  "filebeat",
  {
    apiVersion: "beat.k8s.elastic.co/v1beta1",
    kind: "Beat",
    metadata: {
      name: "filebeat",
      namespace: elasticNamespace.metadata.name,
    },
    spec: {
      type: "filebeat",
      version: elasticVersion,
      elasticsearchRef: {
        name: elasticSearch.metadata.name,
        namespace: elasticSearch.metadata.namespace,
      },
      kibanaRef: {
        name: kibana.metadata.name,
        namespace: kibana.metadata.namespace,
      },
      config: {
        monitoring: {
          enabled: false,
        },
        "filebeat.autodiscover.providers": [
          {
            node: "${NODE_NAME}",
            type: "kubernetes",
            "hints.default_config.enabled": "false",
            templates: [
              {
                "condition.equals.kubernetes.labels.elastic.logging/enabled":
                  "true",
                config: [
                  {
                    paths: [
                      "/var/log/containers/*${data.kubernetes.container.id}.log",
                    ],
                    type: "container",
                    json: {
                      keys_under_root: true,
                      message_key: "json",
                      overwrite_keys: true,
                      add_error_key: true,
                      expand_keys: true,
                      ignore_decoding_error: true,
                    },
                  },
                ],
              },
            ],
          },
        ],
        processors: [
          {
            add_cloud_metadata: {},
          },
          {
            add_host_metadata: {},
          },
          {
            add_kubernetes_metadata: {},
          },
          {
            drop_event: {
              when: {
                contains: {
                  "json.error.message": "Error decoding JSON",
                },
              },
            },
          },
        ],
      },
      daemonSet: {
        podTemplate: {
          spec: {
            serviceAccountName: filebeatServiceAccount.metadata.name,
            automountServiceAccountToken: true,
            terminationGracePeriodSeconds: 30,
            dnsPolicy: "ClusterFirstWithHostNet",
            hostNetwork: true,
            containers: [
              {
                name: "filebeat",
                resources: {},
                securityContext: {
                  runAsUser: 0,
                },
                volumeMounts: [
                  {
                    name: "varlogcontainers",
                    mountPath: "/var/log/containers",
                  },
                  {
                    name: "varlogpods",
                    mountPath: "/var/log/pods",
                  },
                  {
                    name: "varlibdockercontainers",
                    mountPath: "/var/lib/docker/containers",
                  },
                ],
                env: [
                  {
                    name: "NODE_NAME",
                    valueFrom: {
                      fieldRef: {
                        fieldPath: "spec.nodeName",
                      },
                    },
                  },
                ],
              },
            ],
            volumes: [
              {
                name: "varlogcontainers",
                hostPath: {
                  path: "/var/log/containers",
                },
              },
              {
                name: "varlogpods",
                hostPath: {
                  path: "/var/log/pods",
                },
              },
              {
                name: "varlibdockercontainers",
                hostPath: {
                  path: "/var/lib/docker/containers",
                },
              },
            ],
          },
        },
      },
    },
  },
  { provider: k8sProvider }
);

const fleetServerClusterRole = new kubernetes.rbac.v1.ClusterRole(
  "fleet-server",
  {
    metadata: {
      name: "fleet-server",
    },
    rules: [
      {
        apiGroups: [""],
        resources: ["pods", "namespaces", "nodes"],
        verbs: ["get", "watch", "list"],
      },
      {
        apiGroups: ["coordination.k8s.io"],
        resources: ["leases"],
        verbs: ["get", "create", "update"],
      },
    ],
  },
  { provider: k8sProvider }
);

const fleetServerServiceAccount = new kubernetes.core.v1.ServiceAccount(
  "fleet-server",
  {
    metadata: {
      name: "fleet-server",
      namespace: elasticNamespace.metadata.name,
    },
  },
  { provider: k8sProvider }
);

new kubernetes.rbac.v1.ClusterRoleBinding(
  "fleet-server",
  {
    metadata: {
      name: "fleet-server",
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: fleetServerServiceAccount.metadata.name,
        namespace: fleetServerServiceAccount.metadata.namespace,
      },
    ],
    roleRef: {
      kind: "ClusterRole",
      name: fleetServerClusterRole.metadata.name,
      apiGroup: "rbac.authorization.k8s.io",
    },
  },
  { provider: k8sProvider }
);

const elasticAgentClusterRole = new kubernetes.rbac.v1.ClusterRole(
  "elastic-agent",
  {
    metadata: {
      name: "elastic-agent",
    },
    rules: [
      {
        apiGroups: [""],
        resources: [
          "pods",
          "nodes",
          "namespaces",
          "events",
          "services",
          "configmaps",
        ],
        verbs: ["get", "watch", "list"],
      },
      {
        apiGroups: ["coordination.k8s.io"],
        resources: ["leases"],
        verbs: ["get", "create", "update"],
      },
      {
        nonResourceURLs: ["/metrics"],
        verbs: ["get"],
      },
      {
        apiGroups: ["extensions"],
        resources: ["replicasets"],
        verbs: ["get", "list", "watch"],
      },
      {
        apiGroups: ["apps"],
        resources: ["statefulsets", "deployments", "replicasets"],
        verbs: ["get", "list", "watch"],
      },
      {
        apiGroups: [""],
        resources: ["nodes/stats"],
        verbs: ["get"],
      },
      {
        apiGroups: ["batch"],
        resources: ["jobs"],
        verbs: ["get", "list", "watch"],
      },
    ],
  },
  { provider: k8sProvider }
);

const elasticAgentServiceAccount = new kubernetes.core.v1.ServiceAccount(
  "elastic-agent",
  {
    metadata: {
      name: "elastic-agent",
      namespace: elasticNamespace.metadata.name,
    },
  },
  { provider: k8sProvider }
);

new kubernetes.rbac.v1.ClusterRoleBinding(
  "elastic-agent",
  {
    metadata: {
      name: "elastic-agent",
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: elasticAgentServiceAccount.metadata.name,
        namespace: elasticAgentServiceAccount.metadata.namespace,
      },
    ],
    roleRef: {
      kind: "ClusterRole",
      name: elasticAgentClusterRole.metadata.name,
      apiGroup: "rbac.authorization.k8s.io",
    },
  },
  { provider: k8sProvider }
);

const fleetServer = new kubernetes.apiextensions.CustomResource(
  "fleet-server",
  {
    apiVersion: "agent.k8s.elastic.co/v1alpha1",
    kind: "Agent",
    metadata: {
      name: fleetServerName,
      namespace: elasticNamespace.metadata.name,
    },
    spec: {
      version: elasticVersion,
      kibanaRef: {
        name: kibana.metadata.name,
        namespace: kibana.metadata.namespace,
      },
      elasticsearchRefs: [
        {
          name: elasticSearch.metadata.name,
          namespace: elasticSearch.metadata.namespace,
        },
      ],
      mode: "fleet",
      fleetServerEnabled: true,
      policyID: fleetServerECKPolicyId,
      deployment: {
        replicas: 1,
        podTemplate: {
          spec: {
            serviceAccountName: fleetServerServiceAccount.metadata.name,
            automountServiceAccountToken: true,
            securityContext: {
              runAsUser: 0,
            },
          },
        },
      },
    },
  },
  { provider: k8sProvider }
);

const elasticAgent = new kubernetes.apiextensions.CustomResource(
  "elastic-agent",
  {
    apiVersion: "agent.k8s.elastic.co/v1alpha1",
    kind: "Agent",
    metadata: {
      name: "elastic-agent",
      namespace: elasticNamespace.metadata.name,
    },
    spec: {
      version: elasticVersion,
      kibanaRef: {
        name: kibana.metadata.name,
        namespace: kibana.metadata.namespace,
      },
      fleetServerRef: {
        name: fleetServer.metadata.name,
        namespace: fleetServer.metadata.namespace,
      },
      mode: "fleet",
      policyID: elasticAgentECKPolicyId,
      daemonSet: {
        podTemplate: {
          spec: {
            serviceAccountName: elasticAgentServiceAccount.metadata.name,
            automountServiceAccountToken: true,
            securityContext: {
              runAsUser: 0,
            },
            containers: [
              {
                name: "agent",
                resources: {},
                volumeMounts: [
                  {
                    mountPath: "/var/lib/docker/containers",
                    name: "varlibdockercontainers",
                  },
                  {
                    mountPath: "/var/log/containers",
                    name: "varlogcontainers",
                  },
                  {
                    mountPath: "/var/log/pods",
                    name: "varlogpods",
                  },
                ],
              },
            ],
            volumes: [
              {
                name: "varlibdockercontainers",
                hostPath: {
                  path: "/var/lib/docker/containers",
                },
              },
              {
                name: "varlogcontainers",
                hostPath: {
                  path: "/var/log/containers",
                },
              },
              {
                name: "varlogpods",
                hostPath: {
                  path: "/var/log/pods",
                },
              },
            ],
          },
        },
      },
    },
  },
  { provider: k8sProvider }
);

new kubernetes.core.v1.Service(
  "apm",
  {
    metadata: {
      name: "apm",
      namespace: elasticNamespace.metadata.name,
    },
    spec: {
      selector: {
        "agent.k8s.elastic.co/name": elasticAgent.metadata.name,
      },
      ports: [
        {
          protocol: "TCP",
          port: 8200,
        },
      ],
    },
  },
  { provider: k8sProvider }
);
