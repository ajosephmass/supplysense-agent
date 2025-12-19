#!/usr/bin/env node

/**
 * SupplySense Data Seeding Script
 * Seeds DynamoDB tables with sample supply chain data
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, ScanCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const fs = require('fs');
const path = require('path');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m'
};

function log(message, color = colors.white) {
  console.log(`${color}${message}${colors.reset}`);
}

function logSuccess(message) {
  log(`✅ ${message}`, colors.green);
}

function logError(message) {
  log(`❌ ${message}`, colors.red);
}

function logWarning(message) {
  log(`⚠️  ${message}`, colors.yellow);
}

function logInfo(message) {
  log(`ℹ️  ${message}`, colors.blue);
}

function logHeader(message) {
  log(`\n${message}`, colors.cyan);
  log('='.repeat(message.length), colors.cyan);
}

// Initialize AWS clients
const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

// Load mock data
let mockData;
try {
  mockData = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/mock-data.json'), 'utf8'));
} catch (error) {
  logError(`Failed to load mock data: ${error.message}`);
  process.exit(1);
}

const tableNames = {
  inventory: 'supplysense-inventory',
  orders: 'supplysense-orders',
  suppliers: 'supplysense-suppliers',
  logistics: 'supplysense-logistics',
  demandForecast: 'supplysense-demand-forecast',
  actions: 'supplysense-actions',
  approvals: 'supplysense-approvals',
};

async function checkTableExists(tableName) {
  try {
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    const { DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
    
    const client = new DynamoDBClient({});
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') {
      return false;
    }
    throw error;
  }
}

async function getTableItemCount(tableName) {
  try {
    const command = new ScanCommand({
      TableName: tableName,
      Select: 'COUNT'
    });
    
    const response = await docClient.send(command);
    return response.Count || 0;
  } catch (error) {
    logWarning(`Could not get item count for ${tableName}: ${error.message}`);
    return 0;
  }
}

async function seedTable(tableName, data, options = {}) {
  logInfo(`Seeding ${tableName} with ${data.length} items...`);
  
  // Check if table exists
  const tableExists = await checkTableExists(tableName);
  if (!tableExists) {
    logError(`Table ${tableName} does not exist. Please deploy infrastructure first.`);
    return false;
  }
  
  // Check if table already has data
  const existingCount = await getTableItemCount(tableName);
  if (existingCount > 0 && !options.force) {
    logWarning(`Table ${tableName} already has ${existingCount} items. Use --force to overwrite.`);
    return true;
  }
  
  let successCount = 0;
  let errorCount = 0;
  
  for (const item of data) {
    try {
      const command = new PutCommand({
        TableName: tableName,
        Item: item,
        ...(options.force ? {} : { ConditionExpression: 'attribute_not_exists(#pk)' })
      });
      
      // Add primary key condition based on table
      if (tableName.includes('inventory')) {
        command.input.ConditionExpression = options.force ? undefined : 'attribute_not_exists(productId) AND attribute_not_exists(locationId)';
        command.input.ExpressionAttributeNames = options.force ? undefined : { '#pk': 'productId' };
      } else if (tableName.includes('orders')) {
        command.input.ConditionExpression = options.force ? undefined : 'attribute_not_exists(orderId)';
        command.input.ExpressionAttributeNames = options.force ? undefined : { '#pk': 'orderId' };
      } else if (tableName.includes('suppliers')) {
        command.input.ConditionExpression = options.force ? undefined : 'attribute_not_exists(supplierId)';
        command.input.ExpressionAttributeNames = options.force ? undefined : { '#pk': 'supplierId' };
      } else if (tableName.includes('logistics')) {
        command.input.ConditionExpression = options.force ? undefined : 'attribute_not_exists(shipmentId)';
        command.input.ExpressionAttributeNames = options.force ? undefined : { '#pk': 'shipmentId' };
      } else if (tableName.includes('demand-forecast')) {
        command.input.ConditionExpression = options.force ? undefined : 'attribute_not_exists(productId) AND attribute_not_exists(forecastDate)';
        command.input.ExpressionAttributeNames = options.force ? undefined : { '#pk': 'productId' };
      }
      
      await docClient.send(command);
      successCount++;
      
      if (options.verbose) {
        const itemKey = item.productId || item.orderId || item.supplierId || item.shipmentId || 'unknown';
        logSuccess(`  Inserted: ${itemKey}`);
      }
    } catch (error) {
      errorCount++;
      if (error.name === 'ConditionalCheckFailedException') {
        if (options.verbose) {
          logWarning(`  Item already exists: ${JSON.stringify(Object.keys(item))}`);
        }
      } else {
        logError(`  Error inserting item: ${error.message}`);
      }
    }
  }
  
  if (successCount > 0) {
    logSuccess(`Successfully seeded ${successCount} items in ${tableName}`);
  }
  if (errorCount > 0) {
    logWarning(`${errorCount} items were skipped (already exist or errors)`);
  }
  
  return true;
}

async function clearTable(tableName) {
  logInfo(`Clearing all items from ${tableName}...`);
  
  const tableExists = await checkTableExists(tableName);
  if (!tableExists) {
    logWarning(`Table ${tableName} does not exist, skipping.`);
    return 0;
  }
  
  let deletedCount = 0;
  let lastEvaluatedKey = undefined;
  
  do {
    const scanCommand = new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey: lastEvaluatedKey,
      Limit: 25,
    });
    
    const scanResult = await docClient.send(scanCommand);
    lastEvaluatedKey = scanResult.LastEvaluatedKey;
    
    for (const item of scanResult.Items || []) {
      try {
        // Determine the key based on table name
        let key;
        if (tableName === tableNames.actions || tableName === tableNames.approvals) {
          key = { PK: item.PK, SK: item.SK };
        } else if (tableName === tableNames.inventory) {
          key = { productId: item.productId, locationId: item.locationId };
        } else if (tableName === tableNames.orders) {
          key = { orderId: item.orderId };
        } else if (tableName === tableNames.suppliers) {
          key = { supplierId: item.supplierId };
        } else if (tableName === tableNames.logistics) {
          key = { shipmentId: item.shipmentId };
        } else if (tableName === tableNames.demandForecast) {
          key = { productId: item.productId, forecastDate: item.forecastDate };
        }
        
        if (key) {
          await docClient.send(new DeleteCommand({ TableName: tableName, Key: key }));
          deletedCount++;
        }
      } catch (error) {
        logError(`  Error deleting item: ${error.message}`);
      }
    }
  } while (lastEvaluatedKey);
  
  if (deletedCount > 0) {
    logSuccess(`Deleted ${deletedCount} items from ${tableName}`);
  } else {
    logInfo(`No items to delete in ${tableName}`);
  }
  
  return deletedCount;
}

async function clearActionsAndApprovals() {
  logHeader('🧹 Clearing Actions and Approvals Tables');
  
  const actionsDeleted = await clearTable(tableNames.actions);
  const approvalsDeleted = await clearTable(tableNames.approvals);
  
  logSuccess(`Cleared ${actionsDeleted} actions and ${approvalsDeleted} approvals`);
}

async function seedAllTables(options = {}) {
  try {
    logHeader('🌱 Starting SupplySense Data Seeding');
    
    // Always clear actions and approvals tables first
    await clearActionsAndApprovals();
    
    if (options.force) {
      logWarning('Force mode enabled - will overwrite existing data');
    }
    
    const seedResults = await Promise.all([
      seedTable(tableNames.inventory, mockData.inventory, options),
      seedTable(tableNames.orders, mockData.orders, options),
      seedTable(tableNames.suppliers, mockData.suppliers, options),
      seedTable(tableNames.logistics, mockData.logistics, options),
      seedTable(tableNames.demandForecast, mockData.demandForecast, options)
    ]);
    
    const allSuccessful = seedResults.every(result => result === true);
    
    if (allSuccessful) {
      logHeader('✅ Data Seeding Complete!');
      logSuccess('All tables have been seeded with sample data');
      
      logInfo('Sample data includes:');
      log(`  • ${mockData.inventory.length} inventory records across multiple locations`, colors.white);
      log(`  • ${mockData.orders.length} customer orders with various statuses`, colors.white);
      log(`  • ${mockData.suppliers.length} suppliers with reliability scores`, colors.white);
      log(`  • ${mockData.logistics.length} shipment records with tracking`, colors.white);
      log(`  • ${mockData.demandForecast.length} demand forecasts with confidence levels`, colors.white);
      
      logHeader('🚀 Next Steps:');
      log('1. Test the system: node scripts/test-deployment.js', colors.white);
      log('2. Start the UI: cd ui && npm run dev', colors.white);
      log('3. Try sample queries:', colors.white);
      log('   - "What\'s my current inventory status?"', colors.white);
      log('   - "Can I fulfill all orders this week?"', colors.white);
      log('   - "SUP-001 has a delay, what\'s the impact?"', colors.white);
    } else {
      logError('Some tables failed to seed. Check the errors above.');
      process.exit(1);
    }
    
  } catch (error) {
    logError(`Data seeding failed: ${error.message}`);
    process.exit(1);
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  force: args.includes('--force') || args.includes('-f'),
  verbose: args.includes('--verbose') || args.includes('-v'),
  help: args.includes('--help') || args.includes('-h')
};

if (options.help) {
  log(`
🌱 SupplySense Data Seeding Script

Usage: node scripts/seed-data.js [options]

Options:
  --force, -f      Overwrite existing data in tables
  --verbose, -v    Show detailed output for each item
  --help, -h       Show this help message

Examples:
  node scripts/seed-data.js
  node scripts/seed-data.js --force --verbose
  npm run seed-data
`, colors.cyan);
  process.exit(0);
}

// Run the seeding process
seedAllTables(options);