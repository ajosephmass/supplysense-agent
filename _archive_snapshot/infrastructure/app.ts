#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SupplySenseStack } from './stacks/supplysense-stack';
import { SupplySenseAgentCoreStack } from './stacks/supplysense-agentcore-stack';
import { SupplySenseChatStack } from './stacks/supplysense-chat-stack';
import { SupplySenseTablesStack } from './stacks/supplysense-tables-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// Data layer (DynamoDB tables, Cognito, API Gateway)
const dataStack = new SupplySenseStack(app, 'SupplySenseStack', { env });

// DynamoDB Tables
const tablesStack = new SupplySenseTablesStack(app, 'SupplySenseTablesStack', { env });

// AgentCore layer (Real Bedrock Agents)
const agentCoreStack = new SupplySenseAgentCoreStack(app, 'SupplySenseAgentCoreStack', {
  env,
  apiUrl: 'https://api.supplysense.com',
});

// Chat orchestration layer (ECS Fargate service)
const chatStack = new SupplySenseChatStack(app, 'SupplySenseChatStack', {
  env,
  cognitoUserPoolId: agentCoreStack.cognitoUserPoolId,
  cognitoUserPoolClientId: agentCoreStack.cognitoUserPoolClientId,
});

// Add dependencies
agentCoreStack.addDependency(dataStack);
agentCoreStack.addDependency(tablesStack);
chatStack.addDependency(agentCoreStack);