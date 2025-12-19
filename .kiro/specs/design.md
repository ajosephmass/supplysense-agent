# SupplySense Multi-Agent Supply Chain Intelligence System

## 1. System Architecture

### 1.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SupplySense UI                                 │
│                    (Next.js Static Export on S3/CloudFront)                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Chat Service (ECS Fargate)                          │
│              Flask App - Passthrough + Persistence + SNS Publish            │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    Amazon Bedrock AgentCore Orchestrator                    │
│                         (amazon.nova-pro-v1:0)                              │
│                                                                             │
│    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│    │  Inventory   │  │   Demand     │  │  Logistics   │  │    Risk      │   │
│    │    Agent     │  │    Agent     │  │    Agent     │  │    Agent     │   │
│    │  (nova-pro)  │  │ (nova-lite)  │  │ (nova-lite)  │  │  (nova-pro)  │   │
│    └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Data Layer                                     │
│                                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  Inventory  │  │   Orders    │  │  Logistics  │  │  Suppliers  │         │
│  │   Table     │  │   Table     │  │   Table     │  │   Table     │         │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘         │
│                                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                          │
│  │   Actions   │  │  Approvals  │  │   Demand    │                          │
│  │   Table     │  │   Table     │  │  Forecast   │                          │
│  └─────────────┘  └─────────────┘  └─────────────┘                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                        Notification Layer                                  │
│                                                                            │
│  ┌─────────────────────┐    ┌─────────────────────┐                        │
│  │  SNS Action Events  │───▶│   SQS Notification │                         │
│  │       Topic         │    │       Queue         │                        │
│  └─────────────────────┘    └─────────────────────┘                        │
│  ┌─────────────────────┐              │                                    │
│  │ SNS Approval Events │──────────────┘                                    │
│  │       Topic         │                                                   │
│  └─────────────────────┘                                                   │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Agent Layer (Amazon Bedrock AgentCore)

### 2.1 Inventory Agent
- **Runtime ID**: `SupplySenseInventory-{hash}`
- **Model**: `amazon.nova-pro-v1:0`
- **Purpose**: Analyze inventory levels, check product availability, provide reorder recommendations
- **Tools**:
  - `check_order_fulfillment_capacity()` - Check if inventory can fulfill ALL pending orders
  - `analyze_inventory()` - Get comprehensive inventory status across locations
  - `check_availability()` - Check specific product availability
  - `reserve_stock()` - Reserve inventory for orders
- **Response Format**: JSON with `highlightSummary` (2-3 sentences) and `detailedSummary` (5-8 sentences)
- **Data Sources**: DynamoDB `supplysense-inventory`, `supplysense-orders`

### 2.2 Demand Agent
- **Runtime ID**: `SupplySenseDemand-{hash}`
- **Model**: `amazon.nova-lite-v1:0`
- **Purpose**: Generate demand forecasts, identify patterns, detect demand surges
- **Tools**:
  - `analyze_demand_for_pending_orders()` - Analyze demand for ALL pending orders
  - `forecast_demand()` - Generate statistical demand forecasts
  - `analyze_demand_patterns()` - Identify trends and seasonality
  - `detect_demand_surge()` - Detect unusual demand patterns
- **Response Format**: JSON with revenue/margin analysis and product-level details
- **Data Sources**: DynamoDB `supplysense-orders`, `supplysense-demand-forecast`

### 2.3 Logistics Agent
- **Runtime ID**: `SupplySenseLogistics-{hash}`
- **Model**: `amazon.nova-lite-v1:0`
- **Purpose**: Optimize delivery routes, calculate shipping options, coordinate logistics
- **Tools**:
  - `analyze_all_pending_orders()` - Analyze logistics for ALL pending orders
  - `optimize_routes()` - Optimize delivery routes for specific orders
  - `calculate_shipping_options()` - Analyze shipping methods and costs
- **Response Format**: JSON with capacity metrics and route assignments
- **Data Sources**: DynamoDB `supplysense-orders`, `supplysense-logistics`

### 2.4 Risk Agent
- **Runtime ID**: `SupplySenseRisk-{hash}`
- **Model**: `amazon.nova-pro-v1:0`
- **Purpose**: Assess supply chain risks, identify vulnerabilities
- **Tools**:
  - `assess_supply_chain_risk()` - Comprehensive risk assessment
  - `identify_risk_factors()` - Identify specific risk factors
  - `generate_mitigation_plan()` - Generate risk mitigation strategies
- **Response Format**: JSON with risk scores and mitigation strategies

### 2.5 Orchestrator Agent
- **Runtime ID**: `SupplySenseOrchestrator-{hash}`
- **Runtime Endpoint**: `DEFAULT` (created by AgentCore)
- **Model**: `amazon.nova-pro-v1:0`
- **Purpose**: Coordinate multi-agent workflows, synthesize insights, create action plans
- **Agent Communication**: Calls other agents via AgentCore HTTP client using runtime ARN + endpoint name
- **Responsibilities**:
  - Query classification and routing
  - Multi-agent coordination (calls Inventory, Demand, Logistics, Risk agents)
  - Response synthesis with context-aware summaries
  - Action and approval creation WITH pre-drafted notifications
  - Notification email generation using LLM
- **Response Format**: Comprehensive JSON with:
  - `summary`: Context-aware answer to user query
  - `decision`: Can fulfill status, risk level, confidence
  - `agentFindings`: Structured insights from each agent
  - `actions`: Actionable items with pre-drafted notification emails
  - `approvals`: Items requiring approval with notification drafts
  - `nextSteps`: Recommended follow-up actions

**Note on Tools**: For simplicity, all agent tools are implemented within the AgentCore runtime code itself. In a production environment, these tools can be externalized to AWS Lambda functions or third-party services for better scalability and maintainability.

---

## 3. Chat Service Layer (ECS Fargate)

### 3.1 Flask Application
- **Purpose**: Passthrough service between UI and AgentCore agents
- **Container**: Python 3.11 Flask app on ECS Fargate
- **AgentCore Integration**: Uses `HttpBedrockAgentCoreClient` for agent invocation
- **Responsibilities**:
  - Accept user queries from UI
  - Route queries to Orchestrator Agent via AgentCore HTTP client
  - Retrieve runtime ARNs from SSM parameters
  - Pass JWT bearer tokens for authentication
  - Persist actions/approvals to DynamoDB
  - Publish SNS events when actions are completed or approvals are decided
  - **NOT responsible for**: LLM calls, notification generation, orchestration logic

### 3.2 AgentCore Communication Pattern
```python
# SSM Parameter Structure
/supplysense/agents/{agent_type}/runtime-id     # Runtime ID (e.g., SupplySenseOrchestrator-abc123)
/supplysense/agents/{agent_type}/invoke-arn     # Endpoint ARN

# Chat Service Pattern
1. Get endpoint ARN from SSM: /supplysense/agents/orchestrator/invoke-arn
2. Strip /runtime-endpoint/DEFAULT to get runtime ARN
3. Call http_client.invoke_endpoint(agent_arn=runtime_arn, endpoint_name='DEFAULT', ...)

# Orchestrator Pattern (calling other agents)
1. Get endpoint ARN from SSM for each specialist agent
2. Strip /runtime-endpoint/DEFAULT to get runtime ARN
3. Call http_client.invoke_endpoint(agent_arn=runtime_arn, endpoint_name='DEFAULT', ...)
```

### 3.3 Action/Approval Workflow
```
User Query → Chat Service → Orchestrator Agent (creates actions WITH notifications)
                ↓
         DynamoDB (persist actions + pre-drafted notifications)
                ↓
    User clicks "Mark Complete" → Chat Service publishes to SNS
                ↓
         SNS Topic → SQS Queue (for verification) / Email subscribers
```

---

## 4. Notification Layer (SNS/SQS)

### 4.1 SNS Topics
- **Action Events Topic**: `supplysense-action-events-{account}-{region}`
  - Receives notifications when actions are marked complete
- **Approval Events Topic**: `supplysense-approval-events-{account}-{region}`
  - Receives notifications when approvals are approved/rejected

### 4.2 SQS Queue
- **Notification Queue**: `supplysense-notifications-{account}-{region}`
  - Subscribed to both SNS topics
  - Retains messages for 7 days
  - Used for verification and debugging

**Note**: The SNS/SQS integration is included for demonstrative purposes to show how agents can interact with external APIs, messaging systems, and third-party applications. In a production environment, you would subscribe actual email endpoints, Lambda functions, or external systems to these topics.

### 4.3 Message Format
```json
{
  "subject": "[SupplySense] Action Complete: Draft emergency purchase orders",
  "body": "Dear Procurement Team,\n\nThe following supply chain action has been marked complete:\n\n  Action: Draft emergency purchase orders for shortage SKUs\n  Risk Level: High\n  Type: Autonomous\n\n..."
}
```

---

## 5. Data Layer (DynamoDB)

### 5.1 Tables
| Table Name | Purpose | Key Schema |
|------------|---------|------------|
| `supplysense-inventory` | Product inventory across locations | `productId` (PK), `locationId` (SK) |
| `supplysense-orders` | Customer orders | `orderId` (PK) |
| `supplysense-demand-forecast` | Demand forecasting data | `productId` (PK), `forecastDate` (SK) |
| `supplysense-logistics` | Logistics and routing | `shipmentId` (PK) |
| `supplysense-suppliers` | Supplier information | `supplierId` (PK) |
| `supplysense-actions` | Action items with workflow logs | `PK` (session), `SK` (action) |
| `supplysense-approvals` | Approval requests with decisions | `PK` (session), `SK` (approval) |
| `chat-sessions` | User session data | `sessionId` (PK) |

---

## 6. UI Layer (S3 + CloudFront)

### 6.1 Hosting
- **Storage**: S3 bucket with static website hosting
- **CDN**: CloudFront distribution with custom domain support
- **Build**: Next.js static export via CodeBuild

### 6.2 Features
- Real-time streaming responses from agents
- Agent highlights (2-3 sentence summaries)
- Agent insights (5-8 sentence detailed analysis with metrics)
- Conditional rendering:
  - Actions section: Only shows when actions exist
  - Approvals section: Only shows when approvals exist
  - Next Steps section: Only shows when steps exist
- Action execution with status tracking
- Approval workflow with approve/reject buttons
- Duplicate action prevention (shows "Already Completed" for previously taken actions)

### 6.3 API Proxy
- CloudFront `/api/*` routes to ALB for chat service
- Enables same-origin API calls from UI

---

## 7. Key Design Principles

### 7.1 Single Source of Intelligence
- **Orchestrator Agent**: Only component that uses LLM for decision-making
- **Chat Service**: Dumb passthrough + persistence layer (no LLM calls)
- **Agents**: Specialized domain experts with tool access

### 7.2 Notification Generation
- **Where**: Orchestrator Agent generates notification drafts
- **When**: During action/approval creation
- **How**: LLM generates context-aware emails with specific SKU IDs, quantities, timelines
- **Storage**: Pre-drafted notifications stored in DynamoDB with actions
- **Delivery**: Chat service publishes pre-drafted notifications to SNS

### 7.3 Response Structure
All agents return structured JSON:
```json
{
  "highlightSummary": "2-3 sentence concise summary",
  "detailedSummary": "5-8 sentence comprehensive analysis with specific data",
  "status": "sufficient|shortfall|constraint|insight",
  "confidence": 0.85,
  "blockers": ["Specific blockers with SKU IDs and quantities"],
  "recommendations": ["Actionable recommendations"],
  "metrics": { "key": "value" }
}
```

### 7.4 Query Classification
Orchestrator classifies queries into types:
- `fulfillment`: Can I fulfill orders?
- `stockout`: Which SKUs will stock out?
- `replenishment`: Replenishment recommendations
- `expedite`: Should I expedite shipments?
- `carrier`: Carrier comparison
- `revenue`: Revenue impact analysis
- `production`: Production scheduling
- `reallocation`: Stock reallocation
- And additional types

Each query type gets a context-appropriate response.

---

## 8. Monitoring & Logging

### 8.1 CloudWatch Log Groups
- `/ecs/supplysense-chat-orchestration-{account}-{region}`: Chat service logs
- `/aws/lambda/SupplySense*`: Agent runtime logs
- `/aws/codebuild/SupplySense*`: Build logs

### 8.2 SNS/SQS Verification
1. **SQS Queue**: Inspect messages directly in AWS Console or via CLI
2. **CloudWatch Metrics**: Monitor `NumberOfMessagesPublished` for SNS topics
3. **ECS Logs**: Show SNS publish calls with full message content
