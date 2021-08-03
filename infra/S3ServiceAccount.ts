import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as k8s from '@pulumi/kubernetes';

export interface S3ServiceAccountArgs {
  oidcProvider: aws.iam.OpenIdConnectProvider;
  namespace: pulumi.Input<string>;
  readOnly: pulumi.Input<boolean>;
}

export default class S3ServiceAccount extends pulumi.ComponentResource {
  public /*out*/ readonly name: pulumi.Output<string>;
  public /*out*/ readonly serviceAccount: pulumi.Output<k8s.core.v1.ServiceAccount>;
  public /*out*/ readonly role: pulumi.Output<aws.iam.Role>;

  constructor(name: string, args: S3ServiceAccountArgs, opts?: pulumi.ResourceOptions) {
    super("pkg:index:S3ServiceAccount", name, {}, opts);

    // Create the new IAM policy for the Service Account using the AssumeRoleWebWebIdentity action.
    const serviceAccountAssumeRolePolicy = pulumi
      .all([args.oidcProvider.url, args.oidcProvider.arn, args.namespace])
      .apply(([url, arn, namespace]: string[]) =>
        aws.iam.getPolicyDocument({
          statements: [
            {
              actions: ['sts:AssumeRoleWithWebIdentity'],
              conditions: [{
                test: 'StringEquals',
                values: [`system:serviceaccount:${namespace}:${name}`],
                variable: `${url.replace('https://', '')}:sub`,
              },],
              effect: 'Allow',
              principals: [{identifiers: [arn], type: 'Federated'}],
            },
          ],
        })
      );

    // Create a new IAM role that assumes the AssumeRoleWebWebIdentity policy.
    const serviceAccountRole = new aws.iam.Role(name, {
      assumeRolePolicy: serviceAccountAssumeRolePolicy.json,
    });

    // Attach the IAM role to an AWS S3 access policy.
    new aws.iam.RolePolicyAttachment(name, {
      policyArn: args.readOnly ? 
        'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess' :
        'arn:aws:iam::aws:policy/AmazonS3FullAccess',
      role: serviceAccountRole,
    });

    // Create a Service Account with the IAM role annotated to use with the Pod.
    this.serviceAccount = pulumi.output(new k8s.core.v1.ServiceAccount(name, {
      metadata: {
        namespace: args.namespace,
        name,
        annotations: {
          'eks.amazonaws.com/role-arn': serviceAccountRole.arn,
        },
      },
    }, { provider: opts?.provider }));

    this.name = pulumi.output(this.serviceAccount.metadata.name);
    this.role = pulumi.output(serviceAccountRole);

    super.registerOutputs({
      name: this.serviceAccount.metadata.name,
      serviceAccount: this.serviceAccount,
      role: serviceAccountRole,
    });
  }
}
