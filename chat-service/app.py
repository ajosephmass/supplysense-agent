"""
SupplySense Chat Orchestration Service - Python version
Uses the AgentCore HTTP client pattern for agent invocation
"""

import json
import logging
import os
import re
from datetime import datetime
from decimal import Decimal
from statistics import mean
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4

import boto3
from boto3.dynamodb.conditions import Key

from flask import Flask, Response, jsonify, request, stream_with_context
from flask_cors import CORS

# Import AgentCore starter toolkit
from bedrock_agentcore_starter_toolkit.services.runtime import HttpBedrockAgentCoreClient, generate_session_id

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# Initialize AWS clients
region = os.getenv('AWS_REGION', 'us-east-1')
cloudformation = boto3.client('cloudformation', region_name=region)
ssm = boto3.client('ssm', region_name=region)
dynamodb = boto3.resource('dynamodb', region_name=region)
sns_client = boto3.client('sns', region_name=region)

# Initialize AgentCore HTTP client
http_client = HttpBedrockAgentCoreClient(region)

actions_table_name = os.getenv('ACTIONS_TABLE_NAME', 'supplysense-actions')
approvals_table_name = os.getenv('APPROVALS_TABLE_NAME', 'supplysense-approvals')
action_events_topic_arn = os.getenv('ACTION_EVENTS_TOPIC_ARN')
approval_events_topic_arn = os.getenv('APPROVAL_EVENTS_TOPIC_ARN')

actions_table = dynamodb.Table(actions_table_name) if actions_table_name else None
approvals_table = dynamodb.Table(approvals_table_name) if approvals_table_name else None


def _safe_json_loads(value: str) -> Any:
    try:
        return json.loads(value)
    except Exception:
        return None


def _session_pk(session_id: str) -> str:
    return f'SESSION#{session_id}'


def _action_sk(action_id: str) -> str:
    return f'ACTION#{action_id}'


def _approval_sk(approval_id: str) -> str:
    return f'APPROVAL#{approval_id}'


def _to_dynamo_value(value: Any) -> Any:
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, list):
        return [_to_dynamo_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _to_dynamo_value(val) for key, val in value.items() if val is not None}
    return value


def _to_dynamo_item(item: Dict[str, Any]) -> Dict[str, Any]:
    return {key: _to_dynamo_value(val) for key, val in item.items() if val is not None}


def _from_dynamo_value(value: Any) -> Any:
    if isinstance(value, list):
        return [_from_dynamo_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _from_dynamo_value(val) for key, val in value.items()}
    if isinstance(value, Decimal):
        if value % 1 == 0:
            return int(value)
        return float(value)
    return value


def _publish_event(topic_arn: Optional[str], payload: Dict[str, Any], subject: Optional[str] = None, message_override: Optional[str] = None) -> None:
    """
    Publish event to SNS topic.
    
    Args:
        topic_arn: SNS topic ARN
        payload: Event payload (used as JSON message if message_override not provided)
        subject: Email subject line (for email subscriptions)
        message_override: Override message body (for human-readable emails)
    """
    if not topic_arn:
        logger.debug("SNS topic ARN not configured, skipping publish")
        return
    try:
        # Use message override for human-readable emails, otherwise JSON payload
        message = message_override if message_override else json.dumps(payload, default=str)
        
        publish_params = {
            'TopicArn': topic_arn,
            'Message': message,
        }
        
        # Add subject for email subscriptions
        if subject:
            publish_params['Subject'] = subject[:100]  # SNS subject max 100 chars
        
        # Log the full message being sent to SNS for debugging
        logger.info("=" * 80)
        logger.info("SNS PUBLISH EVENT")
        logger.info(f"Topic ARN: {topic_arn}")
        logger.info(f"Subject: {subject}")
        logger.info(f"Message Length: {len(message)} characters")
        logger.info("Message Content:")
        logger.info(message[:1000] + ("..." if len(message) > 1000 else ""))  # First 1000 chars
        logger.info("=" * 80)
        
        response = sns_client.publish(**publish_params)
        message_id = response.get('MessageId', 'unknown')
        
        logger.info(f"✅ SNS message published successfully - MessageId: {message_id}")
    except Exception as exc:
        logger.error(f"❌ Failed to publish SNS event: {exc}", exc_info=True)


def _publish_action_event(event_type: str, payload: Dict[str, Any]) -> None:
    data = {'eventType': event_type, **payload}
    _publish_event(action_events_topic_arn, data)


def _publish_approval_event(event_type: str, payload: Dict[str, Any]) -> None:
    data = {'eventType': event_type, **payload}
    _publish_event(approval_events_topic_arn, data)


def _format_shortage_lines(shortages: List[Dict[str, Any]]) -> List[str]:
    lines: List[str] = []
    for entry in shortages or []:
        product_id = entry.get('productId') or entry.get('sku')
        shortage = entry.get('shortage') or entry.get('quantityShort') or entry.get('quantity')
        required = entry.get('required')
        available = entry.get('available')
        segment = f"- {product_id}:"
        details: List[str] = []
        if required is not None and available is not None:
            details.append(f"required {required}, available {available}")
        if shortage is not None:
            details.append(f"shortfall {shortage}")
        if details:
            segment += " " + ", ".join(details)
        lines.append(segment)
    return lines


def _compose_action_notification(action_item: Dict[str, Any]) -> Optional[Dict[str, str]]:
    action_id = action_item.get('actionId') or action_item.get('id')
    description = action_item.get('description') or 'Action item'
    # Check if orchestrator already provided a notification draft
    payload = action_item.get('payload') or {}
    if isinstance(payload, dict) and payload.get('notification'):
        return payload['notification']
    
    # Fallback to template-based notifications if orchestrator didn't provide one
    payload = action_item.get('payload') or {}
    shortages = payload.get('data', {}).get('shortages') or payload.get('shortages') or []
    session_id = action_item.get('sessionId', 'unknown session')

    if action_id == 'draft_emergency_po':
        shortage_lines = _format_shortage_lines(shortages)
        body_lines = [
            "Team,",
            "",
            "An emergency purchase order has been drafted for the shortage SKUs identified in the latest SupplySense analysis.",
            "",
            "Shortage summary:",
            *(shortage_lines or ["- No shortage details available."]),
            "",
            f"Session: {session_id}",
            "Next steps:",
            "- Review the draft PO details and confirm supplier availability.",
            "- Share the confirmed PO with finance and receiving teams.",
        ]
        return {
            'subject': 'Emergency PO drafted for shortage SKUs',
            'body': '\n'.join(body_lines),
        }

    if action_id == 'notify_customer_service':
        shortage_lines = _format_shortage_lines(shortages)
        body_lines = [
            "Customer Service Team,",
            "",
            "Please notify affected customers about partial fulfillment and expected delays for the following products:",
            *(shortage_lines or ["- No shortage details available."]),
            "",
            f"Session: {session_id}",
            "Suggested script:",
            "“We are expediting replenishment for the items above and will provide an updated delivery date shortly.”",
        ]
        return {
            'subject': 'Customer notification required: partial fulfillment expected',
            'body': '\n'.join(body_lines),
        }

    # Default notification template - make it more informative
    owner = action_item.get('owner') or payload.get('owner') or 'Operations Team'
    risk_level = action_item.get('riskLevel') or payload.get('riskLevel') or 'Medium'
    action_type = action_item.get('type') or payload.get('type') or 'workflow'
    
    body_lines = [
        f"Dear {owner},",
        "",
        f"The following supply chain action has been marked complete:",
        "",
        f"  Action: {description}",
        f"  Risk Level: {risk_level}",
        f"  Type: {action_type.title()}",
        f"  Session: {session_id}",
        "",
        "This action was executed as part of the SupplySense AI-driven supply chain optimization workflow.",
        "",
        "Next Steps:",
        "- Verify the action has been properly executed in your systems",
        "- Update any dependent processes or downstream teams",
        "- Monitor for any follow-up requirements",
        "",
        "For detailed analysis and recommendations, please review the SupplySense console.",
        "",
        "Best regards,",
        "SupplySense AI Platform",
    ]
    
    return {
        'subject': f"[SupplySense] Action Complete: {description}",
        'body': '\n'.join(body_lines),
    }


def _compose_approval_notification(approval_item: Dict[str, Any]) -> Optional[Dict[str, str]]:
    approval_id = approval_item.get('approvalId') or approval_item.get('id')
    status = (approval_item.get('status') or '').lower()
    session_id = approval_item.get('sessionId', 'unknown session')
    payload = approval_item.get('payload') or {}
    shortages = payload.get('details', {}).get('shortages') or payload.get('shortages') or []

    if approval_id == 'approve_emergency_replenishment':
        shortage_lines = _format_shortage_lines(shortages)
        body_lines = [
            "Procurement & Operations,",
            "",
            f"The emergency replenishment request has been {status} for session {session_id}.",
            "",
            "Shortage summary:",
            *(shortage_lines or ["- No shortage details available."]),
            "",
            "Next steps:",
            "- Confirm supplier quantities and shipping commitments.",
            "- Update ERP with expedited purchase orders.",
            "- Inform logistics and customer service of expected arrival windows.",
        ]
        return {
            'subject': f'Emergency replenishment {status}',
            'body': '\n'.join(body_lines),
        }

    title = approval_item.get('title') or approval_id
    owner = approval_item.get('requires') or payload.get('requires') or 'Approver'
    risk_level = approval_item.get('risk') or payload.get('risk') or 'Medium'
    
    status_verb = 'approved' if status == 'approved' else 'rejected'
    
    body_lines = [
        f"Dear {owner},",
        "",
        f"The following approval request has been {status_verb}:",
        "",
        f"  Request: {title}",
        f"  Risk Level: {risk_level}",
        f"  Decision: {status_verb.upper()}",
        f"  Session: {session_id}",
        "",
        f"This decision was recorded in the SupplySense workflow management system.",
        "",
        "Next Steps:" if status == 'approved' else "Notes:",
        "- Proceed with the approved action items" if status == 'approved' else "- Review the rejection reason and consider alternative approaches",
        "- Coordinate with relevant teams for execution" if status == 'approved' else "- Consult with stakeholders if re-submission is needed",
        "- Monitor progress and report any issues" if status == 'approved' else "- Document lessons learned",
        "",
        "For detailed analysis and recommendations, please review the SupplySense console.",
        "",
        "Best regards,",
        "SupplySense AI Platform",
    ]
    
    return {
        'subject': f"[SupplySense] Approval {status_verb.title()}: {title}",
        'body': '\n'.join(body_lines),
    }

def _normalize_action(action: Dict[str, Any], fallback_risk: Optional[str]) -> Dict[str, Any]:
    normalized = dict(action or {})
    normalized.setdefault('id', str(uuid4()))
    normalized.setdefault('status', 'pending')
    normalized.setdefault('type', 'manual')
    if fallback_risk and not normalized.get('riskLevel'):
        normalized['riskLevel'] = fallback_risk
    return normalized


def _normalize_approval(approval: Dict[str, Any], fallback_risk: Optional[str]) -> Dict[str, Any]:
    normalized = dict(approval or {})
    normalized.setdefault('id', str(uuid4()))
    normalized.setdefault('status', 'pending')
    if fallback_risk and not normalized.get('risk'):
        normalized['risk'] = fallback_risk
    return normalized


def persist_actions_and_approvals(session_id: str, user_id: str, final_response: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Persist actions and approvals to DynamoDB tables and emit SNS events.
    Returns normalized actions and approvals with generated identifiers.
    """
    normalized_actions: List[Dict[str, Any]] = []
    normalized_approvals: List[Dict[str, Any]] = []

    decision = final_response.get('decision') or {}
    fallback_risk = decision.get('riskLevel')
    timestamp = datetime.utcnow().isoformat() + 'Z'
    session_key = _session_pk(session_id)

    for action in final_response.get('actions', []):
        normalized = _normalize_action(action, fallback_risk)
        normalized['sessionId'] = session_id
        action_id = str(normalized['id'])
        normalized_actions.append(normalized)

        if actions_table:
            record = {
                'PK': session_key,
                'SK': _action_sk(action_id),
                'entityType': 'ACTION',
                'sessionId': session_id,
                'actionId': action_id,
                'description': normalized.get('description', 'Action item'),
                'status': normalized.get('status'),
                'type': normalized.get('type'),
                'owner': normalized.get('owner') or normalized.get('requires'),
                'riskLevel': normalized.get('riskLevel'),
                'createdAt': timestamp,
                'updatedAt': timestamp,
                'createdBy': user_id,
                'payload': normalized,
            }
            notification = _compose_action_notification({
                'actionId': action_id,
                'id': action_id,
                'description': normalized.get('description'),
                'payload': normalized,
                'sessionId': session_id,
            })
            if notification:
                record['notificationSubject'] = notification.get('subject')
                record['notificationBody'] = notification.get('body')
                normalized['notification'] = notification
            try:
                actions_table.put_item(Item=_to_dynamo_item(record))
                _publish_action_event('ACTION_RECORDED', _from_dynamo_value(record))
            except Exception as exc:
                logger.warning("Failed to persist action %s: %s", action_id, exc, exc_info=True)

    for approval in final_response.get('approvals', []):
        normalized = _normalize_approval(approval, fallback_risk)
        normalized['sessionId'] = session_id
        approval_id = str(normalized['id'])
        normalized_approvals.append(normalized)

        if approvals_table:
            record = {
                'PK': session_key,
                'SK': _approval_sk(approval_id),
                'entityType': 'APPROVAL',
                'sessionId': session_id,
                'approvalId': approval_id,
                'title': normalized.get('title', 'Approval Required'),
                'status': normalized.get('status'),
                'risk': normalized.get('risk'),
                'requires': normalized.get('requires'),
                'requestedAt': timestamp,
                'requestedBy': user_id,
                'payload': normalized,
            }
            notification = _compose_approval_notification({
                'approvalId': approval_id,
                'id': approval_id,
                'title': normalized.get('title'),
                'status': normalized.get('status'),
                'payload': normalized,
                'sessionId': session_id,
            })
            if notification:
                record['notificationSubject'] = notification.get('subject')
                record['notificationBody'] = notification.get('body')
                normalized['notification'] = notification
            try:
                approvals_table.put_item(Item=_to_dynamo_item(record))
                _publish_approval_event('APPROVAL_REQUESTED', _from_dynamo_value(record))
            except Exception as exc:
                logger.warning("Failed to persist approval %s: %s", approval_id, exc, exc_info=True)

    return normalized_actions, normalized_approvals

def _unwrap_agent_message(raw: Any) -> str:
    """
    Extract a human-readable message from agent responses.
    Handles JSON-wrapped payloads and escaped newline sequences.
    """
    if isinstance(raw, dict):
        candidate = raw.get('message') or raw.get('summary') or raw
        if isinstance(candidate, str):
            return _unwrap_agent_message(candidate)
        return str(candidate)
    if not isinstance(raw, str):
        return str(raw)
    text = raw.strip()
    parsed = _safe_json_loads(text)
    if isinstance(parsed, dict):
        return _unwrap_agent_message(parsed)
    # Replace escaped newlines and strip markdown emphasis markers
    text = text.replace('\\n', '\n')
    text = re.sub(r'\*\*(.*?)\*\*', r'\1', text)
    text = re.sub(r'__([^_]+)__', r'\1', text)
    return text.strip()


def _sanitize_product_id(value: str) -> str:
    return re.sub(r'[\*\s]+$', '', value.strip())


def _structure_inventory_message(message: str) -> Dict[str, Any]:
    clean_text = _unwrap_agent_message(message)
    
    # Try to parse as JSON first to extract structured summaries
    parsed_json = _safe_json_loads(clean_text)
    
    # Initialize data structure
    data: Dict[str, Any] = {
        'status': 'unknown',
        'summary': clean_text,
        'detailedSummary': None,
        'blockers': [],
        'metrics': {},
        'recommendations': [],
    }
    
    # Extract structured fields from JSON if available
    if isinstance(parsed_json, dict):
        # Extract highlight and detailed summaries
        highlight_summary = parsed_json.get('highlightSummary') or parsed_json.get('summary')
        detailed_summary = parsed_json.get('detailedSummary') or parsed_json.get('analysis')
        
        if highlight_summary:
            data['summary'] = highlight_summary
        if detailed_summary:
            data['detailedSummary'] = detailed_summary
        
        # Extract other structured fields
        if 'status' in parsed_json:
            data['status'] = parsed_json['status']
        if 'blockers' in parsed_json and isinstance(parsed_json['blockers'], list):
            data['blockers'] = parsed_json['blockers']
        if 'recommendations' in parsed_json and isinstance(parsed_json['recommendations'], list):
            data['recommendations'] = parsed_json['recommendations']
        if 'metrics' in parsed_json and isinstance(parsed_json['metrics'], dict):
            data['metrics'] = parsed_json['metrics']
        if 'confidence' in parsed_json:
            data['confidence'] = parsed_json['confidence']
        
        # If we have structured data, return early
        if highlight_summary or detailed_summary:
            return data
    
    # Fallback: parse text for legacy format (if JSON parsing failed)
    shortages: List[Dict[str, Any]] = []
    surplus: List[Dict[str, Any]] = []
    legacy_pattern = re.compile(
        r'Product ID:\s*(?P<product>[A-Za-z0-9\-\_]+).*?Required:\s*(?P<required>\d+).*?Available:\s*(?P<available>\d+).*?(Shortage|Surplus):\s*(?P<delta>\d+)',
        re.IGNORECASE | re.DOTALL,
    )
    bullet_patterns = [
        re.compile(
            r'^(?:-|\*)\s*Product ID:\s*(?P<product>[A-Za-z0-9\-\_]+).*?Required\s*(?P<required>\d+).*?available\s*(?P<available>\d+).*?(shortage|surplus)(?:\s+of)?\s*(?P<delta>\d+)',
            re.IGNORECASE,
        ),
        re.compile(
            r'^(?:-|\*)\s*Product ID:\s*(?P<product>[A-Za-z0-9\-\_]+).*?(shortage|surplus)\s*[:\-]?\s*(?P<delta>\d+)',
            re.IGNORECASE,
        ),
    ]

    for match in legacy_pattern.finditer(clean_text):
        product = _sanitize_product_id(match.group('product'))
        required = int(match.group('required'))
        available = int(match.group('available'))
        delta = int(match.group('delta'))
        label = match.group(4).lower()
        if 'shortage' in label:
            shortages.append({'productId': product, 'required': required, 'available': available, 'shortage': delta})
        else:
            surplus.append({'productId': product, 'required': required, 'available': available, 'surplus': delta})

    for line in clean_text.splitlines():
        line = line.strip()
        if not line or line[0] not in {'-', '*'}:
            continue
        for pattern in bullet_patterns:
            bullet_match = pattern.search(line)
            if not bullet_match:
                continue
            product = _sanitize_product_id(bullet_match.group('product'))
            label = bullet_match.group(2).lower() if bullet_match.lastindex and bullet_match.lastindex >= 2 else ''
            required = (
                int(bullet_match.group('required'))
                if 'required' in bullet_match.groupdict() and bullet_match.group('required')
                else None
            )
            available = (
                int(bullet_match.group('available'))
                if 'available' in bullet_match.groupdict() and bullet_match.group('available')
                else None
            )
            delta = int(bullet_match.group('delta'))
            entry = {'productId': product}
            if required is not None:
                entry['required'] = required
            if available is not None:
                entry['available'] = available
            if 'shortage' in label:
                entry['shortage'] = delta
                if not any(s.get('productId') == product for s in shortages):
                    shortages.append(entry)
            else:
                entry['surplus'] = delta
                if not any(s.get('productId') == product for s in surplus):
                    surplus.append(entry)
            break
    if shortages:
        data['status'] = 'shortfall'
        data['blockers'] = [
            f"{item['productId']} shortage ({item.get('shortage', 0)} units)" for item in shortages
        ]
        data['metrics']['shortages'] = shortages
        data['recommendations'].append('Initiate replenishment for shortage SKUs')
    elif 'not possible' in clean_text.lower() or 'cannot fulfill' in clean_text.lower():
        data['status'] = 'shortfall'
        data['blockers'].append('Inventory levels insufficient for all orders')
        data['recommendations'].append('Investigate emergency procurement options')
    elif 'sufficient' in clean_text.lower() or 'can fulfill' in clean_text.lower():
        data['status'] = 'sufficient'
        if surplus:
            data['metrics']['surplus'] = surplus
            data['recommendations'].append('Continue monitoring surplus SKUs for redeployment')
    return data


def _structure_demand_message(message: str) -> Dict[str, Any]:
    clean_text = _unwrap_agent_message(message)
    if clean_text.startswith('{') and clean_text.endswith('}'):
        nested = _safe_json_loads(clean_text)
        if isinstance(nested, dict):
            clean_text = nested.get('message') or ''
    data = {
        'status': 'unknown',
        'summary': clean_text,
        'blockers': [],
        'metrics': {},
        'recommendations': [],
    }
    lower = clean_text.lower()
    if 'need to know' in lower or 'do you have' in lower or 'please provide' in lower:
        data['status'] = 'data_gap'
        data['recommendations'].append('Share latest inventory snapshot with demand analyst')
    elif 'demand' in lower or 'forecast' in lower:
        data['status'] = 'insight'
    return data


def _structure_logistics_message(message: str) -> Dict[str, Any]:
    clean_text = _unwrap_agent_message(message)
    data = {
        'status': 'unknown',
        'summary': clean_text,
        'blockers': [],
        'metrics': {},
        'recommendations': [],
    }
    lower = clean_text.lower()
    if 'confidently fulfill' in lower or 'capacity' in lower and 'constraint' not in lower:
        data['status'] = 'clear'
    elif 'constraint' in lower or 'bottleneck' in lower or 'delay' in lower:
        data['status'] = 'constraint'
        data['recommendations'].append('Review logistics capacity and potential carrier options')
    return data


def _structure_risk_message(message: str) -> Dict[str, Any]:
    clean_text = _unwrap_agent_message(message)
    data = {
        'status': 'unknown',
        'summary': clean_text,
        'blockers': [],
        'metrics': {},
        'recommendations': [],
    }
    lower = clean_text.lower()
    if 'high' in lower:
        data['status'] = 'high'
        data['blockers'].append('Risk profile elevated')
    elif 'medium' in lower:
        data['status'] = 'medium'
    elif 'low' in lower:
        data['status'] = 'low'
    mitigation: List[str] = []
    for line in message.splitlines():
        if line.strip().startswith(('-', '•', '*')):
            mitigation.append(line.strip('-•* ').strip())
    if mitigation:
        data['recommendations'].extend(mitigation)
    return data


def structure_agent_response(agent_type: str, response_text: str) -> Dict[str, Any]:
    if not response_text:
        return {
            'status': 'unknown',
            'summary': 'No response received from agent',
            'blockers': [],
            'metrics': {},
            'recommendations': [],
        }
    if agent_type == 'inventory':
        structured = _structure_inventory_message(response_text)
        structured['raw'] = response_text
        return structured
    if agent_type == 'demand':
        structured = _structure_demand_message(response_text)
        structured['raw'] = response_text
        return structured
    if agent_type == 'logistics':
        structured = _structure_logistics_message(response_text)
        structured['raw'] = response_text
        return structured
    if agent_type == 'risk':
        structured = _structure_risk_message(response_text)
        structured['raw'] = response_text
        return structured
    if agent_type == 'orchestrator':
        parsed = _safe_json_loads(response_text)
        payload: Optional[Dict[str, Any]] = None
        if isinstance(parsed, dict):
            message_field = parsed.get('message')
            if isinstance(message_field, str):
                payload = _safe_json_loads(message_field)
            elif isinstance(message_field, dict):
                payload = message_field
        if not payload and isinstance(parsed, dict):
            payload = parsed
        if payload:
            decision = payload.get('decision') or {}
            return {
                'status': decision.get('status', 'info'),
                'summary': payload.get('summary') or payload.get('narrative') or 'Orchestrator synthesis complete.',
                'blockers': decision.get('blockers', []),
                'metrics': {'confidence': decision.get('confidence')},
                'recommendations': payload.get('nextSteps', []),
                'fusion': payload,
                'narrative': payload.get('narrative'),
                'actions': payload.get('actions', []),
                'approvals': payload.get('approvals', []),
                'raw': response_text,
            }
    return {
        'status': 'info',
        'summary': _unwrap_agent_message(response_text),
        'blockers': [],
        'metrics': {},
        'recommendations': [],
        'raw': response_text,
    }


def get_runtime_endpoint_arns():
    """Get runtime ARNs from SSM (simple approach)."""
    try:
        agent_endpoints = {}
        for agent_type in ['inventory', 'demand', 'logistics', 'risk', 'orchestrator']:
            try:
                # Get the endpoint ARN from SSM and strip /runtime-endpoint/DEFAULT
                endpoint_param = ssm.get_parameter(Name=f'/supplysense/agents/{agent_type}/invoke-arn')
                endpoint_arn = endpoint_param['Parameter']['Value']
                
                # Extract runtime ARN by stripping /runtime-endpoint/DEFAULT
                if '/runtime-endpoint/' in endpoint_arn:
                    runtime_arn = endpoint_arn.split('/runtime-endpoint/')[0]
                else:
                    runtime_arn = endpoint_arn
                
                agent_endpoints[agent_type] = runtime_arn
                logger.info(f"Found {agent_type} runtime ARN: {runtime_arn}")
            except Exception as e:
                logger.warning(f"Could not get {agent_type} endpoint: {e}")
        
        return agent_endpoints
    except Exception as e:
        logger.error(f"Error getting runtime endpoints: {e}")
        return {}


def invoke_agent(agent_type: str, query: Any, session_id: str, runtime_arn: str, bearer_token: str = None) -> Dict[str, Any]:
    """Invoke AgentCore using HTTP client."""
    try:
        logger.info(f"Invoking {agent_type} agent with runtime ARN: {runtime_arn}")
        
        # Use HttpBedrockAgentCoreClient for agent invocation
        if isinstance(query, dict):
            payload = query
        else:
            payload = {"prompt": query}
        
        # Use runtime ARN + endpoint_name for invocation
        # runtime_arn is the base runtime ARN (without /runtime-endpoint/)
        # endpoint_name is "DEFAULT" or "prod"
        result = http_client.invoke_endpoint(
            agent_arn=runtime_arn,
            payload=payload,
            session_id=session_id,
            bearer_token=bearer_token,  # Pass JWT token from user (Cognito ID token)
            endpoint_name='DEFAULT',  # Use DEFAULT endpoint (created by AgentCore)
        )
        
        # Extract response - agents return {"brand": "SupplySense", "message": "..."}
        response_text = result.get('message') or result.get('response') or result.get('completion') or str(result)
        
        logger.info(f"{agent_type} response ({len(response_text)} chars): {response_text[:200]}")
        
        return {
            'agentType': agent_type,
            'response': response_text,
            'confidence': 0.85,
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'structured': structure_agent_response(agent_type, response_text)
        }
    except Exception as e:
        logger.error(f"Error invoking {agent_type} agent: {e}", exc_info=True)
        return {
            'agentType': agent_type,
            'response': f'Error: {str(e)}',
            'confidence': 0,
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'structured': {
                'status': 'error',
                'summary': str(e),
                'blockers': [str(e)],
                'metrics': {},
                'recommendations': [],
            }
        }


@app.route('/health', methods=['GET'])
@app.route('/api/health', methods=['GET'])
def health():
    """Health check endpoint."""
    return {
        'status': 'healthy',
        'service': 'SupplySense Chat Orchestration Service (Python)',
        'timestamp': datetime.utcnow().isoformat() + 'Z'
    }


@app.route('/api/chat', methods=['POST', 'OPTIONS'])
def chat():
    """Main chat endpoint with SSE streaming."""
    if request.method == 'OPTIONS':
        return '', 200
    
    data = request.get_json()
    query = data.get('query')
    session_id = data.get('sessionId', f"session-{datetime.now().timestamp()}")
    user_id = data.get('userId') or 'unknown'
    
    if not query:
        return {'error': 'Query is required'}, 400
    
    # Extract JWT token from Authorization header
    auth_header = request.headers.get('Authorization', '')
    bearer_token = None
    if auth_header.startswith('Bearer '):
        bearer_token = auth_header[7:]
        logger.info(f"Found bearer token: {bearer_token[:20]}...")
    else:
        logger.warning("No bearer token in request - agent invocation will fail!")
    
    def generate():
        try:
            status_data = {'type': 'status', 'message': 'Routing to orchestrator...', 'timestamp': datetime.utcnow().isoformat() + 'Z'}
            yield f"data: {json.dumps(status_data)}\n\n"

            agent_arns = get_runtime_endpoint_arns()
            orchestrator_arn = agent_arns.get('orchestrator')
            if not orchestrator_arn:
                raise RuntimeError('Orchestrator runtime ARN not found')

            orchestrator_payload: Dict[str, Any] = {
                'prompt': json.dumps({
                    'mode': 'orchestrator_conversation',
                    'query': query,
                    'sessionId': session_id,
                    'userId': user_id,
                    'bearerToken': bearer_token,
                })
            }

            import threading
            import queue
            import time

            result_queue: "queue.Queue[tuple[str, Any]]" = queue.Queue()

            def run_orchestrator():
                try:
                    result = invoke_agent('orchestrator', orchestrator_payload, session_id, orchestrator_arn, bearer_token)
                    result_queue.put(('result', result))
                except Exception as exc:
                    result_queue.put(('error', exc))

            worker = threading.Thread(target=run_orchestrator, daemon=True)
            worker.start()

            orchestrator_result = None
            progress_messages = [
                'Analyzing inventory signals...',
                'Reviewing order backlog...',
                'Assessing demand trends...',
                'Evaluating logistics capacity...',
                'Checking supplier reliability...',
                'Quantifying overall risk...',
                'Reconciling agent findings...',
                'Drafting recommended actions...',
                'Preparing executive briefing...',
                'Finalizing multi-agent response...'
            ]
            progress_index = 0
            while True:
                try:
                    message_type, payload_value = result_queue.get(timeout=8)
                except queue.Empty:
                    heartbeat_message = progress_messages[progress_index % len(progress_messages)]
                    progress_index += 1
                    heartbeat = {
                        'type': 'status',
                        'message': heartbeat_message,
                        'timestamp': datetime.utcnow().isoformat() + 'Z'
                    }
                    yield f"data: {json.dumps(heartbeat)}\n\n"
                    continue

                if message_type == 'result':
                    orchestrator_result = payload_value
                    break
                if message_type == 'error':
                    raise payload_value

            structured_response = orchestrator_result.get('structured') or {}
            events = []
            if isinstance(structured_response, dict):
                events = structured_response.get('events') or []
            for event in events:
                try:
                    event_payload = dict(event)
                    event_payload.setdefault('timestamp', datetime.utcnow().isoformat() + 'Z')
                    yield f"data: {json.dumps(event_payload)}\n\n"
                except Exception as exc:
                    logger.warning("Failed to stream orchestrator event: %s", exc)

            if isinstance(structured_response, dict):
                fusion_result = structured_response.get('fusion') or structured_response
            else:
                fusion_result = structured_response

            actions = fusion_result.get('actions') if isinstance(fusion_result, dict) else []
            approvals = fusion_result.get('approvals') if isinstance(fusion_result, dict) else []
            decision = fusion_result.get('decision') if isinstance(fusion_result, dict) else {}
            narrative = fusion_result.get('narrative') if isinstance(fusion_result, dict) else None
            final_payload = {
                'query': query,
                'queryType': fusion_result.get('queryType') if isinstance(fusion_result, dict) else structured_response.get('queryType'),
                'fusion': fusion_result,
                'actions': actions,
                'approvals': approvals,
                'decision': decision,
                'narrative': narrative,
                'timestamp': datetime.utcnow().isoformat() + 'Z',
                'sessionId': session_id,
                'events': events,
            }

            try:
                normalized_actions, normalized_approvals = persist_actions_and_approvals(
                    session_id=session_id,
                    user_id=user_id,
                    final_response=final_payload
                )
                final_payload['actions'] = normalized_actions
                final_payload['approvals'] = normalized_approvals
            except Exception as exc:
                logger.warning("Failed to persist actions/approvals: %s", exc, exc_info=True)

            final_data = {'type': 'final_response', 'response': final_payload, 'timestamp': datetime.utcnow().isoformat() + 'Z'}
            yield f"data: {json.dumps(final_data)}\n\n"

            complete_data = {'type': 'complete', 'message': 'Analysis complete', 'timestamp': datetime.utcnow().isoformat() + 'Z'}
            yield f"data: {json.dumps(complete_data)}\n\n"

        except Exception as e:
            logger.error(f"Error in chat: {e}", exc_info=True)
            error_data = {'type': 'error', 'error': str(e), 'timestamp': datetime.utcnow().isoformat() + 'Z'}
            yield f"data: {json.dumps(error_data)}\n\n"
    
    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no'
        }
    )


@app.route('/api/actions', methods=['GET', 'OPTIONS'])
def list_actions():
    if request.method == 'OPTIONS':
        return '', 200
    if not actions_table:
        return jsonify({'items': []})
    session_id = request.args.get('sessionId')
    if not session_id:
        return {'error': 'sessionId is required'}, 400
    try:
        response = actions_table.query(
            KeyConditionExpression=Key('PK').eq(_session_pk(session_id))
        )
        items = [_from_dynamo_value(item) for item in response.get('Items', [])]
        items.sort(key=lambda value: value.get('createdAt', ''))
        return jsonify({'items': items})
    except Exception as exc:
        logger.error("Failed to fetch actions: %s", exc, exc_info=True)
        return {'error': 'Failed to fetch actions'}, 500


@app.route('/api/approvals', methods=['GET', 'OPTIONS'])
def list_approvals():
    if request.method == 'OPTIONS':
        return '', 200
    if not approvals_table:
        return jsonify({'items': []})
    session_id = request.args.get('sessionId')
    if not session_id:
        return {'error': 'sessionId is required'}, 400
    try:
        response = approvals_table.query(
            KeyConditionExpression=Key('PK').eq(_session_pk(session_id))
        )
        items = [_from_dynamo_value(item) for item in response.get('Items', [])]
        items.sort(key=lambda value: value.get('requestedAt', ''))
        return jsonify({'items': items})
    except Exception as exc:
        logger.error("Failed to fetch approvals: %s", exc, exc_info=True)
        return {'error': 'Failed to fetch approvals'}, 500


@app.route('/api/actions/<action_id>/complete', methods=['POST', 'OPTIONS'])
def complete_action(action_id: str):
    if request.method == 'OPTIONS':
        return '', 200
    if not actions_table:
        return {'error': 'Actions table not configured'}, 500
    data = request.get_json() or {}
    session_id = data.get('sessionId')
    if not session_id:
        return {'error': 'sessionId is required'}, 400
    user_id = data.get('userId') or 'unknown'
    comments = data.get('comments')
    timestamp = datetime.utcnow().isoformat() + 'Z'

    update_expression = 'SET #status = :status, updatedAt = :updatedAt, completedAt = :completedAt, completedBy = :completedBy'
    expression_names = {'#status': 'status'}
    expression_values = {
        ':status': 'completed',
        ':updatedAt': timestamp,
        ':completedAt': timestamp,
        ':completedBy': user_id,
    }
    if comments:
        update_expression += ', lastComment = :lastComment'
        expression_values[':lastComment'] = comments

    try:
        result = actions_table.update_item(
            Key={'PK': _session_pk(session_id), 'SK': _action_sk(action_id)},
            UpdateExpression=update_expression,
            ExpressionAttributeNames=expression_names,
            ExpressionAttributeValues=_to_dynamo_item(expression_values),
            ConditionExpression='attribute_exists(PK)',
            ReturnValues='ALL_NEW',
        )
        attributes = result.get('Attributes')
        if not attributes:
            return {'error': 'Action not found'}, 404
        action_item = _from_dynamo_value(attributes)

        notification = _compose_action_notification(action_item)
        if notification:
            action_item['notification'] = notification
            log_entry = {
                'timestamp': timestamp,
                'event': 'ACTION_COMPLETED',
                'message': notification['body'],
                'actor': user_id,
            }
            try:
                actions_table.update_item(
                    Key={'PK': _session_pk(session_id), 'SK': _action_sk(action_id)},
                    UpdateExpression=(
                        'SET notificationSubject = :subject, notificationBody = :body, '
                        'workflowLog = list_append(if_not_exists(workflowLog, :emptyList), :logEntry)'
                    ),
                    ExpressionAttributeValues=_to_dynamo_item({
                        ':subject': notification['subject'],
                        ':body': notification['body'],
                        ':emptyList': [],
                        ':logEntry': [log_entry],
                    }),
                )
            except Exception as exc:
                logger.warning("Failed to persist action notification for %s: %s", action_id, exc, exc_info=True)
        else:
            try:
                actions_table.update_item(
                    Key={'PK': _session_pk(session_id), 'SK': _action_sk(action_id)},
                    UpdateExpression=(
                        'SET workflowLog = list_append(if_not_exists(workflowLog, :emptyList), :logEntry)'
                    ),
                    ExpressionAttributeValues=_to_dynamo_item({
                        ':emptyList': [],
                        ':logEntry': [{
                            'timestamp': timestamp,
                            'event': 'ACTION_COMPLETED',
                            'message': f"Action '{action_item.get('description')}' completed.",
                            'actor': user_id,
                        }],
                    }),
                )
            except Exception as exc:
                logger.warning("Failed to append action workflow log for %s: %s", action_id, exc, exc_info=True)

        # Publish SNS event with notification if available
        if notification:
            # Send human-readable email with subject
            _publish_event(
                action_events_topic_arn,
                payload={'eventType': 'ACTION_COMPLETED', **action_item},
                subject=notification.get('subject', 'Action Completed'),
                message_override=notification.get('body')
            )
        else:
            # Fallback to JSON payload
            _publish_action_event('ACTION_COMPLETED', action_item)
        
        return {'success': True, 'action': action_item}
    except actions_table.meta.client.exceptions.ConditionalCheckFailedException:  # type: ignore[attr-defined]
        return {'error': 'Action not found'}, 404
    except Exception as exc:
        logger.error("Failed to complete action %s: %s", action_id, exc, exc_info=True)
        return {'error': 'Failed to update action'}, 500


@app.route('/api/approvals/<approval_id>', methods=['POST', 'OPTIONS'])
def decide_approval(approval_id: str):
    if request.method == 'OPTIONS':
        return '', 200
    if not approvals_table:
        return {'error': 'Approvals table not configured'}, 500
    data = request.get_json() or {}
    session_id = data.get('sessionId')
    if not session_id:
        return {'error': 'sessionId is required'}, 400
    decision = (data.get('decision') or '').strip().lower()
    if decision not in {'approve', 'approved', 'reject', 'rejected'}:
        return {'error': 'decision must be approve or reject'}, 400
    status = 'approved' if decision.startswith('approve') else 'rejected'
    user_id = data.get('approver') or data.get('userId') or 'unknown'
    comments = data.get('comments')
    timestamp = datetime.utcnow().isoformat() + 'Z'

    update_expression = 'SET #status = :status, updatedAt = :updatedAt, decisionAt = :decisionAt, decidedBy = :decidedBy'
    expression_names = {'#status': 'status'}
    expression_values = {
        ':status': status,
        ':updatedAt': timestamp,
        ':decisionAt': timestamp,
        ':decidedBy': user_id,
    }
    if comments:
        update_expression += ', lastComment = :lastComment'
        expression_values[':lastComment'] = comments

    try:
        result = approvals_table.update_item(
            Key={'PK': _session_pk(session_id), 'SK': _approval_sk(approval_id)},
            UpdateExpression=update_expression,
            ExpressionAttributeNames=expression_names,
            ExpressionAttributeValues=_to_dynamo_item(expression_values),
            ConditionExpression='attribute_exists(PK)',
            ReturnValues='ALL_NEW',
        )
        attributes = result.get('Attributes')
        if not attributes:
            return {'error': 'Approval not found'}, 404
        approval_item = _from_dynamo_value(attributes)
        approval_item['decision'] = status
        notification = _compose_approval_notification(approval_item)
        if notification:
            approval_item['notification'] = notification
            log_entry = {
                'timestamp': timestamp,
                'event': f'APPROVAL_{status.upper()}',
                'message': notification['body'],
                'actor': user_id,
            }
            try:
                approvals_table.update_item(
                    Key={'PK': _session_pk(session_id), 'SK': _approval_sk(approval_id)},
                    UpdateExpression=(
                        'SET notificationSubject = :subject, notificationBody = :body, '
                        'workflowLog = list_append(if_not_exists(workflowLog, :emptyList), :logEntry)'
                    ),
                    ExpressionAttributeValues=_to_dynamo_item({
                        ':subject': notification['subject'],
                        ':body': notification['body'],
                        ':emptyList': [],
                        ':logEntry': [log_entry],
                    }),
                )
            except Exception as exc:
                logger.warning("Failed to persist approval notification for %s: %s", approval_id, exc, exc_info=True)
        else:
            try:
                approvals_table.update_item(
                    Key={'PK': _session_pk(session_id), 'SK': _approval_sk(approval_id)},
                    UpdateExpression=(
                        'SET workflowLog = list_append(if_not_exists(workflowLog, :emptyList), :logEntry)'
                    ),
                    ExpressionAttributeValues=_to_dynamo_item({
                        ':emptyList': [],
                        ':logEntry': [{
                            'timestamp': timestamp,
                            'event': f'APPROVAL_{status.upper()}',
                            'message': f"Approval '{approval_item.get('title')}' marked {status}.",
                            'actor': user_id,
                        }],
                    }),
                )
            except Exception as exc:
                logger.warning("Failed to append approval workflow log for %s: %s", approval_id, exc, exc_info=True)

        # Publish SNS event with notification if available
        if notification:
            # Send human-readable email with subject
            _publish_event(
                approval_events_topic_arn,
                payload={'eventType': 'APPROVAL_DECIDED', **approval_item},
                subject=notification.get('subject', f'Approval {status.title()}'),
                message_override=notification.get('body')
            )
        else:
            # Fallback to JSON payload
            _publish_approval_event('APPROVAL_DECIDED', approval_item)
        
        return {'success': True, 'approval': approval_item}
    except approvals_table.meta.client.exceptions.ConditionalCheckFailedException:  # type: ignore[attr-defined]
        return {'error': 'Approval not found'}, 404
    except Exception as exc:
        logger.error("Failed to update approval %s: %s", approval_id, exc, exc_info=True)
        return {'error': 'Failed to update approval'}, 500


if __name__ == '__main__':
    port = int(os.getenv('PORT', 3000))
    app.run(host='0.0.0.0', port=port, debug=False)

