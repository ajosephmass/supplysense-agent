#!/usr/bin/env node

/**
 * SupplySense Complete Cleanup Script
 * 
 * This script removes all SupplySense resources, including those that
 * CloudFormation cannot delete automatically:
 * - ECR repositories and images
 * - SNS topics and subscriptions
 * - AgentCore runtimes and gateways
 * - DynamoDB tables (with confirmation)
 * 
 * Usage: node scripts/cleanup.js [--force] [--skip-tables]
 * 
 * Requirements: AWS CLI must be installed and configured
 */

const { execSync } = require('child_process');

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

function execAWS(command, options = {}) {
  try {
    const output = execSync(command, { 
      encoding: 'utf-8', 
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options 
    });
    return { success: true, output: output || '' };
  } catch (error) {
    return { success: false, error: error.message, output: error.stdout || '' };
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const force = args.includes('--force') || args.includes('-f');
const skipTables = args.includes('--skip-tables');

const region = process.env.AWS_REGION || 'us-east-1';

const STACKS = [
  'SupplySenseChatStack',
  'SupplySenseAgentCoreStack',
  'SupplySenseTablesStack'
];

const ECR_REPO_PREFIXES = [
  'supplysense-chat-orchestration',
  'supplysense-inventory',
  'supplysense-demand',
  'supplysense-logistics',
  'supplysense-risk',
  'supplysense-orchestrator'
];

const SNS_TOPIC_PREFIXES = [
  'supplysense-action-events',
  'supplysense-approval-events'
];

const DYNAMODB_TABLES = [
  'supplysense-inventory',
  'supplysense-orders',
  'supplysense-suppliers',
  'supplysense-logistics',
  'supplysense-demand-forecast',
  'supplysense-actions',
  'supplysense-approvals',
  'chat-sessions'
];

async function cleanupFailedStackResources() {
  logHeader('🧹 Cleaning Up Failed Stack Resources');
  
  // Clean up ECR repository that failed to delete
  const chatRepoName = 'supplysense-chat-orchestration-905418470400-us-east-1';
  try {
    logInfo(`Cleaning up ECR repository: ${chatRepoName}`);
    
    // Delete all images with force
    const imagesResult = execAWS(
      `aws ecr list-images --repository-name ${chatRepoName} --region ${region} --output json`,
      { silent: true }
    );
    
    if (imagesResult.success) {
      const imagesData = JSON.parse(imagesResult.output);
      const imageIds = imagesData.imageIds || [];
      
      if (imageIds.length > 0) {
        logInfo(`  Deleting ${imageIds.length} images...`);
        // Delete all images (untagged and tagged)
        for (const img of imageIds) {
          const imageId = {};
          if (img.imageDigest) imageId.imageDigest = img.imageDigest;
          if (img.imageTag) imageId.imageTag = img.imageTag;
          
          if (Object.keys(imageId).length > 0) {
            execAWS(
              `aws ecr batch-delete-image --repository-name ${chatRepoName} --image-ids '${JSON.stringify([imageId])}' --region ${region}`,
              { silent: true }
            );
          }
        }
      }
    }
    
    // Try to delete repository again
    const deleteResult = execAWS(
      `aws ecr delete-repository --repository-name ${chatRepoName} --force --region ${region}`,
      { silent: true }
    );
    
    if (deleteResult.success) {
      logSuccess(`Cleaned up ECR repository: ${chatRepoName}`);
    }
  } catch (error) {
    logWarning(`Could not clean up ECR repository ${chatRepoName}: ${error.message}`);
  }
  
  // Note: SNS logging custom resources have a bug and will fail during deletion
  // This is a known issue with the custom resource implementation
  // The resources themselves don't need manual cleanup as they're just configuration
  logInfo('Note: SNS logging custom resources may fail to delete due to a known bug');
  logInfo('These are configuration-only resources and can be safely ignored');
}

async function forceDeleteFailedStack(stackName) {
  logInfo(`Attempting to force-delete failed stack: ${stackName}`);
  
  try {
    // Check stack status
    const statusResult = execAWS(
      `aws cloudformation describe-stacks --stack-name ${stackName} --region ${region} --output json`,
      { silent: true }
    );
    
    if (!statusResult.success) {
      logInfo(`Stack ${stackName} does not exist or already deleted`);
      return true;
    }
    
    const stackData = JSON.parse(statusResult.output);
    const stack = stackData.Stacks[0];
    const stackStatus = stack.StackStatus;
    
    if (stackStatus === 'DELETE_FAILED') {
      logWarning(`Stack ${stackName} is in DELETE_FAILED state`);
      
      // Get failed resources
      const eventsResult = execAWS(
        `aws cloudformation describe-stack-events --stack-name ${stackName} --region ${region} --max-items 100 --output json`,
        { silent: true }
      );
      
      const failedResources = [];
      if (eventsResult.success) {
        const eventsData = JSON.parse(eventsResult.output);
        const events = eventsData.StackEvents || [];
        for (const event of events) {
          if (event.ResourceStatus === 'DELETE_FAILED' && event.ResourceType === 'AWS::CloudFormation::CustomResource') {
            const logicalId = event.LogicalResourceId;
            if (logicalId && !failedResources.includes(logicalId)) {
              failedResources.push(logicalId);
            }
          }
        }
      }
      
      if (failedResources.length > 0) {
        logInfo(`Found ${failedResources.length} failed custom resources: ${failedResources.join(', ')}`);
        logInfo(`These are SNS logging custom resources with a known bug - manually cleaning up...`);
        
        // Try to find and delete the Lambda functions associated with these custom resources
        const lambdaListResult = execAWS(
          `aws lambda list-functions --region ${region} --output json`,
          { silent: true }
        );
        
        let deletedLambdas = false;
        if (lambdaListResult.success) {
          const lambdaData = JSON.parse(lambdaListResult.output);
          const functions = lambdaData.Functions || [];
          for (const func of functions) {
            const funcName = func.FunctionName || '';
            // Look for Lambda functions that match the custom resource pattern
            for (const resourceId of failedResources) {
              if (funcName.includes(resourceId) || funcName.includes('SNSLogging') || funcName.includes('ActionTopicLogging') || funcName.includes('ApprovalTopicLogging')) {
                logInfo(`  Deleting Lambda function: ${funcName}`);
                const deleteResult = execAWS(
                  `aws lambda delete-function --function-name ${funcName} --region ${region}`,
                  { silent: true }
                );
                if (deleteResult.success) {
                  deletedLambdas = true;
                }
              }
            }
          }
        }
        
        if (deletedLambdas) {
          logInfo(`Waiting 5 seconds for Lambda deletion to propagate...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
        // Try to delete stack with retain-resources (space-separated list)
        logInfo(`Retaining failed custom resources and deleting rest of stack...`);
        const retainResourcesStr = failedResources.join(' ');
        const retainResult = execAWS(
          `aws cloudformation delete-stack --stack-name ${stackName} --retain-resources ${retainResourcesStr} --region ${region}`,
          { silent: true }
        );
        
        if (!retainResult.success) {
          // If retain-resources doesn't work, try without it (might work if Lambda is deleted)
          logInfo(`Retain-resources approach failed, trying regular delete...`);
          execAWS(
            `aws cloudformation delete-stack --stack-name ${stackName} --region ${region}`,
            { silent: true }
          );
        }
        
        logInfo(`Waiting 30 seconds for stack deletion...`);
        await new Promise(resolve => setTimeout(resolve, 30000));
      } else {
        // No specific failed resources, just retry deletion
        logInfo(`Attempting to continue deletion...`);
        execAWS(
          `aws cloudformation delete-stack --stack-name ${stackName} --region ${region}`,
          { silent: true }
        );
        logInfo(`Waiting 30 seconds for resources to clean up...`);
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
    }
    
    return false;
  } catch (error) {
    logWarning(`Could not force-delete stack ${stackName}: ${error.message}`);
    return false;
  }
}

async function deleteCDKStacks() {
  logHeader('🗑️  Deleting CDK Stacks');
  
  for (const stack of STACKS) {
    try {
      logInfo(`Deleting stack: ${stack}`);
      const result = execAWS(`npx cdk destroy ${stack} --force`, { 
        cwd: process.cwd()
      });
      if (result.success) {
        logSuccess(`Stack ${stack} deleted`);
      } else {
        logWarning(`Failed to delete stack ${stack}: ${result.error}`);
        // If stack deletion failed, try to clean up problematic resources
        if (stack === 'SupplySenseChatStack') {
          await cleanupFailedStackResources();
          // Try to force-delete the failed stack
          await forceDeleteFailedStack(stack);
        }
      }
    } catch (error) {
      logWarning(`Error deleting stack ${stack}: ${error.message}`);
      // If stack deletion failed, try to clean up problematic resources
      if (stack === 'SupplySenseChatStack') {
        await cleanupFailedStackResources();
        // Try to force-delete the failed stack
        await forceDeleteFailedStack(stack);
      }
    }
  }
  
  // After attempting stack deletion, clean up any remaining failed resources
  await cleanupFailedStackResources();
  
  // Try to force-delete any remaining failed stacks
  for (const stack of STACKS) {
    await forceDeleteFailedStack(stack);
  }
}

async function deleteECRRepositories() {
  logHeader('🗑️  Deleting ECR Repositories');
  
  try {
    const result = execAWS(
      `aws ecr describe-repositories --region ${region} --output json`,
      { silent: true }
    );
    
    if (!result.success) {
      logError(`Failed to list ECR repositories: ${result.error}`);
      return;
    }
    
    const data = JSON.parse(result.output);
    const repos = data.repositories || [];
    
    for (const repo of repos) {
      const repoName = repo.repositoryName || '';
      
      // Check if this is a SupplySense repository
      if (!ECR_REPO_PREFIXES.some(prefix => repoName.includes(prefix))) {
        continue;
      }
      
      try {
        logInfo(`Deleting ECR repository: ${repoName}`);
        
        // First, delete all images
        try {
          let hasMoreImages = true;
          let deletedCount = 0;
          
          while (hasMoreImages) {
            const imagesResult = execAWS(
              `aws ecr list-images --repository-name ${repoName} --region ${region} --output json`,
              { silent: true }
            );
            
            if (!imagesResult.success) {
              break;
            }
            
            const imagesData = JSON.parse(imagesResult.output);
            const imageIds = imagesData.imageIds || [];
            
            if (imageIds.length === 0) {
              hasMoreImages = false;
              break;
            }
            
            logInfo(`  Deleting ${imageIds.length} images (batch ${Math.floor(deletedCount / 100) + 1})...`);
            
            // Delete in batches (ECR has limits)
            const batchSize = 100;
            for (let i = 0; i < imageIds.length; i += batchSize) {
              const batch = imageIds.slice(i, i + batchSize);
              const batchJson = JSON.stringify(batch.map(img => {
                const id = {};
                if (img.imageDigest) id.imageDigest = img.imageDigest;
                if (img.imageTag) id.imageTag = img.imageTag;
                return id;
              }).filter(img => Object.keys(img).length > 0));
              
              execAWS(
                `aws ecr batch-delete-image --repository-name ${repoName} --image-ids '${batchJson}' --region ${region}`,
                { silent: true }
              );
              deletedCount += batch.length;
            }
            
            // Wait a moment for deletion to propagate
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Check if there are more images
            const checkResult = execAWS(
              `aws ecr list-images --repository-name ${repoName} --region ${region} --output json`,
              { silent: true }
            );
            
            if (checkResult.success) {
              const checkData = JSON.parse(checkResult.output);
              hasMoreImages = (checkData.imageIds || []).length > 0;
            } else {
              hasMoreImages = false;
            }
          }
          
          if (deletedCount > 0) {
            logInfo(`  Deleted ${deletedCount} images total`);
            // Wait a bit more for ECR to process deletions
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        } catch (imgError) {
          logWarning(`  Could not delete images: ${imgError.message}`);
        }
        
        // Delete the repository
        const deleteResult = execAWS(
          `aws ecr delete-repository --repository-name ${repoName} --force --region ${region}`,
          { silent: true }
        );
        
        if (deleteResult.success) {
          logSuccess(`Deleted ECR repository: ${repoName}`);
        } else {
          logError(`Failed to delete ECR repository ${repoName}: ${deleteResult.error}`);
        }
      } catch (error) {
        logError(`Error deleting ECR repository ${repoName}: ${error.message}`);
      }
    }
  } catch (error) {
    logError(`Failed to process ECR repositories: ${error.message}`);
  }
}

async function deleteSNSTopics() {
  logHeader('🗑️  Deleting SNS Topics');
  
  try {
    const result = execAWS(
      `aws sns list-topics --region ${region} --output json`,
      { silent: true }
    );
    
    if (!result.success) {
      logError(`Failed to list SNS topics: ${result.error}`);
      return;
    }
    
    const data = JSON.parse(result.output);
    const topics = data.Topics || [];
    
    for (const topic of topics) {
      const topicArn = topic.TopicArn || '';
      
      // Check if this is a SupplySense topic
      if (!SNS_TOPIC_PREFIXES.some(prefix => topicArn.includes(prefix))) {
        continue;
      }
      
      try {
        logInfo(`Deleting SNS topic: ${topicArn}`);
        
        // First, delete all subscriptions
        try {
          const subsResult = execAWS(
            `aws sns list-subscriptions-by-topic --topic-arn "${topicArn}" --region ${region} --output json`,
            { silent: true }
          );
          
          if (subsResult.success) {
            const subsData = JSON.parse(subsResult.output);
            const subscriptions = subsData.Subscriptions || [];
            
            for (const sub of subscriptions) {
              if (sub.SubscriptionArn && !sub.SubscriptionArn.includes('PendingConfirmation')) {
                execAWS(
                  `aws sns unsubscribe --subscription-arn "${sub.SubscriptionArn}" --region ${region}`,
                  { silent: true }
                );
              }
            }
          }
        } catch (subError) {
          logWarning(`  Could not delete subscriptions: ${subError.message}`);
        }
        
        // Delete the topic
        const deleteResult = execAWS(
          `aws sns delete-topic --topic-arn "${topicArn}" --region ${region}`,
          { silent: true }
        );
        
        if (deleteResult.success) {
          logSuccess(`Deleted SNS topic: ${topicArn}`);
        } else {
          logError(`Failed to delete SNS topic ${topicArn}: ${deleteResult.error}`);
        }
      } catch (error) {
        logError(`Error deleting SNS topic ${topicArn}: ${error.message}`);
      }
    }
  } catch (error) {
    logError(`Failed to process SNS topics: ${error.message}`);
  }
}

async function deleteAgentCoreRuntimes() {
  logHeader('🗑️  Deleting AgentCore Runtimes');
  
  try {
    const result = execAWS(
      `aws bedrock-agentcore-control list-agent-runtimes --region ${region} --output json`,
      { silent: true }
    );
    
    if (!result.success) {
      logWarning(`Failed to list AgentCore runtimes: ${result.error}`);
      logWarning(`This may be normal if AgentCore is not available in this region`);
      return;
    }
    
    const data = JSON.parse(result.output);
    const runtimes = data.agentRuntimes || [];
    
    for (const runtime of runtimes) {
      const runtimeName = runtime.agentRuntimeName || runtime.name || '';
      const runtimeId = runtime.agentRuntimeId || runtime.id || '';
      
      // Check if this is a SupplySense runtime
      if (!runtimeName.includes('SupplySense')) {
        continue;
      }
      
      try {
        logInfo(`Deleting AgentCore runtime: ${runtimeName} (${runtimeId})`);
        const deleteResult = execAWS(
          `aws bedrock-agentcore-control delete-agent-runtime --agent-runtime-id ${runtimeId} --region ${region}`,
          { silent: true }
        );
        
        if (deleteResult.success) {
          logSuccess(`Deleted AgentCore runtime: ${runtimeName}`);
        } else {
          logError(`Failed to delete AgentCore runtime ${runtimeName}: ${deleteResult.error}`);
        }
      } catch (error) {
        logError(`Error deleting AgentCore runtime ${runtimeName}: ${error.message}`);
      }
    }
  } catch (error) {
    logError(`Failed to process AgentCore runtimes: ${error.message}`);
  }
}

async function deleteAgentCoreGatewayTargets(gatewayId) {
  let maxRetries = 3;
  let retryCount = 0;
  
  while (retryCount < maxRetries) {
    try {
      const result = execAWS(
        `aws bedrock-agentcore-control list-gateway-targets --gateway-identifier ${gatewayId} --region ${region} --output json`,
        { silent: true }
      );
      
      if (!result.success) {
        // No targets or can't list them - assume they're deleted
        return true;
      }
      
      const data = JSON.parse(result.output);
      const targets = data.items || [];
      
      if (targets.length === 0) {
        // All targets deleted
        return true;
      }
      
      // Delete each target
      for (const target of targets) {
        const targetId = target.targetId || target.id || '';
        if (!targetId) continue;
        
        try {
          logInfo(`  Deleting gateway target: ${targetId}`);
          const deleteResult = execAWS(
            `aws bedrock-agentcore-control delete-gateway-target --gateway-identifier ${gatewayId} --target-id ${targetId} --region ${region}`,
            { silent: true }
          );
          
          if (!deleteResult.success) {
            logWarning(`  Failed to delete target ${targetId}: ${deleteResult.error}`);
          }
        } catch (error) {
          logWarning(`  Could not delete target ${targetId}: ${error.message}`);
        }
      }
      
      // Wait a moment for deletion to propagate
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Verify targets are deleted
      const verifyResult = execAWS(
        `aws bedrock-agentcore-control list-gateway-targets --gateway-identifier ${gatewayId} --region ${region} --output json`,
        { silent: true }
      );
      
      if (verifyResult.success) {
        const verifyData = JSON.parse(verifyResult.output);
        const remainingTargets = verifyData.items || [];
        if (remainingTargets.length === 0) {
          logInfo(`  All gateway targets deleted`);
          return true;
        } else {
          logInfo(`  ${remainingTargets.length} target(s) still remaining, retrying...`);
          retryCount++;
        }
      } else {
        // Can't verify, assume deleted
        return true;
      }
    } catch (error) {
      logWarning(`Could not list/delete gateway targets: ${error.message}`);
      retryCount++;
      if (retryCount < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  
  logWarning(`Could not delete all gateway targets after ${maxRetries} attempts`);
  return false;
}

async function deleteAgentCoreGateways() {
  logHeader('🗑️  Deleting AgentCore Gateways');
  
  try {
    const result = execAWS(
      `aws bedrock-agentcore-control list-gateways --region ${region} --output json`,
      { silent: true }
    );
    
    if (!result.success) {
      logWarning(`Failed to list AgentCore gateways: ${result.error}`);
      logWarning(`This may be normal if AgentCore is not available in this region`);
      return;
    }
    
    const data = JSON.parse(result.output);
    const gateways = data.items || [];
    
    for (const gateway of gateways) {
      const gatewayName = gateway.name || '';
      const gatewayId = gateway.gatewayId || gateway.id || '';
      
      // Check if this is a SupplySense gateway
      if (!gatewayName.includes('SupplySense')) {
        continue;
      }
      
      try {
        logInfo(`Deleting AgentCore gateway: ${gatewayName} (${gatewayId})`);
        
        // First, delete all gateway targets and verify they're gone
        const targetsDeleted = await deleteAgentCoreGatewayTargets(gatewayId);
        
        if (!targetsDeleted) {
          logError(`Cannot delete gateway ${gatewayName}: targets could not be deleted`);
          continue;
        }
        
        // Wait a moment to ensure target deletion has propagated
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Then delete the gateway
        const deleteResult = execAWS(
          `aws bedrock-agentcore-control delete-gateway --gateway-identifier ${gatewayId} --region ${region}`,
          { silent: true }
        );
        
        if (deleteResult.success) {
          logSuccess(`Deleted AgentCore gateway: ${gatewayName}`);
        } else {
          // Check if it's still the targets error
          if (deleteResult.error && deleteResult.error.includes('targets associated')) {
            logWarning(`Gateway still has targets, retrying target deletion...`);
            // Try one more time
            await new Promise(resolve => setTimeout(resolve, 5000));
            const retryTargets = await deleteAgentCoreGatewayTargets(gatewayId);
            if (retryTargets) {
              const retryDelete = execAWS(
                `aws bedrock-agentcore-control delete-gateway --gateway-identifier ${gatewayId} --region ${region}`,
                { silent: true }
              );
              if (retryDelete.success) {
                logSuccess(`Deleted AgentCore gateway: ${gatewayName} (after retry)`);
              } else {
                logError(`Failed to delete AgentCore gateway ${gatewayName} after retry: ${retryDelete.error}`);
              }
            } else {
              logError(`Failed to delete AgentCore gateway ${gatewayName}: targets could not be deleted`);
            }
          } else {
            logError(`Failed to delete AgentCore gateway ${gatewayName}: ${deleteResult.error}`);
          }
        }
      } catch (error) {
        logError(`Error deleting AgentCore gateway ${gatewayName}: ${error.message}`);
      }
    }
  } catch (error) {
    logError(`Failed to process AgentCore gateways: ${error.message}`);
  }
}

async function deleteDynamoDBTables() {
  if (skipTables) {
    logWarning('Skipping DynamoDB table deletion (--skip-tables flag)');
    return;
  }
  
  logHeader('🗑️  Deleting DynamoDB Tables');
  
  if (!force) {
    logWarning('This will delete all SupplySense DynamoDB tables and their data!');
    logWarning('Tables to be deleted:');
    DYNAMODB_TABLES.forEach(table => log(`  - ${table}`, colors.yellow));
    log('\nUse --force flag to proceed without confirmation.', colors.yellow);
    return;
  }
  
  for (const tableName of DYNAMODB_TABLES) {
    try {
      // Check if table exists
      const checkResult = execAWS(
        `aws dynamodb describe-table --table-name ${tableName} --region ${region} --output json`,
        { silent: true }
      );
      
      if (!checkResult.success) {
        logInfo(`Table ${tableName} does not exist, skipping`);
        continue;
      }
      
      logInfo(`Deleting DynamoDB table: ${tableName}`);
      const deleteResult = execAWS(
        `aws dynamodb delete-table --table-name ${tableName} --region ${region}`,
        { silent: true }
      );
      
      if (deleteResult.success) {
        logSuccess(`Deleted DynamoDB table: ${tableName}`);
      } else {
        logError(`Failed to delete DynamoDB table ${tableName}: ${deleteResult.error}`);
      }
    } catch (error) {
      logError(`Error deleting DynamoDB table ${tableName}: ${error.message}`);
    }
  }
}

async function deleteSSMParameters() {
  logHeader('🗑️  Deleting SSM Parameters');
  
  try {
    const result = execAWS(
      `aws ssm get-parameters-by-path --path /supplysense/agents --recursive --region ${region} --output json`,
      { silent: true }
    );
    
    if (!result.success) {
      logWarning(`Could not list SSM parameters: ${result.error}`);
      return;
    }
    
    const data = JSON.parse(result.output);
    const parameters = data.Parameters || [];
    
    for (const param of parameters) {
      try {
        logInfo(`Deleting SSM parameter: ${param.Name}`);
        const deleteResult = execAWS(
          `aws ssm delete-parameter --name "${param.Name}" --region ${region}`,
          { silent: true }
        );
        
        if (deleteResult.success) {
          logSuccess(`Deleted SSM parameter: ${param.Name}`);
        } else {
          logError(`Failed to delete SSM parameter ${param.Name}: ${deleteResult.error}`);
        }
      } catch (error) {
        logError(`Error deleting SSM parameter ${param.Name}: ${error.message}`);
      }
    }
  } catch (error) {
    logWarning(`Could not delete SSM parameters: ${error.message}`);
  }
}

async function main() {
  logHeader('🧹 SupplySense Complete Cleanup');
  
  logInfo(`Region: ${region}`);
  logInfo(`Force mode: ${force ? 'Yes' : 'No'}`);
  logInfo(`Skip tables: ${skipTables ? 'Yes' : 'No'}`);
  
  if (!force) {
    logWarning('\n⚠️  WARNING: This will delete all SupplySense resources!');
    logWarning('Use --force flag to proceed without confirmation.\n');
    return;
  }
  
  try {
    // Step 1: Delete resources that CloudFormation can't remove (do this first to avoid conflicts)
    // Delete gateways first (they have targets that must be deleted)
    await deleteAgentCoreGateways();
    // Then delete runtimes
    await deleteAgentCoreRuntimes();
    // Delete ECR repos (with all images)
    await deleteECRRepositories();
    // Delete SNS topics
    await deleteSNSTopics();
    // Delete SSM parameters
    await deleteSSMParameters();
    
    // Step 2: Delete CDK stacks (this removes most resources)
    // Do this after manual cleanup to avoid conflicts
    await deleteCDKStacks();
    
    // Step 3: Delete DynamoDB tables (can be done anytime)
    await deleteDynamoDBTables();
    
    logHeader('✅ Cleanup Complete');
    logSuccess('All SupplySense resources have been deleted (or attempted)');
    logInfo('Note: Some resources may take a few minutes to fully delete');
    logInfo('Check AWS Console to verify all resources are removed');
    
  } catch (error) {
    logError(`Cleanup failed: ${error.message}`);
    process.exit(1);
  }
}

// Run cleanup
main().catch(error => {
  logError(`Fatal error: ${error.message}`);
  process.exit(1);
});
