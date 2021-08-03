import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';

export interface TraefikRouteArgs {
  namespace: pulumi.Input<string>;
  prefix: pulumi.Input<string>;
  service: pulumi.Input<k8s.core.v1.Service>|string;
  stripPrefix?: pulumi.Input<boolean>|undefined;
  port?: pulumi.Input<number>|undefined;
}

export default class TraefikRoute extends pulumi.ComponentResource {
  constructor(name: string, args: TraefikRouteArgs, opts?: pulumi.ResourceOptions) {
    super("pkg:index:TraefikRoute", name, {}, opts);

    const middlewares = []

    // Remove trailing / 
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
    
    middlewares.push({ name: trailingSlashMiddleware.metadata.name });

    // Strip prefix 
    if (args.stripPrefix || args.stripPrefix === undefined) {
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

      middlewares.push({ name: stripPrefixMiddleware.metadata.name });
    }
    
    new k8s.apiextensions.CustomResource(`${name}-ingress-route`, {
      apiVersion: 'traefik.containo.us/v1alpha1',
      kind: 'IngressRoute',
      metadata: { namespace: args.namespace },
      spec: {
        entryPoints: ['web'],
        routes: [{
          match: `PathPrefix(\`${args.prefix}\`)`,
          kind: 'Rule',
          middlewares,
          services: [{
            name: typeof args.service === "string" ? args.service : pulumi.output(args.service).metadata.name,
            port: args.port ? args.port : 
              (typeof args.service !== "string" ? pulumi.output(args.service).spec.ports[0].port : 80),
          }],
        }]
      },
    }, { provider: opts?.provider });
  }
}
