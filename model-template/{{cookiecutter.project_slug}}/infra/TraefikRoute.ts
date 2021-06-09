import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';

export interface TraefikRouteArgs {
  namespace: pulumi.Input<string>;
  prefix: pulumi.Input<string>;
  service: pulumi.Input<k8s.core.v1.Service>;
}

export default class TraefikRoute extends pulumi.ComponentResource {
  constructor(name: string, args: TraefikRouteArgs, opts?: pulumi.ResourceOptions) {
    super("pkg:index:TraefikRoute", name, {}, opts);

    const trailingSlashMiddleware = new k8s.apiextensions.CustomResource(`${name}-trailing-slash`, {
      apiVersion: 'traefik.containo.us/v1alpha1',
      kind: 'Middleware',
      metadata: { namespace: args.namespace },
      spec: {
        redirectRegex: {
          regex: `^.*\\${args.prefix}$`,
          replacement: `${args.prefix}/`,
          permanent: false,
        },
      },
    }, { provider: opts?.provider });

    const stripPrefixMiddleware = new k8s.apiextensions.CustomResource(`${name}-strip-prefix`, {
      apiVersion: 'traefik.containo.us/v1alpha1',
      kind: 'Middleware',
      metadata: { namespace: args.namespace },
      spec: {
        stripPrefix: {
          prefixes: [args.prefix],
        },
      },
    }, { provider: opts?.provider });

    new k8s.apiextensions.CustomResource(`${name}-ingress-route`, {
      apiVersion: 'traefik.containo.us/v1alpha1',
      kind: 'IngressRoute',
      metadata: { namespace: args.namespace },
      spec: {
        entryPoints: ['web'],
        routes: [{
          match: `PathPrefix(\`${args.prefix}\`)`,
          kind: 'Rule',
          middlewares: [
            { name: trailingSlashMiddleware.metadata.name },
            { name: stripPrefixMiddleware.metadata.name },
          ],
          services: [{
            name: pulumi.output(args.service).metadata.name,
            port: pulumi.output(args.service).spec.ports[0].port,
          }],
        }]
      },
    }, { provider: opts?.provider, dependsOn: [trailingSlashMiddleware, stripPrefixMiddleware] });
  }
}
