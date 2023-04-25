# ecommerce-gitops

# Prerequisites

- Azure CLI
- Terraform
- Kustomize
- Azure account & Azure Subscription
- Make
- kubeseal

# Creating an AKS Cluster

1. Create your `.env` file

   ```bash
   cp .env.example .env
   ```

2. Sign into Azure Cli

   ```bash
   az login
   ```

3. Change context to correct Azure Subscription

   ```bash
   az account set --subscription "<your-subscription-id>"
   ```

4. Create a service principal

   > This is what terraform will use to authenticate against your Azure tenant and subscription to create and manage the resources.

   ```bash
   az ad sp create-for-rbac --role="Contributor" --scopes="/subscriptions/<your-subscription-id>"
   ```

5. Set the values inside your `.env` file

   ```bash
   ARM_CLIENT_ID="<appId>"
   ARM_CLIENT_SECRET="<password>"
   ARM_SUBSCRIPTION_ID="<your-subscription-id>"
   ARM_TENANT_ID="<tenant>"
   ```

6. Initialize terraform

   ```bash
   terraform init
   ```

7. Apply the terraform configuration

   > This will pipe the values inside your `.env` file into the terraform apply command.

   ```bash
   make terraform-apply
   ```

8. Wait for your resources to be created.

   > Terraform will notify you via your terminal when it has completed, after, please proceed onto bootstrapping your cluster.

# Bootstrapping the cluster

> If you wish to use this, please fork the repository and then you may override the `SealedSecrets` with your own values.

1. Install the CRDs

   ```bash
   kubectl apply -k ./bootstrap/envs/prod/CRDs
   ```

2. Seal your secret

   > The SealedSecrets CRD creates a private key within your cluster, this is used to descrypt your secrets, when using kubeseal it will use a public key
   > and encrypt your secrets using that. If you delete the `sealed-secrets-controller` then you will need to re-encrypt your secrets.

   > An example for creating a generic secret is:

   ```bash
   kubectl create secret generic jwt-secret --from-literal=value='<fake-value>' --dry-run=client -o yaml | kubeseal -o yaml
   ```

Overwrite any secrets in the bootstrap with the ones created by using the above command.

2. Install the bootstrap resources.

   ```bash
   kubectl apply -k ./bootstrap/envs/prod
   ```

3. Head to any of the ecommerce repositories and install the service

   > Run the below command at the root directoy of the ecommerce service repositories.

   ```bash
   kubectl apply -k ./deploy/envs/prod
   ```
