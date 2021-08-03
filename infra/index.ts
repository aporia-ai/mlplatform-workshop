import * as aws from '@pulumi/aws';
import * as eks from '@pulumi/eks';
import * as k8s from '@pulumi/kubernetes';
import * as random from '@pulumi/random';
import S3ServiceAccount from './S3ServiceAccount';
import TraefikRoute from './TraefikRoute';


// Create a Kubernetes cluster.
const cluster = new eks.Cluster('mlplatform-eks', {
  createOidcProvider: true,
});


// Install Traefik
const traefik = new k8s.helm.v3.Chart('traefik', {
  chart: 'traefik',
  fetchOpts: { repo: 'https://containous.github.io/traefik-helm-chart' },
}, { provider: cluster.provider })



// Create PostgreSQL database for MLFlow - this will save model metadata
const dbPassword = new random.RandomPassword('mlplatform-db-password', { length: 16, special: false });
const db = new aws.rds.Instance('mlflow-db', {
  allocatedStorage: 10,
  engine: "postgres",
  engineVersion: "11.10",
  instanceClass: "db.t3.medium",
  name: "mlflow",
  password: dbPassword.result,
  skipFinalSnapshot: true,
  vpcSecurityGroupIds: [cluster.clusterSecurityGroup.id, cluster.nodeSecurityGroup.id],
  username: "postgres",
});


// Create S3 bucket for MLFlow
const mlflowBucket = new aws.s3.Bucket("mlflow-bucket", {
  acl: "public-read-write",
});


// Create S3 bucket for DVC
const dvcBucket = new aws.s3.Bucket("dvc-bucket", {
  acl: "public-read-write",
});


// Install MLFlow
const mlflowNamespace = new k8s.core.v1.Namespace('mlflow-namespace', {
  metadata: { name: 'mlflow' },
}, { provider: cluster.provider });

const mlflowServiceAccount = new S3ServiceAccount('mlflow-service-account', {
  namespace: mlflowNamespace.metadata.name,
  oidcProvider: cluster.core.oidcProvider!,
  readOnly: false,
}, { provider: cluster.provider });

const mlflow = new k8s.helm.v3.Chart("mlflow", {
  chart: "mlflow",
  namespace: mlflowNamespace.metadata.name,
  values: {
    "backendStore": {
      "postgres": {
        "username": db.username,
        "password": db.password,
        "host": db.address,
        "port": db.port,
        "database": "mlflow"
      }
    },
    "defaultArtifactRoot": mlflowBucket.bucket.apply((bucketName: string) => `s3://${bucketName}`),
    "serviceAccount": {
      "create": false,
      "name": mlflowServiceAccount.name,
    }
  },
  fetchOpts: { repo: "https://larribas.me/helm-charts" },
}, { provider: cluster.provider });


// Expose MLFlow in Traefik as /mlflow 
new TraefikRoute('mlflow', {
  prefix: '/mlflow',
  service: mlflow.getResource('v1/Service', 'mlflow', 'mlflow'),
  namespace: mlflowNamespace.metadata.name,
}, { provider: cluster.provider, dependsOn: [mlflow] });


// Service account for models with read only access to models
const modelsServiceAccount = new S3ServiceAccount('models-service-account', {
  namespace: 'default',
  oidcProvider: cluster.core.oidcProvider!,
  readOnly: true,
}, { provider: cluster.provider });


// Set ml.mycompany.com DNS record in Route53
new aws.route53.Record("record", {
   zoneId: "<ZONE ID>",
   name: "ml.mycompany.com",
  type: "CNAME",
  ttl: 300,
  records: [traefik.getResource('v1/Service', 'traefik').status.loadBalancer.ingress[0].hostname],
});



// Install Flyte
const flyteNamespace = new k8s.core.v1.Namespace('flyte-namespace', {
  metadata: { name: 'flyte' },
}, { provider: cluster.provider });

const flyteSystemAccount = new S3ServiceAccount('flyte-system-account', {
  namespace: flyteNamespace.metadata.name,
  oidcProvider: cluster.core.oidcProvider!,
  readOnly: false,
}, { provider: cluster.provider });

const flyteUserAccount = new S3ServiceAccount('flyte-user-account', {
  namespace: flyteNamespace.metadata.name,
  oidcProvider: cluster.core.oidcProvider!,
  readOnly: false,
}, { provider: cluster.provider });

const flyteDBPassword = new random.RandomPassword('flyte-db-password', { length: 16, special: false });
const flyteDB = new aws.rds.Instance('flyte-db', {
  allocatedStorage: 10,
  engine: "postgres",
  engineVersion: "11.10",
  instanceClass: "db.t3.medium",
  name: "flyteadmin",
  password: flyteDBPassword.result,
  skipFinalSnapshot: true,
  vpcSecurityGroupIds: [cluster.clusterSecurityGroup.id, cluster.nodeSecurityGroup.id],
  username: "flyteadmin",
});

const flyteBucket = new aws.s3.Bucket("flyte-bucket", {
  acl: "public-read-write",
});


const flyte = new k8s.helm.v3.Chart("flyte", {
  chart: "flyte",
  namespace: flyteNamespace.metadata.name,
  values: {
    "flyteadmin": {
       "replicaCount": 2,
       "serviceAccount": {
          "create": true,
          "annotations": {
             "eks.amazonaws.com/role-arn": flyteSystemAccount.role.arn
          }
       },
       "resources": {
          "limits": {
             "ephemeral-storage": "200Mi"
          },
          "requests": {
             "cpu": "50m",
             "ephemeral-storage": "200Mi",
             "memory": "200Mi"
          }
       },
       "service": {
          "annotations": {
             "service.beta.kubernetes.io/aws-load-balancer-connection-idle-timeout": "600",
             "external-dns.alpha.kubernetes.io/hostname": "flyte.example.com"
          },
          "type": "ClusterIP",
       },
       "affinity": {
          "podAntiAffinity": {
             "requiredDuringSchedulingIgnoredDuringExecution": [
                {
                   "labelSelector": {
                      "matchLabels": {
                         "app.kubernetes.io/name": "flyteadmin"
                      }
                   },
                   "topologyKey": "kubernetes.io/hostname"
                }
             ]
          }
       }
    },
    "datacatalog": {
       "replicaCount": 2,
       "serviceAccount": {
          "create": true,
          "annotations": {
             "eks.amazonaws.com/role-arn": flyteSystemAccount.role.arn
          }
       },
       "resources": {
          "limits": {
             "cpu": "500m",
             "ephemeral-storage": "200Mi"
          },
          "requests": {
             "cpu": "50m",
             "ephemeral-storage": "200Mi",
             "memory": "200Mi"
          }
       },
       "service": {
          "annotations": {
             "service.beta.kubernetes.io/aws-load-balancer-connection-idle-timeout": "600"
          },
          "type": "ClusterIP",
       },
       "affinity": {
          "podAntiAffinity": {
             "requiredDuringSchedulingIgnoredDuringExecution": [
                {
                   "labelSelector": {
                      "matchLabels": {
                         "app.kubernetes.io/name": "datacatalog"
                      }
                   },
                   "topologyKey": "kubernetes.io/hostname"
                }
             ]
          }
       }
    },
    "flytepropeller": {
       "replicaCount": 2,
       "serviceAccount": {
          "create": true,
          "annotations": {
             "eks.amazonaws.com/role-arn": flyteSystemAccount.role.arn
          }
       },
       "resources": {
          "limits": {
             "cpu": 1,
             "ephemeral-storage": "1Gi",
             "memory": "2Gi"
          },
          "requests": {
             "cpu": 1,
             "ephemeral-storage": "1Gi",
             "memory": "2Gi"
          }
       },
       "cacheSizeMbs": 1024,
       "affinity": {
          "podAntiAffinity": {
             "requiredDuringSchedulingIgnoredDuringExecution": [
                {
                   "labelSelector": {
                      "matchLabels": {
                         "app.kubernetes.io/name": "flytepropeller"
                      }
                   },
                   "topologyKey": "kubernetes.io/hostname"
                }
             ]
          }
       }
    },
    "flyteconsole": {
       "replicaCount": 2,
       "resources": {
          "limits": {
             "cpu": "250m"
          }
       },
       "service": {
          "annotations": {
             "service.beta.kubernetes.io/aws-load-balancer-connection-idle-timeout": "600",
             "external-dns.alpha.kubernetes.io/hostname": "flyte.example.com"
          },
          "type": "ClusterIP",
       },
       "affinity": {
          "podAntiAffinity": {
             "requiredDuringSchedulingIgnoredDuringExecution": [
                {
                   "labelSelector": {
                      "matchLabels": {
                         "app.kubernetes.io/name": "flyteconsole"
                      }
                   },
                   "topologyKey": "kubernetes.io/hostname"
                }
             ]
          }
       }
    },
    "redis": {
       "resources": {
          "requests": {
             "cpu": "100m",
             "memory": "250Mi"
          }
       }
    },
    "postgres": {
       "enabled": false
    },
    "minio": {
       "enabled": false
    },
    "contour": {
       "enabled": false
    },
    "common": {
       "ingress": {
          "enabled": false,
          "albSSLRedirect": true,
          "separateGrpcIngress": false,
          "annotations": {},
          "separateGrpcIngressAnnotations": {}
       },
       "databaseSecret": {
          "name": "db-pass",
          "secretManifest": {
             "apiVersion": "v1",
             "kind": "Secret",
             "metadata": {
                "name": "db-pass"
             },
             "type": "Opaque",
             "stringData": {
                "pass.txt": flyteDBPassword.result
             }
          }
       }
    },
    "storage": {
       "type": "s3",
       "bucketName": flyteBucket.bucket,
       "s3": {
          "region": aws.getRegion(),
       }
    },
    "db": {
       "database": {
          "port": 5432,
          "username": "flyteadmin",
          "host": flyteDB.address,
          "dbname": "flyteadmin",
          "passwordPath": "/etc/db/pass.txt"
       }
    },
    "configmap": {
       "console": {
          "BASE_URL": "/console",
          "CONFIG_DIR": "/etc/flyte/config",
          "DISABLE_AUTH": "1",
          "ADMIN_API_URL": "/flyteadmin",
       },
       "adminServer": {
          "server": {
             "httpPort": 8088,
             "grpcPort": 8089,
             "security": {
                "secure": false,
                "useAuth": false,
                "allowCors": true,
                "allowedOrigins": [
                   "*"
                ],
                "allowedHeaders": [
                   "Content-Type"
                ]
             }
          }
       },
       "task_resource_defaults": {
          "task_resources": {
             "defaults": {
                "cpu": "1000m",
                "memory": "1000Mi",
                "storage": "1000Mi"
             },
             "limits": {
                "storage": "2000Mi"
             }
          }
       },
       "core": {
          "propeller": {
             "rawoutput-prefix": flyteBucket.bucket.apply((bucketName: string) => `s3://${bucketName}/`),
             "workers": 40,
             "gc-interval": "12h",
             "max-workflow-retries": 50,
             "kube-client-config": {
                "qps": 100,
                "burst": 25,
                "timeout": "30s"
             },
             "queue": {
                "sub-queue": {
                   "type": "bucket",
                   "rate": 100,
                   "capacity": 1000
                }
             }
          }
       },
       "enabled_plugins": {
          "tasks": {
             "task-plugins": {
                "enabled-plugins": [
                   "container",
                   "sidecar",
                   "spark",
                   "k8s-array",
                   "pytorch",
                   "athena"
                ],
                "default-for-task-types": {
                   "container": "container",
                   "sidecar": "sidecar",
                   "spark": "spark",
                   "container_array": "k8s-array",
                   "pytorch": "pytorch",
                   "hive": "athena"
                }
             }
          }
       },
       "logger": {
          "logger": {
             "level": 5
          }
       },
       "task_logs": {
          "plugins": {
             "logs": {
                "kubernetes-enabled": true,
                "cloudwatch-enabled": false,
             }
          }
       }
    },
    "cluster_resource_manager": {
       "enabled": true,
       "config": {
          "cluster_resources": {
             "customData": [
                {
                   "production": [
                      {
                         "projectQuotaCpu": {
                            "value": "5"
                         }
                      },
                      {
                         "projectQuotaMemory": {
                            "value": "4000Mi"
                         }
                      },
                      {
                         "defaultIamRole": {
                            "value": flyteUserAccount.role.arn
                         }
                      }
                   ]
                },
                {
                   "staging": [
                      {
                         "projectQuotaCpu": {
                            "value": "2"
                         }
                      },
                      {
                         "projectQuotaMemory": {
                            "value": "3000Mi"
                         }
                      },
                      {
                         "defaultIamRole": {
                            "value": flyteUserAccount.role.arn
                         }
                      }
                   ]
                },
                {
                   "development": [
                      {
                         "projectQuotaCpu": {
                            "value": "4"
                         }
                      },
                      {
                         "projectQuotaMemory": {
                            "value": "3000Mi"
                         }
                      },
                      {
                         "defaultIamRole": {
                            "value": flyteUserAccount.role.arn
                         }
                      }
                   ]
                }
             ]
          }
       },
       "templates": [
          {
             "key": "aa_namespace",
             "value": "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: {{ namespace }}\nspec:\n  finalizers:\n  - kubernetes\n"
          },
          {
             "key": "aab_default_service_account",
             "value": "apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: default\n  namespace: {{ namespace }}\n  annotations:\n    eks.amazonaws.com/role-arn: {{ defaultIamRole }}\n"
          },
          {
             "key": "ab_project_resource_quota",
             "value": "apiVersion: v1\nkind: ResourceQuota\nmetadata:\n  name: project-quota\n  namespace: {{ namespace }}\nspec:\n  hard:\n    limits.cpu: {{ projectQuotaCpu }}\n    limits.memory: {{ projectQuotaMemory }}\n"
          },
          {
             "key": "ad_spark_role",
             "value": "apiVersion: rbac.authorization.k8s.io/v1beta1\nkind: Role\nmetadata:\n  name: spark-role\n  namespace: {{ namespace }}\nrules:\n- apiGroups:\n  - \"\"\n  resources:\n  - pods\n  verbs:\n  - '*'\n- apiGroups:\n  - \"\"\n  resources:\n  - services\n  verbs:\n  - '*'\n- apiGroups:\n  - \"\"\n  resources:\n  - configmaps\n  verbs:\n  - '*'\n"
          },
          {
             "key": "ae_spark_service_account",
             "value": "apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: spark\n  namespace: {{ namespace }}\n  annotations:\n    eks.amazonaws.com/role-arn: {{ defaultIamRole }}\n"
          },
          {
             "key": "af_spark_role_binding",
             "value": "apiVersion: rbac.authorization.k8s.io/v1beta1\nkind: RoleBinding\nmetadata:\n  name: spark-role-binding\n  namespace: {{ namespace }}\nroleRef:\n  apiGroup: rbac.authorization.k8s.io\n  kind: Role\n  name: spark-role\nsubjects:\n- kind: ServiceAccount\n  name: spark\n  namespace: {{ namespace }}\n"
          }
       ]
    },
    "sparkoperator": {
       "enabled": true,
       "resources": {
          "limits": {
             "cpu": "1000m",
             "memory": "1000Mi"
          },
          "requests": {
             "cpu": "50m",
             "memory": "250Mi"
          }
       }
    },
    "pytorchoperator": {
       "enabled": true,
       "resources": {
          "limits": {
             "cpu": "1000m",
             "memory": "1000Mi"
          },
          "requests": {
             "cpu": "50m",
             "memory": "250Mi"
          }
       }
    },
    "tf_operator": {
       "enabled": false
    },
    "sagemaker": {
       "enabled": false
    }
  },
  fetchOpts: { repo: "https://flyteorg.github.io/flyte" },
}, { provider: cluster.provider });


new TraefikRoute('flyteadmin', {
  prefix: '/flyteadmin',
  service: 'flyteadmin',
  namespace: flyteNamespace.metadata.name,
}, { provider: cluster.provider, dependsOn: [flyte] });

new TraefikRoute('flyteconsole', {
  prefix: '/console',
  service: 'flyteconsole',
  namespace: flyteNamespace.metadata.name,
  stripPrefix: false,
}, { provider: cluster.provider, dependsOn: [flyte] });



export const kubeconfig = cluster.kubeconfig;
export const mlflowTrackingURI = `http://ml.mycompany.com/mlflow`;
export const dvcBucketURI = dvcBucket.bucket.apply((bucketName: string) => `s3://${bucketName}`);
export const modelsServiceAccountName = modelsServiceAccount.name;
