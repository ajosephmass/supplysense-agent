# SupplySense 🚀

**Multi-Agent Supply Chain Resilience System** powered by AWS Bedrock AgentCore

SupplySense is a production-ready AI system that uses 5 specialized agents to provide real-time supply chain intelligence, risk assessment, and optimization recommendations. Built with AWS Bedrock AgentCore, it delivers enterprise-grade multi-agent coordination with streaming responses.

## 🎯 **Key Features**

- **5 Specialized AI Agents** - Inventory, Demand, Orchestrator, Logistics, and Risk agents
- **Real-time Streaming** - Server-Sent Events (SSE) for live agent coordination
- **Multi-Agent Workflows** - Parallel and sequential agent coordination patterns
- **Production Infrastructure** - AWS CDK with Bedrock AgentCore, ECS Fargate, DynamoDB
- **Enterprise Authentication** - AWS Cognito with JWT token validation
- **Confidence Scoring** - AI reasoning with confidence levels and explanations

## 🏗️ **Architecture Overview**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        AWS Bedrock AgentCore                           │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │ Inventory Agent │  │ Demand Agent    │  │ Orchestrator    │         │
│  │ Nova Micro      │  │ Nova Lite       │  │ Nova Pro        │         │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘         │
│                                                                         │
│  ┌─────────────────┐  ┌─────────────────┐                             │
│  │ Logistics Agent │  │ Risk Agent      │                             │
│  │ Nova Lite       │  │ Nova Pro        │                             │
│  └─────────────────┘  └─────────────────┘                             │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────▼───────────────┐
                    │        ECS Fargate            │
                    │  SupplySense Chat Service     │
                    │  • SSE Streaming              │
                    │  • Agent Coordination         │
                    │  • Real-time Updates          │
                    └───────────────────────────────┘
                                    │
                    ┌───────────────▼───────────────┐
                    │     Next.js UI + DynamoDB     │
                    │  • Real-time Chat Interface   │
                    │  • Agent Status Visualization │
                    │  • Cognito Authentication     │
                    └───────────────────────────────┘
```

## 🤖 **The 5 Specialized Agents**

### 1. **Inventory Intelligence Agent** (Nova Micro)
- **@tool analyze_inventory** - Comprehensive inventory analysis
- **@tool check_availability** - Product availability checking  
- **@tool reserve_stock** - Stock reservation management

### 2. **Demand Forecasting Agent** (Nova Lite)
- **@tool forecast_demand** - ML-powered demand forecasting
- **@tool analyze_demand_patterns** - Pattern recognition
- **@tool detect_demand_surge** - Surge detection and capacity impact

### 3. **Supply Chain Orchestrator Agent** (Nova Pro)
- **@tool orchestrate_fulfillment** - Multi-agent coordination
- **@tool create_action_plan** - Comprehensive planning
- **@tool synthesize_multi_agent_response** - Response synthesis

### 4. **Logistics Optimization Agent** (Nova Lite)
- **@tool optimize_routes** - Route optimization
- **@tool calculate_shipping_options** - Shipping analysis

### 5. **Risk Assessment Agent** (Nova Pro)
- **@tool assess_supply_chain_risks** - Comprehensive risk assessment
- **@tool analyze_disruption_impact** - Disruption impact analysis

## Project Structure
```
supplysense/
├── infrastructure/          # CDK infrastructure code
├── agents/                 # Agent implementations
├── ui/                     # React dashboard
├── data/                   # Mock data and schemas
├── models/                 # SageMaker model code
└── docs/                   # Documentation
```

## Getting Started
1. Install dependencies: `npm install`
2. Deploy infrastructure: `npm run deploy`
3. Load mock data: `npm run seed-data`
4. Start UI: `npm run dev`

## Demo Scenarios
- Inventory shortage detection and automatic reordering
- Supplier delay impact assessment and re-routing
- Demand surge handling with capacity optimization
- Multi-constraint fulfillment planning

## 🚀 **Quick Start**

### Prerequisites
- **AWS CLI v2** with configured credentials
- **Node.js 18+** and npm
- **Python 3.11+** 
- **AWS CDK v2** (`npm install -g aws-cdk@latest` or use `npx cdk`)

### One-Command Deployment
```bash
# Cross-platform deployment
npm run deploy-system

# This will:
# ✅ Check prerequisites
# ✅ Install all dependencies  
# ✅ Deploy infrastructure (CDK)
# ✅ Provision 5 AgentCore runtimes
# ✅ Seed sample data
# ✅ Build and configure UI
# ✅ Run system health checks
```

### Manual Step-by-Step
```bash
# 1. Install dependencies
npm install
cd ui && npm install && cd ..
cd orchestrator && npm install && cd ..

# 2. Build TypeScript
npm run build

# 3. Bootstrap CDK (first time only)
cdk bootstrap

# 4. Deploy infrastructure
npm run deploy

# 5. Seed sample data
npm run seed-data

# 6. Start UI
cd ui && npm run dev
```

### Access the System
1. **Open browser**: http://localhost:3000
2. **Sign up** with email verification
3. **Try sample queries**:
   - "Can I fulfill all orders this week?"
   - "What's my current inventory status?"
   - "SUP-001 has a 5-day delay, what's the impact?"

## 💬 **Example Interactions**

### Fulfillment Analysis
```
User: "Can I fulfill all customer orders this week?"

🔄 Orchestrator: Coordinating inventory, demand, and risk agents...
📦 Inventory Agent: ✅ Complete (2.1s) - 85% fulfillment possible
📈 Demand Agent: ✅ Complete (3.4s) - Weekly demand: 200 units
⚠️ Risk Agent: ✅ Complete (2.8s) - PROD-002 shortage risk detected
🔄 Orchestrator: ✅ Synthesis complete (1.2s)

📊 Analysis Complete:
✅ Can fulfill 85% of orders with current inventory
⚠️ Shortfall: PROD-002 (30 units needed, 15 available)
🚨 Critical: PROD-003 out of stock (30 units needed)

🔄 Recommended Actions:
1. Emergency reorder from SUP-001 (3-day delivery) - $7,500
2. Activate backup supplier SUP-002 for PROD-003 - $4,200  
3. Partial fulfillment with customer communication

⏱️ Timeline: 72 hours to full capability
🎯 Confidence: 87%
```

### Supplier Disruption Impact
```
User: "SUP-001 has a 5-day delay on PROD-001. What's the impact?"

🚨 Supplier Delay Impact Analysis:

📦 Affected Inventory:
- PROD-001: 7-day runway (delay manageable)
- Current stock: 195 units across all locations
- Daily consumption: 28 units average

📈 Demand Impact:
- Expected orders during delay: 140 units
- Revenue at risk: $7,000
- Customer orders affected: 3 pending orders

🔄 Mitigation Plan:
1. Immediate: Source from SUP-002 (backup supplier)
2. Short-term: Increase safety stock by 25%
3. Long-term: Diversify supplier base

⚠️ Customer Impact: No delays expected with mitigation
💰 Additional cost: ~$2,100 (premium supplier rates)
🎯 Confidence: 92%
```

## 🛠️ **Technology Stack**

### **AI & Agents**
- **AWS Bedrock AgentCore** - Managed agent runtime platform
- **Amazon Nova Models** - Micro, Lite, and Pro for different agent needs
- **Multi-Agent Coordination** - Parallel and sequential execution patterns

### **Backend Services**  
- **ECS Fargate** - Chat orchestration service with SSE streaming
- **DynamoDB** - Real-time data storage (inventory, orders, suppliers)
- **AWS Lambda** - Custom resource provisioning and utilities
- **API Gateway** - RESTful API with JWT authentication

### **Frontend & Auth**
- **Next.js 14** - React-based UI with TypeScript
- **AWS Amplify** - Authentication and API integration
- **AWS Cognito** - User management and JWT tokens
- **Recharts** - Data visualization and dashboards

### **Infrastructure**
- **AWS CDK** - Infrastructure as Code with TypeScript
- **CloudWatch** - Logging, monitoring, and alerting
- **SSM Parameter Store** - Configuration management
- **IAM** - Fine-grained security and permissions

## 📊 **Project Structure**

```
supplysense/
├── infrastructure/                 # CDK Infrastructure
│   ├── stacks/
│   │   ├── supplysense-stack.ts           # DynamoDB tables
│   │   ├── supplysense-agentcore-stack.ts # 5 AgentCore runtimes  
│   │   └── supplysense-chat-stack.ts      # ECS chat service
│   ├── custom-resources/
│   │   └── agentcore-provisioner.py       # Agent setup automation
│   └── agentcore-gateway-manifest.json    # Agent configurations
├── agents/                        # Agent Implementations
│   ├── inventory_agent/app.py             # Inventory Intelligence
│   ├── demand_agent/app.py                # Demand Forecasting  
│   ├── orchestrator_agent/app.py          # Supply Chain Orchestrator
│   ├── logistics_agent/app.py             # Logistics Optimization
│   └── risk_agent/app.py                  # Risk Assessment
├── orchestrator/                  # Real-time Chat Service
│   ├── app.js                             # Express.js with SSE
│   ├── package.json
│   └── Dockerfile                         # ECS container
├── ui/                           # Next.js Frontend
│   ├── pages/
│   │   ├── index.tsx                      # Main dashboard
│   │   └── _app.tsx                       # Amplify auth wrapper
│   └── lib/amplify-config.ts              # AWS configuration
├── data/mock-data.json           # Sample supply chain data
├── scripts/                      # Deployment & Testing
│   ├── deploy-complete-system.js         # One-command deployment
│   ├── test-deployment.js               # System health checks
│   ├── seed-data.js                      # Database seeding
│   └── validate-system.js               # System validation
└── docs/                         # Documentation
    ├── ARCHITECTURE.md
    ├── DEMO_SCENARIOS.md
    └── DEPLOYMENT_GUIDE.md
```

## 🔧 **Configuration**

### **Environment Variables**
```bash
# UI Configuration (ui/.env.local)
NEXT_PUBLIC_USER_POOL_ID=us-east-1_XXXXXXXXX
NEXT_PUBLIC_USER_POOL_CLIENT_ID=XXXXXXXXXXXXXXXXXXXXXXXXXX  
NEXT_PUBLIC_IDENTITY_POOL_ID=us-east-1:XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
NEXT_PUBLIC_API_ENDPOINT=https://XXXXXXXXXX.execute-api.us-east-1.amazonaws.com/prod
NEXT_PUBLIC_AWS_REGION=us-east-1

# Chat Service Configuration (ECS environment)
AWS_REGION=us-east-1
COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
COGNITO_USER_POOL_CLIENT_ID=XXXXXXXXXXXXXXXXXXXXXXXXXX
```

### **Agent Model Configuration**
- **Inventory Agent**: Nova Micro (cost-optimized for simple queries)
- **Demand Agent**: Nova Lite (balanced performance for forecasting)
- **Orchestrator Agent**: Nova Pro (advanced reasoning for coordination)
- **Logistics Agent**: Nova Lite (efficient route optimization)
- **Risk Agent**: Nova Pro (complex risk analysis and reasoning)

## 🧪 **Testing**

### **System Health Check**
```bash
# Run comprehensive system test
npm run test-deployment

# Tests:
# ✅ Infrastructure deployment status
# ✅ API endpoint health
# ✅ DynamoDB table status and data
# ✅ Bedrock agent preparation
# ✅ Cognito user pool configuration
# ✅ UI build and environment setup
```

### **Manual Testing Scenarios**
1. **Inventory Analysis**: "What's my current inventory status?"
2. **Fulfillment Planning**: "Can I fulfill all orders this week?"
3. **Supplier Disruption**: "SUP-001 has a delay, what's the impact?"
4. **Demand Forecasting**: "Show me demand forecasts for next month"
5. **Route Optimization**: "Optimize delivery for urgent order ORD-001"

## 📈 **Performance & Scaling**

### **Response Times**
- **Simple queries** (inventory status): 2-5 seconds
- **Multi-agent analysis** (fulfillment): 10-15 seconds
- **Complex coordination** (risk assessment): 15-30 seconds

### **Scaling Configuration**
- **ECS Fargate**: Auto-scaling based on CPU/memory
- **DynamoDB**: On-demand billing with burst capacity
- **Bedrock AgentCore**: Managed scaling by AWS
- **API Gateway**: Automatic scaling to handle traffic

### **Cost Optimization**
- **Nova Micro** for simple inventory queries (~$0.0001/request)
- **Nova Lite** for demand/logistics (~$0.0005/request)  
- **Nova Pro** for complex orchestration (~$0.002/request)
- **ECS Fargate**: Pay-per-use with 1 vCPU, 2GB RAM

## 🔒 **Security**

### **Authentication & Authorization**
- **AWS Cognito** user pools with email verification
- **JWT tokens** with 1-hour expiration
- **IAM roles** with least-privilege access
- **API Gateway** with Cognito authorizer

### **Data Protection**
- **Encryption at rest** (DynamoDB, S3)
- **Encryption in transit** (HTTPS, TLS 1.2+)
- **VPC isolation** for ECS containers
- **CloudTrail** audit logging

## 🚀 **Production Deployment**

### **Infrastructure Checklist**
- [ ] **WAF** enabled on API Gateway
- [ ] **CloudWatch alarms** for error rates and latency
- [ ] **Backup strategy** for DynamoDB tables
- [ ] **Multi-AZ deployment** for high availability
- [ ] **Cost monitoring** and billing alerts
- [ ] **Security scanning** and compliance checks

### **Monitoring & Observability**
- **CloudWatch Logs** for all services
- **X-Ray tracing** for request flow analysis
- **Custom metrics** for agent performance
- **Dashboards** for operational visibility

## 🤝 **Contributing**

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

## 📄 **License**

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 **Support**

- **Documentation**: See `/docs` folder for detailed guides
- **Issues**: Report bugs via GitHub Issues
- **Discussions**: Join GitHub Discussions for questions
- **Architecture**: Review `SUPPLYSENSE_ARCHITECTURE_DESIGN.md`

---

**SupplySense** - Transforming supply chain management with AI-powered multi-agent intelligence! 🚀