# SupplySense Scripts

Utility scripts for data management and cleanup.

## Available Scripts

### seed-data.js
Seeds DynamoDB tables with sample supply chain data.

```bash
node scripts/seed-data.js [options]

Options:
  --force, -f      Overwrite existing data
  --verbose, -v    Show detailed output
  --help, -h       Show help
```

**What it does:**
- Clears actions and approvals tables (for fresh testing)
- Seeds inventory, orders, suppliers, logistics, and demand forecast data
- Uses data from `data/mock-data.json`

**Example:**
```bash
# Seed data (skips existing items)
node scripts/seed-data.js

# Force overwrite existing data
node scripts/seed-data.js --force

# Verbose output
node scripts/seed-data.js --verbose
```

### cleanup.js
Comprehensive cleanup script that removes all SupplySense resources, including those that CloudFormation cannot delete automatically.

```bash
node scripts/cleanup.js [options]

Options:
  --force, -f      Proceed without confirmation (required to actually delete)
  --skip-tables    Skip DynamoDB table deletion
  --help, -h       Show help
```

**What it deletes:**
- CDK stacks (via `cdk destroy`)
- AgentCore runtimes and gateways
- ECR repositories and images
- SNS topics and subscriptions
- SSM parameters
- DynamoDB tables (unless `--skip-tables` is used)

**Example:**
```bash
# Full cleanup (deletes everything including tables)
node scripts/cleanup.js --force

# Cleanup without deleting DynamoDB tables
node scripts/cleanup.js --force --skip-tables
```

**Note**: This script requires AWS CLI to be configured and has permissions for all resources. Some custom resources (SNS logging) may fail to delete due to a known CloudFormation bug, but these are configuration-only resources and can be safely ignored.

## Usage

### After Deployment

```bash
# Seed sample data after deploying infrastructure
node scripts/seed-data.js
```

### Reset Test Data

```bash
# Clear and reseed data (useful before testing)
node scripts/seed-data.js --force
```

### Complete Cleanup

```bash
# Remove all resources (use with caution)
node scripts/cleanup.js --force
```

## Data Files

Sample data is stored in `data/mock-data.json` and includes:
- Inventory records across multiple warehouses
- Customer orders with various statuses
- Supplier information with reliability scores
- Logistics/shipment data
- Demand forecasts

