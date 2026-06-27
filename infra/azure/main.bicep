// VTA Azure infrastructure — subscription-scoped entry point.
//
// Phase-1 minimal foundation: a resource group + a PostgreSQL Flexible Server
// with the pgvector extension allowlisted. This is the cheapest useful step —
// it gives the system a real database to run db:push / ingestion / the governed
// pipeline against (unblocking the live smoke test when local Docker is down).
//
// Compute (Azure Container Apps for the backend + discord-worker), Redis, Key
// Vault, and a container registry are intentionally NOT here yet: the app
// containers need Dockerfiles + pushed images first. Add them as further
// modules once that exists.
//
// Deploy (nothing is created until you run this with --what-if removed):
//   az deployment sub create \
//     --name vta-foundation --location eastus \
//     --template-file infra/azure/main.bicep \
//     --parameters pgAdminPassword='<strong-password>' clientIp='<your-ip>'

targetScope = 'subscription'

@description('Azure region for the resource group + deployment metadata.')
param location string = 'eastus2'

@description('Azure region for the Postgres server. This subscription offer restricts Postgres Flexible in busy regions (eastus/eastus2 confirmed restricted); westus3 works. Verified live 2026-06-26.')
param pgLocation string = 'westus3'

@description('Short name prefix used in resource names and tags.')
param prefix string = 'vta'

@description('Environment label (used in the resource-group name and tags).')
param environment string = 'pilot'

@description('PostgreSQL administrator login name.')
param pgAdminUser string = 'vtaadmin'

@secure()
@minLength(12)
@description('PostgreSQL administrator password. Supply at deploy time; never commit it.')
param pgAdminPassword string

@description('Public IPv4 of the operator workstation allowed to reach Postgres. Use 0.0.0.0 to skip the client firewall rule.')
param clientIp string = '0.0.0.0'

var rgName = 'VirtualTeachingAssistant'
var tags = {
  project: 'vta'
  environment: environment
  managedBy: 'bicep'
}

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: rgName
  location: location
  tags: tags
}

module postgres 'postgres.bicep' = {
  scope: rg
  name: 'vta-postgres'
  params: {
    location: pgLocation
    prefix: prefix
    environment: environment
    pgAdminUser: pgAdminUser
    pgAdminPassword: pgAdminPassword
    clientIp: clientIp
    tags: tags
  }
}

output resourceGroup string = rg.name
output postgresHost string = postgres.outputs.fqdn
output databaseName string = postgres.outputs.databaseName
@description('Fill in <password> and use as DATABASE_URL.')
output databaseUrlTemplate string = 'postgres://${pgAdminUser}:<password>@${postgres.outputs.fqdn}:5432/${postgres.outputs.databaseName}?sslmode=require'
