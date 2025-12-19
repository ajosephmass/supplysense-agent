# SupplySense Deployment Guide

This guide walks you through deploying the SupplySense multi-agent supply chain intelligence platform.

## Prerequisites

### Required Tools
- **AWS Account** with administrative access
- **AWS CLI v2** configured with credentials (`aws configure`)
- **Node.js 18+** and npm (`node --version`)
- **Python 3.11+** (`python --version`)
- **AWS CDK v2** (`npm install -g aws-cdk` or use `npx cdk`)
- **Docker** (for CodeBuild image building)

### Required AWS Permissions
Your AWS credentials need permissions for:
- Bedrock AgentCore (control plane and runtime)
- ECS Fargate, ECR, CodeBuild
- DynamoDB, S3, CloudFormation
- Cognito User Pools, IAM roles
- SNS, SQS
- CloudWatch Logs, SSM Parameter Store

## Deployment Steps

### Step 1: Clone and Install Dependencies

```bash
git clone https://github.com/your-org/supplysense.git
cd supplysense
npm install
```

### Step 2: Bootstrap CDK (First Time Only)

If you haven't used CDK in this AWS account/region before:

```bash
npx cdk bootstrap
```

### Step 3: Deploy Infrastructure Stacks

Deploy in this order:

```bash
# 1. Deploy DynamoDB tables
npx cdk deploy SupplySenseTablesStack --require-approval never

# 2. Deploy AgentCore agents (20-25 minutes)
# This builds Docker images for each agent
npx cdk deploy SupplySenseAgentCoreStack --require-approval never

# 3. Deploy Chat service, UI, SNS/SQS
npx cdk deploy SupplySenseChatStack --require-approval never
```

**Note**: The AgentCore stack takes 20-25 minutes as it builds Docker images for all 5 agents.

### Step 4: Seed Sample Data

```bash
node scripts/seed-data.js
```

This populates DynamoDB tables with sample inventory, orders, suppliers, and logistics data.

### Step 5: Create a Test User

```bash
# Get the User Pool ID
USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name SupplySenseAgentCoreStack \
  --query "Stacks[0].Outputs[?OutputKey=='CognitoUserPoolId'].OutputValue" \
  --output text)

# Create user (replace with your email)
aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username your-email@example.com \
  --user-attributes Name=email,Value=your-email@example.com \
  --temporary-password TempPass123!

# Set permanent password (optional)
aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username your-email@example.com \
  --password YourSecurePassword123! \
  --permanent
```

### Step 6: Access the Application

Get the UI URL:

```bash
aws cloudformation describe-stacks \
  --stack-name SupplySenseChatStack \
  --query "Stacks[0].Outputs[?OutputKey=='ChatUIUrl'].OutputValue" \
  --output text
```

Open the URL in your browser and sign in with the user you created.

## Verification

### Check Agent Runtimes

```bash
aws bedrock-agentcore-control list-agent-runtimes \
  --query "agentRuntimes[?contains(agentRuntimeName, 'SupplySense')].{Name:agentRuntimeName, ID:agentRuntimeId}" \
  --output table
```

### Check SSM Parameters

```bash
aws ssm get-parameters-by-path \
  --path /supplysense/agents \
  --recursive \
  --query "Parameters[].{Name:Name}" \
  --output table
```

### View Notification Messages

```bash
# Get queue URL
QUEUE_URL=$(aws cloudformation describe-stacks \
  --stack-name SupplySenseChatStack \
  --query "Stacks[0].Outputs[?OutputKey=='NotificationQueueUrl'].OutputValue" \
  --output text)

# View messages
aws sqs receive-message \
  --queue-url $QUEUE_URL \
  --max-number-of-messages 10
```

## Troubleshooting

### Agent Returns 424 Error
- Check that agent runtimes are in `ACTIVE` state
- Verify SSM parameters contain correct ARNs
- Check CloudWatch logs for the specific agent

### UI Shows "Auth UserPool not configured"
- Verify the UI was built with correct Cognito environment variables
- Trigger a UI rebuild: `aws codebuild start-build --project-name <UI_BUILD_PROJECT>`

### Actions Not Appearing in SQS
- Verify SNS topic subscriptions exist
- Check ECS service logs for SNS publish errors

## Cleanup

To remove all resources:

```bash
npx cdk destroy SupplySenseChatStack
npx cdk destroy SupplySenseAgentCoreStack
npx cdk destroy SupplySenseTablesStack
```

**Warning**: This will delete all data in DynamoDB tables.

## Cost Optimization

For development/testing:
- Use `t3.micro` or smaller instances where possible
- Set DynamoDB to on-demand billing
- Stop ECS services when not in use

Estimated monthly cost for pilot environment: $45-85/month

