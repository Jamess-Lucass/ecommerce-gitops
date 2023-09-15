import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";

interface ArgoCDApplicationArgs {
  name: pulumi.Input<string>;
  imageName: pulumi.Input<string>;
  imageTag: pulumi.Input<string>;
  repoURL: pulumi.Input<string>;
  path: pulumi.Input<string>;
}

export class ArgoCDApplication extends pulumi.ComponentResource {
  constructor(
    name: string,
    args: ArgoCDApplicationArgs,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("kubernetes:argocd:application", name, args, opts);

    new kubernetes.apiextensions.CustomResource(
      name,
      {
        apiVersion: "argoproj.io/v1alpha1",
        kind: "Application",
        metadata: {
          name: args.name,
          namespace: "argocd",
          annotations: {
            "argocd-image-updater.argoproj.io/image-list": `myimage=${args.imageName}:${args.imageTag}`,
            "argocd-image-updater.argoproj.io/myimage.update-strategy":
              "digest",
          },
        },
        spec: {
          project: "default",
          source: {
            repoURL: args.repoURL,
            targetRevision: "HEAD",
            path: args.path,
          },
          destination: {
            server: "https://kubernetes.default.svc",
            namespace: "default",
          },
          ignoreDifferences: [
            {
              group: "apps",
              kind: "Deployment",
              jsonPointers: ["/spec/replicas"],
            },
            {
              group: "autoscaling",
              kind: "HorizontalPodAutoscaler",
              jsonPointers: ["/spec/metrics"],
            },
          ],
          syncPolicy: {
            automated: {
              prune: true,
              selfHeal: true,
            },
            syncOptions: ["CreateNamespace=true"],
          },
        },
      },
      { parent: this, ...opts }
    );
  }
}
