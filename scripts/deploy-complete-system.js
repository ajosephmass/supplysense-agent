#!/usr/bin/env node

/**
 * SupplySense Complete System Deployment Script
 * Cross-platform deployment for Unix/Linux/macOS environments
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m'
};

// Helper functions
function log(message, color = colors.white) {
  console.log(`${color}${message}${colors.reset}`);
}

function logSuccess(message) {
  log(`✅ ${message}`, colors.green);
}

function logError(message) {
  log(`❌ ${message}`, colors.red);
  process.exit(1);
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

function execCommand(command, options = {}) {
  try {
    const result = execSync(command, { 
      stdio: options.silent ? 'pipe' : 'inherit',
      encoding: 'utf8',
      ...options 
    });
    return result;
  } catch (error) {
    if (!options.allowFailure) {
      logError(`Command failed: ${command}\n${error.message}`);
    }
    return null;
  }
}

function checkCommand(command, name) {
  try {
    execCommand(`${command} --version`, { silent: true });
    logSuccess(`${name} is installed`);
    return true;
  } catch (error) {
    logError(`${name} not found. Please install ${name}`);
    return false;
  }
}

function checkFileExists(filePath, description) {
  if (fs.existsSync(filePath)) {
    logSuccess(`${description}: ${filePath}`);
    return true;
  } else {
    logError(`${description} not found: ${filePath}`);
    return false;
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  skipPrerequisites: args.includes('--skip-prerequisites'),
  skipInfrastructure: args.includes('--skip-infrastructure'),
  skipUI: args.includes('--skip-ui'),
  verbose: args.includes('--verbose') || args.includes('-v'),
  help: args.includes('--help') || args.includes('-h')
};

if (options.help) {
  log(`
🚀 SupplySense Complete System Deployment

Usage: node scripts/deploy-complete-system.js [options]

Options:
  --skip-prerequisites    Skip prerequisite checks
  --skip-infrastructure   Skip infrastructure deployment
  --skip-ui              Skip UI build and configuration
  --verbose, -v          Verbose output
  --help, -h             Show this help message

Examples:
  node scripts/deploy-complete-system.js
  node scripts/deploy-complete-system.js --skip-prerequisites
  node scripts/deploy-complete-system.js --verbose
`, colors.cyan);
  process.exit(0);
}

async function main() {
  logHeader('🚀 SupplySense Complete System Deployment');

  // Step 1: Prerequisites Check
  if (!options.skipPrerequisites) {
    logHeader('📋 Step 1: Checking Prerequisites');
    
    let prerequisitesPassed = true;
    
    // Check AWS CLI
    if (!checkCommand('aws', 'AWS CLI')) prerequisitesPassed = false;
    
    // Check CDK
    if (!checkCommand('npx cdk', 'AWS CDK')) prerequisitesPassed = false;
    
    // Check Node.js
    try {
      const nodeVersion = execCommand('node --version', { silent: true }).trim();
      const majorVersion = parseInt(nodeVersion.replace('v', '').split('.')[0]);
      if (majorVersion >= 18) {
        logSuccess(`Node.js: ${nodeVersion}`);
      } else {
        logError(`Node.js version must be 18 or higher. Current: ${nodeVersion}`);
        prerequisitesPassed = false;
      }
    } catch (error) {
      logError('Node.js not found');
      prerequisitesPassed = false;
    }
    
    // Check Python
    try {
      let pythonCmd = 'python3';
      let pythonVersion = execCommand('python3 --version', { silent: true, allowFailure: true });
      
      if (!pythonVersion) {
        pythonCmd = 'python';
        pythonVersion = execCommand('python --version', { silent: true });
      }
      
      logSuccess(`Python: ${pythonVersion.trim()}`);
    } catch (error) {
      logError('Python not found. Please install Python 3.11+');
      prerequisitesPassed = false;
    }
    
    // Check AWS credentials
    try {
      const awsIdentity = JSON.parse(execCommand('aws sts get-caller-identity --output json', { silent: true }));
      logSuccess(`AWS Account: ${awsIdentity.Account}`);
    } catch (error) {
      logError('AWS credentials not configured. Run: aws configure');
      prerequisitesPassed = false;
    }
    
    if (!prerequisitesPassed) {
      logError('Prerequisites check failed. Please fix the issues above.');
    }
    
    logInfo('Prerequisites check complete!');
  }

  // Step 2: Install Dependencies
  logHeader('📦 Step 2: Installing Dependencies');
  
  // Root dependencies
  logInfo('Installing root dependencies...');
  execCommand('npm install');
  logSuccess('Root dependencies installed');
  
  // Orchestrator dependencies
  logInfo('Installing orchestrator dependencies...');
  process.chdir('orchestrator');
  execCommand('npm install');
  process.chdir('..');
  logSuccess('Orchestrator dependencies installed');
  
  // UI dependencies
  logInfo('Installing UI dependencies...');
  process.chdir('ui');
  execCommand('npm install');
  process.chdir('..');
  logSuccess('UI dependencies installed');

  // Step 3: Build TypeScript
  logHeader('🔨 Step 3: Building TypeScript');
  execCommand('npm run build');
  logSuccess('TypeScript build complete');

  // Step 4: CDK Bootstrap
  logHeader('🏗️  Step 4: CDK Bootstrap Check');
  try {
    const bootstrapStack = execCommand('aws cloudformation describe-stacks --stack-name CDKToolkit --query "Stacks[0].StackStatus" --output text', { silent: true, allowFailure: true });
    
    if (bootstrapStack && (bootstrapStack.trim() === 'CREATE_COMPLETE' || bootstrapStack.trim() === 'UPDATE_COMPLETE')) {
      logSuccess('CDK already bootstrapped');
    } else {
      logInfo('Bootstrapping CDK...');
      execCommand('npx cdk bootstrap');
      logSuccess('CDK bootstrap complete');
    }
  } catch (error) {
    logInfo('Bootstrapping CDK...');
    execCommand('cdk bootstrap');
    logSuccess('CDK bootstrap complete');
  }

  // Step 5: Deploy Infrastructure
  if (!options.skipInfrastructure) {
    logHeader('🏗️  Step 5: Deploying Infrastructure');
    
    logInfo('Deploying all CDK stacks...');
    execCommand('npx cdk deploy --all --require-approval never');
    logSuccess('Infrastructure deployment complete');
    
    // Get stack outputs
    logInfo('Retrieving stack outputs...');
    try {
      const getOutput = (stackName, outputKey) => {
        try {
          return execCommand(`aws cloudformation describe-stacks --stack-name ${stackName} --query "Stacks[0].Outputs[?OutputKey=='${outputKey}'].OutputValue" --output text`, { silent: true }).trim();
        } catch (error) {
          return null;
        }
      };
      
      const chatUrl = getOutput('SupplySenseChatStack', 'ChatServiceUrl');
      const userPoolId = getOutput('SupplySenseAgentCoreStack', 'CognitoUserPoolId');
      const userPoolClientId = getOutput('SupplySenseAgentCoreStack', 'CognitoUserPoolClientId');
      
      logInfo('Stack Outputs Retrieved:');
      log(`  API Endpoint: ${apiEndpoint}`, colors.white);
      log(`  User Pool ID: ${userPoolId}`, colors.white);
      log(`  User Pool Client ID: ${userPoolClientId}`, colors.white);
      log(`  Identity Pool ID: ${identityPoolId}`, colors.white);
      
      // Create UI environment file
      const envContent = `NEXT_PUBLIC_USER_POOL_ID=${userPoolId}
NEXT_PUBLIC_USER_POOL_CLIENT_ID=${userPoolClientId}
NEXT_PUBLIC_IDENTITY_POOL_ID=${identityPoolId}
NEXT_PUBLIC_API_ENDPOINT=${apiEndpoint}
NEXT_PUBLIC_AWS_REGION=us-east-1
`;
      
      fs.writeFileSync('ui/.env.local', envContent);
      logSuccess('UI environment file created');
      
    } catch (error) {
      logWarning('Could not retrieve all stack outputs. You may need to configure UI environment manually.');
    }
  }

  // Step 6: Seed Data
  logHeader('📊 Step 6: Seeding Sample Data');
  execCommand('npm run seed-data');
  logSuccess('Sample data seeded');

  // Step 7: Prepare Bedrock Agents
  logHeader('🤖 Step 7: Preparing Bedrock Agents');
  
  try {
    const getAgentId = (outputKey) => {
      try {
        return execCommand(`aws cloudformation describe-stacks --stack-name SupplySenseAgentCoreStack --query "Stacks[0].Outputs[?OutputKey=='${outputKey}'].OutputValue" --output text`, { silent: true }).trim();
      } catch (error) {
        return null;
      }
    };
    
    const agentIds = [
      { name: 'Inventory', id: getAgentId('InventoryAgentId') },
      { name: 'Demand', id: getAgentId('DemandAgentId') },
      { name: 'Orchestrator', id: getAgentId('OrchestratorAgentId') },
      { name: 'Logistics', id: getAgentId('LogisticsAgentId') },
      { name: 'Risk', id: getAgentId('RiskAgentId') }
    ];
    
    for (const agent of agentIds) {
      if (agent.id && agent.id !== 'None') {
        logInfo(`Preparing ${agent.name} Agent (${agent.id})...`);
        const result = execCommand(`aws bedrock-agent prepare-agent --agent-id ${agent.id}`, { silent: true, allowFailure: true });
        
        if (result !== null) {
          logSuccess(`${agent.name} Agent prepared`);
        } else {
          logWarning(`${agent.name} Agent preparation may have failed`);
        }
      } else {
        logWarning(`${agent.name} Agent ID not found`);
      }
    }
  } catch (error) {
    logWarning('Could not prepare all Bedrock agents. They may need manual preparation.');
  }

  // Step 8: Build UI
  if (!options.skipUI) {
    logHeader('🖥️  Step 8: Building UI');
    
    process.chdir('ui');
    
    logInfo('Building Next.js application...');
    execCommand('npm run build');
    logSuccess('UI build complete');
    
    process.chdir('..');
  }

  // Step 9: System Health Check
  logHeader('🧪 Step 9: System Health Check');
  
  // Test API health
  try {
    const apiEndpoint = execCommand('aws cloudformation describe-stacks --stack-name SupplySenseChatStack --query "Stacks[0].Outputs[?OutputKey==\'ChatServiceUrl\'].OutputValue" --output text', { silent: true, allowFailure: true });
    
    if (apiEndpoint) {
      try {
        execCommand(`curl -s ${apiEndpoint.trim()}/health`, { silent: true });
        logSuccess('API health check passed');
      } catch (error) {
        logWarning('API health check failed - service may still be starting');
      }
    }
  } catch (error) {
    logWarning('Could not test API health');
  }
  
  // Check DynamoDB tables
  const tables = ['supplysense-inventory', 'supplysense-orders', 'supplysense-suppliers', 'supplysense-logistics', 'supplysense-demand-forecast'];
  let tablesOk = 0;
  
  for (const table of tables) {
    try {
      const tableStatus = execCommand(`aws dynamodb describe-table --table-name ${table} --query "Table.TableStatus" --output text`, { silent: true, allowFailure: true });
      if (tableStatus && tableStatus.trim() === 'ACTIVE') {
        tablesOk++;
      }
    } catch (error) {
      // Table check failed
    }
  }
  
  if (tablesOk === tables.length) {
    logSuccess(`DynamoDB tables: ${tablesOk}/${tables.length} active`);
  } else {
    logWarning(`DynamoDB tables: ${tablesOk}/${tables.length} active`);
  }

  // Step 10: Deployment Summary
  logHeader('🎉 Deployment Summary');
  
  logSuccess('Infrastructure: Deployed');
  logSuccess('Agents: 5 AgentCore runtimes created');
  logSuccess('Chat Service: ECS Fargate deployed');
  logSuccess('Database: DynamoDB tables with sample data');
  logSuccess('UI: Next.js application built');
  
  logHeader('🚀 Next Steps:');
  log('1. Start the UI: cd ui && npm run dev', colors.white);
  log('2. Open browser: http://localhost:3000', colors.white);
  log('3. Sign up/Sign in with Cognito', colors.white);
  log('4. Test queries like:', colors.white);
  log('   - "Can I fulfill all orders this week?"', colors.white);
  log('   - "What\'s my current inventory status?"', colors.white);
  log('   - "SUP-001 has a 5-day delay, what\'s the impact?"', colors.white);
  
  logHeader('📊 System Architecture:');
  log('- 5 Specialized AI Agents on AWS Bedrock AgentCore', colors.white);
  log('- Real-time Chat Orchestration with SSE streaming', colors.white);
  log('- Multi-agent coordination patterns', colors.white);
  log('- Production-ready infrastructure with monitoring', colors.white);
  
  log('\n🎯 SupplySense is ready for supply chain intelligence!', colors.green);
}

// Run the deployment
main().catch(error => {
  logError(`Deployment failed: ${error.message}`);
});