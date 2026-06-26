// PostgreSQL Flexible Server for the VTA (resource-group scoped module).
//
// - Burstable B1ms / pg16 / 32 GB — the cheapest tier that runs the RAG store.
// - `azure.extensions = VECTOR` allowlists pgvector so `CREATE EXTENSION vector`
//   (run by `pnpm db:indexes`) is permitted.
// - Public network access ON with two firewall rules: Azure-internal services
//   and the operator workstation. PILOT posture — tighten (VNet/private endpoint
//   or a narrower IP allowlist) before anything resembling production.

@description('Azure region.')
param location string

@description('Short name prefix.')
param prefix string

@description('Environment label.')
param environment string

@description('PostgreSQL administrator login name.')
param pgAdminUser string

@secure()
@description('PostgreSQL administrator password.')
param pgAdminPassword string

@description('Operator workstation public IPv4 (0.0.0.0 to skip).')
param clientIp string

@description('Tags applied to all resources.')
param tags object

var suffix = uniqueString(resourceGroup().id)
var serverName = toLower('${prefix}-pg-${environment}-${suffix}')
var databaseName = 'vta'

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: serverName
  location: location
  tags: tags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: pgAdminUser
    administratorLoginPassword: pgAdminPassword
    storage: {
      storageSizeGB: 32
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

// Allowlist pgvector (and keep it explicit/auditable).
resource extensionsParam 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'azure.extensions'
  properties: {
    value: 'VECTOR'
    source: 'user-override'
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// 0.0.0.0–0.0.0.0 is Azure's documented "allow all Azure services" rule.
resource fwAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: server
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// Operator workstation, so `pnpm db:push` / the admin CLI can connect from WSL.
resource fwClient 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' =
  if (clientIp != '0.0.0.0') {
    parent: server
    name: 'AllowOperatorWorkstation'
    properties: {
      startIpAddress: clientIp
      endIpAddress: clientIp
    }
  }

output fqdn string = server.properties.fullyQualifiedDomainName
output databaseName string = databaseName
