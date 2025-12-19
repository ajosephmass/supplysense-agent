# SupplySense Infrastructure

AWS CDK infrastructure code for deploying SupplySense.

## Stacks

### SupplySenseTablesStack
DynamoDB tables for supply chain data.

**Tables created:**
- `supplysense-inventory` - Product inventory across locations
- `supplysense-orders` - Customer orders
- `supplysense-demand-forecast` - Demand forecasting data
- `supplysense-logistics` - Logistics and routing
- `supplysense-suppliers` - Supplier information
- `supplysense-actions` - Workflow action items
- `supplysense-approvals` - Approval requests

### SupplySenseAgentCoreStack
Amazon Bedrock AgentCore agents and Cognito authentication.

**Resources created:**
- 5 AgentCore agent runtimes (Inventory, Demand, Logistics, Risk, Orchestrator)
- CodeBuild projects for building agent Docker images
- ECR repositories for agent images
- Cognito User Pool and Client
- SSM parameters for runtime configuration

### SupplySenseChatStack
Chat service, UI, and notification infrastructure.

**Resources created:**
- ECS Fargate service for chat orchestration
- Application Load Balancer
- S3 bucket for UI hosting
- CloudFront distribution
- SNS topics for action/approval events
- SQS queue for notification verification
- CodeBuild project for UI builds

## Deployment Order

```bash
# 1. Tables first (no dependencies)
npx cdk deploy SupplySenseTablesStack

# 2. AgentCore (depends on tables)
npx cdk deploy SupplySenseAgentCoreStack

# 3. Chat service and UI (depends on AgentCore)
npx cdk deploy SupplySenseChatStack
```

## Directory Structure

```
infrastructure/
├── bin/
│   └── app.ts           # CDK app entry point
├── stacks/
│   ├── supplysense-tables-stack.ts
│   ├── supplysense-agentcore-stack.ts
│   └── supplysense-chat-stack.ts
├── package.json
└── tsconfig.json
```

## Useful Commands

```bash
# Synthesize CloudFormation template
npx cdk synth

# Compare deployed stack with current state
npx cdk diff

# Deploy all stacks
npx cdk deploy --all

# Destroy all resources
npx cdk destroy --all
```

## Configuration

Stack configuration is primarily done through:
- CDK context in `cdk.json`
- Environment variables
- SSM parameters (populated during deployment)

