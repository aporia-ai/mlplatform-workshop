import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import * as cluster from "./cluster";
import { resourceGroup } from "./resourcegroup";
import * as dbforpostgresql from "@pulumi/azure-native/dbforpostgresql";
import * as storage from "@pulumi/azure-native/storage";


// Install Traefik
const traefik = new k8s.helm.v3.Chart('traefik', {
    chart: 'traefik',
    fetchOpts: { repo: 'https://containous.github.io/traefik-helm-chart' },
}, { provider: cluster.k8sProvider })

  
// Create the MLFlow DB
const mlflowDBPassword = new random.RandomPassword("mlflow-db-password", {
    length: 20,
    special: false,
})

const mlflowDBServer = new dbforpostgresql.Server("mlflow-db-server", {
    location: "westus",
    properties: {
        administratorLogin: "cloudsa",
        administratorLoginPassword: mlflowDBPassword.result,
        createMode: "Default",
        sslEnforcement: "Disabled",
        storageProfile: {
            backupRetentionDays: 7,
            geoRedundantBackup: "Disabled",
            storageMB: 128000,
        },
    },
    resourceGroupName: resourceGroup.name,
    serverName: "mlplatform-workshop-mlflow",
    sku: {
        capacity: 2,
        family: "Gen5",
        name: "B_Gen5_2",
        tier: "Basic",
    },
    tags: {
        ElasticServer: "1",
    },
});

const mlflowDB = new dbforpostgresql.Database("mlflow-db", {
    charset: "UTF8",
    collation: "English_United States.1252",
    databaseName: "mlflow",
    resourceGroupName: resourceGroup.name,
    serverName: mlflowDBServer.name,
});


// Create storage for MLFlow artifacts
const storageAccount = new storage.StorageAccount("sa", {
    resourceGroupName: resourceGroup.name,
    sku: {
        name: storage.SkuName.Standard_LRS,
    },
    kind: storage.Kind.StorageV2,
});

const artifactStorage = new storage.BlobContainer("artifact-storage", {
    accountName: storageAccount.name,
    resourceGroupName: resourceGroup.name,
})


// Install MLFlow
const mlflowNamespace = new k8s.core.v1.Namespace('mlflow-namespace', {
  metadata: { name: 'mlflow' },
}, { provider: cluster.k8sProvider });

const mlflow = new k8s.helm.v3.Chart("mlflow", {
  chart: "mlflow",
  namespace: mlflowNamespace.metadata.name,
  values: {
    "backendStore": {
      "postgres": {
        "username": mlflowDBServer.name.apply(serverName => `cloudsa@${serverName}`),
        "password": mlflowDBPassword.result,
        "host": mlflowDBServer.fullyQualifiedDomainName,
        "port": 5432,
        "database": "mlflow"
      }
    },
    "defaultArtifactRoot": pulumi.all([storageAccount.name, artifactStorage.name])
      .apply(([storageAccountName, artifactStorageName]) => `wasbs://${artifactStorageName}@${storageAccountName}.blob.core.windows.net/`),
    // "serviceAccount": {
    //   "create": false,
    //   "name": mlflowServiceAccount.name,
    // }
  },
  fetchOpts: { repo: "https://larribas.me/helm-charts" },
}, { provider: cluster.k8sProvider });


// Export the primary key of the Storage Account
// const storageAccountKeys = pulumi.all([resourceGroup.name, storageAccount.name]).apply(([resourceGroupName, accountName]) =>
//     storage.listStorageAccountKeys({ resourceGroupName, accountName }));
// export const primaryStorageKey = storageAccountKeys.keys[0].value;



export let clusterName = cluster.k8sCluster.name;

export let kubeconfig = cluster.kubeconfig;
