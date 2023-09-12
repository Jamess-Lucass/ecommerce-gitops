import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";
import * as azuread from "@pulumi/azuread";
import * as cluster from "./cluster";
import * as config from "./config";

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

new kubernetes.helm.v3.Release(
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
          "oidc.config": {
            name: "Azure",
            issuer: `https://login.microsoftonline.com/${azureNativeConfig.get(
              "tenantId"
            )}/v2.0`,
            clientID: argoCDApplication.applicationId,
            clientSecret: "$oidc.azure.clientSecret",
            requestedIDTokenClaims: {
              groups: {
                essential: true,
              },
            },
            requestedScopes: ["openid", "profile", "email"],
          },
        },
        secret: {
          extra: {
            "oidc.azure.clientSecret": argoCDApplicationSSOSecret.value,
          },
        },
        rbac: {
          "policy.default": "role:readonly",
          "policy.csv": argoCDAdminsGroup.objectId.apply(
            (id) => `g, ${id}, role:admin\n`
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

new 