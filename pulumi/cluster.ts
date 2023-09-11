import * as pulumi from "@pulumi/pulumi";
import * as azure_native from "@pulumi/azure-native";
import * as azuread from "@pulumi/azuread";
import * as yaml from "js-yaml";
import { roles } from "./role-definitions";
import * as config from "./config";

type KubeConfig = {
  users: KubeConfigUser[];
};

type KubeConfigUser = {
  name: string;
  user: {
    exec: {
      command: string;
      apiVersion: string;
      args: string[];
    };
  };
};

const azureNativeConfig = new pulumi.Config("azure-native");
const azureADConfig = new pulumi.Config("azuread");
const current = azuread.getClientConfig({});

const vnetName = "vnet-01";
const kubernetesVersion = "1.27.3";
const clusterName = "aks-ecommerce-demo-01";
const keyvaultWorkloadIdentityDefaultName = `azurekeyvaultsecretsprovider-${clusterName}`;
const nodePoolResourceGroupName = "rg-ecommerce-demo-01-nodepools";

//
// Groups
//
const clusterAdminsGroup = new azuread.Group("example", {
  displayName: "aks-cluster-admins",
  description: `Principals in this group are cluster admins of ${clusterName}`,
  owners: [current.then((current) => current.objectId)],
  securityEnabled: true,
});

//
// Resource Group
//
const resourceGroup = new azure_native.resources.ResourceGroup("rg", {
  resourceGroupName: "rg-ecommerce-demo-01",
});

//
// Network Security Group
//
const nsgNodepoolSubnet = new azure_native.network.NetworkSecurityGroup(
  "nsg-node-pool-subnet",
  {
    resourceGroupName: resourceGroup.name,
    networkSecurityGroupName: `nsg-${vnetName}-nodepools`,
    securityRules: [
      {
        name: "Allow443Inbound",
        description: "Allow ALL web traffic into 443.",
        protocol: "TCP",
        sourcePortRange: "*",
        sourceAddressPrefix: "Internet",
        destinationPortRange: "443",
        destinationAddressPrefix: "Internet",
        direction: "Inbound",
        access: "Allow",
        priority: 100,
      },
    ],
  },
  { dependsOn: [resourceGroup] }
);

//
// Virtual Network
//
const vnet = new azure_native.network.VirtualNetwork(
  "vnet-01",
  {
    resourceGroupName: resourceGroup.name,
    virtualNetworkName: vnetName,
    addressSpace: {
      addressPrefixes: ["10.240.0.0/16"],
    },
  },
  { dependsOn: [resourceGroup] }
);

//
// Subnet
//
const snetClusterNodes = new azure_native.network.Subnet(
  "subnet-cluster-nodes",
  {
    resourceGroupName: resourceGroup.name,
    subnetName: "snet-clusternodes",
    virtualNetworkName: vnet.name,
    addressPrefix: "10.240.0.0/22",
    privateEndpointNetworkPolicies: "Disabled",
    privateLinkServiceNetworkPolicies: "Disabled",
    networkSecurityGroup: {
      id: nsgNodepoolSubnet.id,
    },
  },
  {
    dependsOn: [resourceGroup, vnet, nsgNodepoolSubnet],
  }
);

//
// Managed Identities
//
const miClusterControlPlane =
  new azure_native.managedidentity.UserAssignedIdentity(
    "user-assigned-identity-control-plan",
    {
      resourceGroupName: resourceGroup.name,
      resourceName: `mi-${clusterName}-controlplane`,
    },
    { dependsOn: [resourceGroup] }
  );

//
// Role Assingment
//
new azure_native.authorization.RoleAssignment(
  "role-assignment-subnet-control-plane-network-contributor",
  {
    principalId: miClusterControlPlane.principalId,
    principalType: azure_native.authorization.PrincipalType.ServicePrincipal,
    roleDefinitionId: roles.networkContributor.id,
    scope: snetClusterNodes.id,
  },
  { dependsOn: [snetClusterNodes, miClusterControlPlane] }
);

//
// Azure Kubernetes Service
//
export const aks =
  new azure_native.containerservice.v20230702preview.ManagedCluster(
    "aks",
    {
      resourceGroupName: resourceGroup.name,
      resourceName: clusterName,
      sku: {
        name: "Base",
        tier: "Standard",
      },
      dnsPrefix: "jamess-lucass-ecommerce-demo",
      kubernetesVersion: kubernetesVersion,
      agentPoolProfiles: [
        {
          name: "npsystem",
          count: 3,
          vmSize: "Standard_DS2_v2",
          osDiskSizeGB: 30,
          osDiskType: "Ephemeral",
          osType: "Linux",
          osSKU: "Ubuntu",
          minCount: 3,
          maxCount: 4,
          vnetSubnetID: snetClusterNodes.id,
          enableAutoScaling: true,
          enableCustomCATrust: false,
          enableFIPS: false,
          enableEncryptionAtHost: false,
          type: "VirtualMachineScaleSets",
          mode: "System",
          scaleSetPriority: "Regular",
          scaleSetEvictionPolicy: "Delete",
          orchestratorVersion: kubernetesVersion,
          enableNodePublicIP: false,
          maxPods: 30,
          availabilityZones: ["1", "2", "3"],
          upgradeSettings: {
            maxSurge: "33%",
          },
          nodeTaints: ["CriticalAddonsOnly=true:NoSchedule"],
        },
        {
          name: "npuser01",
          count: 2,
          vmSize: "Standard_DS3_v2",
          osDiskSizeGB: 120,
          osDiskType: "Ephemeral",
          osType: "Linux",
          minCount: 2,
          maxCount: 5,
          vnetSubnetID: snetClusterNodes.id,
          enableAutoScaling: true,
          enableCustomCATrust: false,
          enableFIPS: false,
          enableEncryptionAtHost: false,
          type: "VirtualMachineScaleSets",
          mode: "User",
          scaleSetPriority: "Regular",
          scaleSetEvictionPolicy: "Delete",
          orchestratorVersion: kubernetesVersion,
          enableNodePublicIP: false,
          maxPods: 30,
          availabilityZones: ["1", "2", "3"],
          upgradeSettings: {
            maxSurge: "33%",
          },
        },
      ],
      servicePrincipalProfile: {
        clientId: "msi",
      },
      addonProfiles: {
        httpApplicationRouting: {
          enabled: false,
        },
        omsagent: {
          enabled: false,
        },
        aciConnectorLinux: {
          enabled: false,
        },
        azurepolicy: {
          enabled: true,
          config: {
            version: "v2",
          },
        },
        azureKeyvaultSecretsProvider: {
          enabled: true,
          config: {
            enableSecretRotation: "false",
          },
        },
      },
      nodeResourceGroup: nodePoolResourceGroupName,
      enableRBAC: true,
      enablePodSecurityPolicy: false,
      networkProfile: {
        loadBalancerProfile: {
          managedOutboundIPs: {
            count: 2,
          },
        },
        loadBalancerSku: "standard",
        outboundType: "loadBalancer",
      },
      aadProfile: {
        managed: true,
        enableAzureRBAC: true,
        adminGroupObjectIDs: [],
        tenantID: azureNativeConfig.require("tenantId"),
      },
      autoScalerProfile: {
        balanceSimilarNodeGroups: "false",
        expander: "random",
        maxEmptyBulkDelete: "10",
        maxGracefulTerminationSec: "600",
        maxNodeProvisionTime: "15m",
        maxTotalUnreadyPercentage: "45",
        newPodScaleUpDelay: "0s",
        okTotalUnreadyCount: "3",
        scaleDownDelayAfterAdd: "10m",
        scaleDownDelayAfterDelete: "20s",
        scaleDownDelayAfterFailure: "3m",
        scaleDownUnneededTime: "10m",
        scaleDownUnreadyTime: "20m",
        scaleDownUtilizationThreshold: "0.5",
        scanInterval: "10s",
        skipNodesWithLocalStorage: "true",
        skipNodesWithSystemPods: "true",
      },
      apiServerAccessProfile: {
        authorizedIPRanges: [],
        enablePrivateCluster: false,
      },
      podIdentityProfile: {
        enabled: false,
      },
      autoUpgradeProfile: {
        upgradeChannel: "stable",
      },
      storageProfile: {
        blobCSIDriver: {
          enabled: false,
        },
        diskCSIDriver: {
          enabled: false,
        },
        fileCSIDriver: {
          enabled: false,
        },
        snapshotController: {
          enabled: false,
        },
      },
      disableLocalAccounts: true,
      securityProfile: {
        workloadIdentity: {
          enabled: true,
        },
        nodeRestriction: {
          enabled: true, // https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/#noderestriction
        },
        customCATrustCertificates: [],
      },
      oidcIssuerProfile: {
        enabled: true,
      },
      enableNamespaceResources: false,
      identity: {
        type: azure_native.containerservice.ResourceIdentityType.UserAssigned,
        userAssignedIdentities: [miClusterControlPlane.id],
      },
    },
    {
      dependsOn: [resourceGroup, miClusterControlPlane, snetClusterNodes],
    }
  );

//
// Role Assingment
//
new azure_native.authorization.RoleAssignment(
  "role-assignment-service-principal-aks-cluster-admin",
  {
    principalId: current.then((current) => current.objectId),
    principalType: azure_native.authorization.PrincipalType.ServicePrincipal,
    roleDefinitionId: roles.clusterAdmin.id,
    scope: aks.id,
  },
  { dependsOn: [aks] }
);

//
// Role Assingment
//
new azure_native.authorization.RoleAssignment(
  "role-assignment-aad-group-cluster-admins",
  {
    principalId: clusterAdminsGroup.objectId,
    principalType: azure_native.authorization.PrincipalType.Group,
    roleDefinitionId: roles.clusterAdmin.id,
    scope: aks.id,
  },
  { dependsOn: [aks, clusterAdminsGroup] }
);

export const keyvaultAddonProfile = aks.addonProfiles.apply(
  (x) => x!["azureKeyvaultSecretsProvider"]
);

//
// Role Assingment
//
new azure_native.managedidentity.FederatedIdentityCredential(
  "federated-identity-credentials-aks-keyvault-identity",
  {
    resourceGroupName: nodePoolResourceGroupName,
    federatedIdentityCredentialResourceName: `${keyvaultWorkloadIdentityDefaultName}-credentials`,
    resourceName: keyvaultWorkloadIdentityDefaultName,
    audiences: ["api://AzureADTokenExchange"],
    issuer: aks.oidcIssuerProfile.apply((x) => x?.issuerURL ?? ""),
    subject: `system:serviceaccount:${config.workloadNamespace}:${config.workloadName}`,
  },
  { dependsOn: [aks] }
);

//
// Key Vault
//
export const kv = new azure_native.keyvault.Vault(
  "key-vault",
  {
    resourceGroupName: resourceGroup.name,
    vaultName: `kv-${clusterName}`,
    properties: {
      accessPolicies: [],
      sku: {
        family: "A",
        name: "standard",
      },
      tenantId: azureNativeConfig.require("tenantId"),
      networkAcls: {
        bypass: "AzureServices",
        defaultAction: "Deny",
        ipRules: [],
        virtualNetworkRules: [],
      },
      enableRbacAuthorization: true,
      enabledForDeployment: false,
      enabledForDiskEncryption: false,
      enabledForTemplateDeployment: false,
      enableSoftDelete: true,
      softDeleteRetentionInDays: 7,
      createMode: "default",
    },
  },
  { dependsOn: [resourceGroup] }
);

//
// Role Assingment
//
new azure_native.authorization.RoleAssignment(
  "role-assignment-managed-identity-aks-keyvault-secrets-user",
  {
    principalId: keyvaultAddonProfile.apply((x) => x.identity.objectId!),
    principalType: azure_native.authorization.PrincipalType.ServicePrincipal,
    roleDefinitionId: roles.keyVaultSecretsUser.id,
    scope: kv.id,
  },
  { dependsOn: [kv, aks] }
);

//
// Role Assingment
//
new azure_native.authorization.RoleAssignment(
  "role-assignment-managed-identity-aks-keyvault-reader-user",
  {
    principalId: keyvaultAddonProfile.apply((x) => x.identity.objectId!),
    principalType: azure_native.authorization.PrincipalType.ServicePrincipal,
    roleDefinitionId: roles.keyVaultReader.id,
    scope: kv.id,
  },
  { dependsOn: [kv, aks] }
);

//
// KubeConfig
//
const creds =
  azure_native.containerservice.listManagedClusterUserCredentialsOutput({
    resourceGroupName: resourceGroup.name,
    resourceName: aks.name,
  });

const aksKubeConfig = creds.kubeconfigs[0].value.apply((enc) =>
  Buffer.from(enc, "base64").toString()
);

let kubeconfigObject = aksKubeConfig.apply((rawKubeConfig) => {
  let config = yaml.load(rawKubeConfig) as KubeConfig;

  // Override the exec section. Replace with your configuration.
  if (config.users && config.users.length > 0) {
    config.users[0].user.exec = {
      apiVersion: "client.authentication.k8s.io/v1beta1",
      command: "./exec/kubelogin",
      args: [
        "get-token",
        "--login",
        "spn",
        "--environment",
        "AzurePublicCloud",
        "--tenant-id",
        azureADConfig.get("tenantId") ?? "",
        "--server-id",
        "6dae42f8-4368-4678-94ff-3960e28e3630", // https://azure.github.io/kubelogin/concepts/aks.html#azure-kubernetes-service-aad-server
        "--client-id",
        azureADConfig.get("clientId") ?? "",
        "--client-secret",
        azureADConfig.get("clientSecret") ?? "",
      ],
    };
  }
  return config;
});

export const kubeConfig = kubeconfigObject.apply((config) =>
  JSON.stringify(config ?? {})
);
