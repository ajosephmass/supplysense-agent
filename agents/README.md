# SupplySense Agents

This directory contains the five specialized AI agents that power SupplySense.

## Agent Overview

| Agent | Model | Purpose |
|-------|-------|---------|
| `inventory_agent` | Nova Pro | Inventory analysis, stock availability, reorder recommendations |
| `demand_agent` | Nova Lite | Demand forecasting, pattern recognition, surge detection |
| `logistics_agent` | Nova Lite | Route optimization, carrier selection, delivery scheduling |
| `risk_agent` | Nova Pro | Risk assessment, disruption analysis, mitigation planning |
| `orchestrator_agent` | Nova Pro | Multi-agent coordination, response synthesis |

## Directory Structure

```
agents/
├── inventory_agent/
│   ├── app.py           # Agent implementation with tools
│   ├── requirements.txt # Python dependencies
│   └── Dockerfile       # Container build instructions
├── demand_agent/
│   └── ...
├── logistics_agent/
│   └── ...
├── risk_agent/
│   └── ...
└── orchestrator_agent/
    └── ...
```

## Agent Architecture

Each agent follows the same pattern:

1. **System Prompt**: Defines the agent's role and behavior
2. **Tools**: Python functions decorated with `@tool` that perform specific tasks
3. **Model**: Amazon Nova model for reasoning
4. **Data Access**: DynamoDB tables for supply chain data

## Tool Implementation

Tools are implemented as Python functions within the agent's `app.py`:

```python
@tool
def check_order_fulfillment_capacity(product_ids: list = None) -> dict:
    """Check if current inventory can fulfill all pending orders."""
    # Implementation...
    return {"canFulfill": True, "shortages": []}
```

**Note**: For simplicity, tools are implemented inline. In production, consider:
- Externalizing to AWS Lambda for scalability
- Integrating with third-party APIs
- Connecting to enterprise systems (SAP, Oracle, etc.)

## Building Agents

Agents are built as Docker containers and deployed to Amazon Bedrock AgentCore:

```bash
# Build is handled by CDK/CodeBuild during deployment
npx cdk deploy SupplySenseAgentCoreStack
```

## Adding a New Agent

1. Create a new directory under `agents/`
2. Copy structure from an existing agent
3. Customize `app.py` with new tools and system prompt
4. Add agent configuration to CDK stack
5. Deploy

See the [Architecture Specification](../.kiro/specs/supplysense-architecture.md) for detailed agent requirements.

