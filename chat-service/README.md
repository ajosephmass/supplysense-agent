# SupplySense Chat Service

The chat service is a Flask application that acts as a passthrough between the UI and Amazon Bedrock AgentCore agents.

## Purpose

- Accept user queries from the UI
- Route queries to the Orchestrator Agent via AgentCore
- Persist actions and approvals to DynamoDB
- Publish notifications to SNS when actions are completed

## Architecture

```
UI → Chat Service (ECS Fargate) → AgentCore Orchestrator → Specialist Agents
         ↓
    DynamoDB (persist actions/approvals)
         ↓
    SNS Topics (publish notifications)
```

## Key Files

- `app.py` - Flask application with API endpoints
- `Dockerfile` - Container build instructions
- `requirements.txt` - Python dependencies

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/chat` | POST | Send query to orchestrator, stream response |
| `/api/actions/<id>/complete` | POST | Mark action complete, publish to SNS |
| `/api/approvals/<id>` | POST | Approve/reject, publish to SNS |
| `/health` | GET | Health check for load balancer |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ORCHESTRATOR_INVOKE_ARN` | SSM parameter path for orchestrator ARN |
| `ACTIONS_TABLE_NAME` | DynamoDB table for actions |
| `APPROVALS_TABLE_NAME` | DynamoDB table for approvals |
| `ACTION_EVENTS_TOPIC_ARN` | SNS topic for action events |
| `APPROVAL_EVENTS_TOPIC_ARN` | SNS topic for approval events |

## Local Development

```bash
cd chat-service
pip install -r requirements.txt
python app.py
```

## Deployment

The chat service is deployed to ECS Fargate via CDK:

```bash
npx cdk deploy SupplySenseChatStack
```

CodeBuild automatically builds the Docker image and deploys to ECS.

## What This Service Does NOT Do

- **No LLM calls**: All AI reasoning happens in AgentCore agents
- **No orchestration logic**: The Orchestrator Agent handles coordination
- **No notification generation**: Agents generate notification content

