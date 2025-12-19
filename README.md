# SupplySense

**AI-Powered Multi-Agent Supply Chain Intelligence Platform**

SupplySense is a reference implementation demonstrating how to build a multi-agent AI system using Amazon Bedrock AgentCore and Amazon Nova models. It coordinates five specialized AI agents to analyze inventory, forecast demand, assess risks, optimize logistics, and deliver unified supply chain insights.

![Architecture](docs/architecture.png)

## 🎯 What This Project Demonstrates

- **Spec-Driven Development**: Architecture defined in [specifications](.kiro/specs/supplysense-architecture.md) using Kiro
- **Multi-Agent Coordination**: Five specialized agents working together via an orchestrator
- **Amazon Bedrock AgentCore**: Container-based agent runtimes with custom tools
- **Amazon Nova Models**: Nova Pro for complex reasoning, Nova Lite for efficient processing
- **Real-Time Streaming**: Server-Sent Events for live agent status updates
- **Workflow Automation**: Actions and approvals with SNS/SQS notifications

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        SupplySense UI                            │
│                  (Next.js on S3/CloudFront)                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Chat Service (ECS Fargate)                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│               Amazon Bedrock AgentCore Orchestrator              │
│                                                                 │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐       │
│  │ Inventory │ │  Demand   │ │ Logistics │ │   Risk    │       │
│  │   Agent   │ │   Agent   │ │   Agent   │ │   Agent   │       │
│  └───────────┘ └───────────┘ └───────────┘ └───────────┘       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│           DynamoDB Tables  │  SNS/SQS Notifications             │
└─────────────────────────────────────────────────────────────────┘
```

## 📁 Project Structure

```
supplysense/
├── agents/                 # AI agent implementations
│   ├── inventory_agent/    # Inventory analysis (Nova Pro)
│   ├── demand_agent/       # Demand forecasting (Nova Lite)
│   ├── logistics_agent/    # Route optimization (Nova Lite)
│   ├── risk_agent/         # Risk assessment (Nova Pro)
│   └── orchestrator_agent/ # Multi-agent coordination (Nova Pro)
├── chat-service/           # Flask API service (ECS Fargate)
├── infrastructure/         # AWS CDK stacks
├── ui/                     # Next.js React frontend
├── scripts/                # Deployment and seeding scripts
├── data/                   # Sample data files
├── docs/                   # Documentation
└── .kiro/specs/           # Architecture specifications
```

## 🚀 Quick Start

### Prerequisites

- AWS Account with administrative access
- AWS CLI v2 configured
- Node.js 18+, Python 3.11+
- Docker
- AWS CDK v2

### Deploy

```bash
# Clone repository
git clone https://github.com/your-org/supplysense.git
cd supplysense

# Install dependencies
npm install

# Bootstrap CDK (first time only)
npx cdk bootstrap

# Deploy all stacks (20-30 minutes)
npx cdk deploy SupplySenseTablesStack --require-approval never
npx cdk deploy SupplySenseAgentCoreStack --require-approval never
npx cdk deploy SupplySenseChatStack --require-approval never

# Seed sample data
node scripts/seed-data.js
```

### Create a User

```bash
USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name SupplySenseAgentCoreStack \
  --query "Stacks[0].Outputs[?OutputKey=='CognitoUserPoolId'].OutputValue" \
  --output text)

aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username your-email@example.com \
  --user-attributes Name=email,Value=your-email@example.com \
  --temporary-password TempPass123!
```

### Access the Application

```bash
aws cloudformation describe-stacks \
  --stack-name SupplySenseChatStack \
  --query "Stacks[0].Outputs[?OutputKey=='ChatUIUrl'].OutputValue" \
  --output text
```

## 💬 Sample Queries

| Query | What It Does |
|-------|--------------|
| "Can I fulfill all customer orders this week given current inventory?" | Comprehensive fulfillment analysis |
| "What is the current inventory status across all warehouses?" | Inventory status with shortage identification |
| "Which SKUs are at risk of stockout in the next 7 days?" | Predictive stockout analysis |
| "What is the revenue impact if we have supply delays?" | Risk and financial impact assessment |
| "Are there any logistics constraints for pending orders?" | Logistics capacity analysis |

See [docs/SAMPLE_QUERIES.md](docs/SAMPLE_QUERIES.md) for more examples.

## 📚 Documentation

- [Deployment Guide](docs/DEPLOYMENT_GUIDE.md) - Step-by-step deployment instructions
- [Sample Queries](docs/SAMPLE_QUERIES.md) - Example queries and expected behavior
- [Architecture Specification](.kiro/specs/supplysense-architecture.md) - Detailed system design
- [Blog Post](AGENTCORE_BLOG.md) - Learn to build guide

## 🔧 Extending the Platform

### Adding a New Agent

1. Create directory under `agents/`
2. Implement `app.py` with tools and system prompt
3. Add to CDK stack configuration
4. Deploy

### Adding Custom Tools

```python
@tool
def my_custom_tool(param: str) -> dict:
    """Description of what the tool does."""
    # Implementation
    return {"result": "value"}
```

### Connecting to Enterprise Systems

The reference uses DynamoDB for mock data. For production:
- Connect to SAP, Oracle, or custom ERPs
- Implement adapters in agent tools
- Consider Lambda functions for scalability

## ⚠️ Production Considerations

This is a **learning reference implementation**. For production:

- [ ] Implement VPC endpoints and WAF rules
- [ ] Externalize tools to Lambda functions
- [ ] Add comprehensive monitoring and alerting
- [ ] Connect to real data sources
- [ ] Implement CI/CD pipelines
- [ ] Add load testing and performance optimization

## 💰 Cost Estimate

For a pilot environment with moderate usage:
- AgentCore runtimes: ~$20-40/month
- ECS Fargate: ~$15-25/month
- DynamoDB: ~$5-10/month
- Other services: ~$5-10/month
- **Total**: ~$45-85/month

## 🧹 Cleanup

To remove all SupplySense resources, use the cleanup script:

```bash
# Remove all resources (stacks, agents, ECR repos, SNS topics, etc.)
node scripts/cleanup.js --force

# Skip DynamoDB tables (if you want to keep data)
node scripts/cleanup.js --force --skip-tables
```

The cleanup script handles:
- CDK stack deletion (with retry logic for failed stacks)
- AgentCore gateway and runtime deletion
- ECR repository cleanup (deletes images first)
- SNS topic deletion (unsubscribes first)
- SSM parameter cleanup
- Optional DynamoDB table deletion

**Note**: Some custom resources (SNS logging) may fail to delete due to a known CloudFormation bug. These are configuration-only resources and can be safely ignored.

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

- Built with [Amazon Bedrock AgentCore](https://aws.amazon.com/bedrock/)
- Powered by [Amazon Nova Models](https://aws.amazon.com/bedrock/nova/)
- Specification authored with [Kiro](https://kiro.dev)
