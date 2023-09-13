import * as pulumi from "@pulumi/pulumi";
import * as azure_native from "@pulumi/azure-native";

const azureNativeConfig = new pulumi.Config("azure-native");
const subscriptionId = azureNativeConfig.require("subscriptionId");

const clusterAdmin = azure_native.authorization.getRoleDefinitionOutput({
  roleDefinitionId: "b1ff04bb-8a4e-4dc4-8eb5-8693973ce19b",
  scope: `subscriptions/${subscriptionId}`,
});

const networkContributor = azure_native.authorization.getRoleDefinitionOutput({
  roleDefinitionId: "4d97b98b-1d4f-4787-a291-c67834d212e7",
  scope: `subscriptions/${subscriptionId}`,
});

const keyVaultSecretsUser = azure_native.authorization.getRoleDefinitionOutput({
  roleDefinitionId: "4633458b-17de-408a-b874-0445c86b69e6",
  scope: `subscriptions/${subscriptionId}`,
});

const keyVaultReader = azure_native.authorization.getRoleDefinitionOutput({
  roleDefinitionId: "21090545-7ca7-4776-b22c-e363652d74d2",
  scope: `subscriptions/${subscriptionId}`,
});

const keyVaultAdministrator =
  azure_native.authorization.getRoleDefinitionOutput({
    roleDefinitionId: "00482a5a-887f-4fb3-b363-3b7fe8e74483",
    scope: `subscriptions/${subscriptionId}`,
  });

export const roles = {
  clusterAdmin,
  networkContributor,
  keyVaultSecretsUser,
  keyVaultReader,
  keyVaultAdministrator,
};
