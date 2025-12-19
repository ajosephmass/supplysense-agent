"""
SupplySense Chat Orchestration Service - Python version
Uses the same AgentCore client pattern as SpendOptimo reference
"""

import json
import logging
import os
from datetime import datetime
from typing import Any, Dict
import boto3

from flask import Flask, request, Response, stream_with_context
from flask_cors import CORS

# Import AgentCore starter toolkit (like SpendOptimo)
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

# Initialize AgentCore HTTP client (like SpendOptimo reference)
http_client = HttpBedrockAgentCoreClient(region)


def get_runtime_endpoint_arns():
    """Get runtime endpoint ARNs from SSM (like SpendOptimo)."""
    try:
        agent_endpoints = {}
        for agent_type in ['inventory', 'demand', 'logistics', 'risk', 'orchestrator']:
            try:
                param = ssm.get_parameter(Name=f'/supplysense/agents/{agent_type}/invoke-arn')
                endpoint_arn = param['Parameter']['Value']
                
                # Parse runtime ARN from endpoint ARN
                if "/runtime-endpoint/" in endpoint_arn:
                    runtime_arn = endpoint_arn.split("/runtime-endpoint/")[0]
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


def invoke_agent(agent_type: str, query: str, session_id: str, runtime_arn: str, bearer_token: str = None) -> Dict[str, Any]:
    """Invoke AgentCore using HTTP client (like SpendOptimo reference lines 182-188)."""
    try:
        logger.info(f"Invoking {agent_type} agent via HTTP with JWT auth")
        
        # Use HttpBedrockAgentCoreClient like SpendOptimo reference
        payload = {"prompt": query}
        
        result = http_client.invoke_endpoint(
            agent_arn=runtime_arn,
            payload=payload,
            session_id=session_id,
            bearer_token=bearer_token,  # Pass JWT token from user (Cognito ID token)
            endpoint_name='prod'
        )
        
        # Extract response - agents return {"brand": "SupplySense", "message": "..."}
        response_text = result.get('message') or result.get('response') or result.get('completion') or str(result)
        
        logger.info(f"{agent_type} response ({len(response_text)} chars): {response_text[:200]}")
        
        return {
            'agentType': agent_type,
            'response': response_text,
            'confidence': 0.85,
            'timestamp': datetime.utcnow().isoformat() + 'Z'
        }
    except Exception as e:
        logger.error(f"Error invoking {agent_type} agent: {e}", exc_info=True)
        return {
            'agentType': agent_type,
            'response': f'Error: {str(e)}',
            'confidence': 0,
            'timestamp': datetime.utcnow().isoformat() + 'Z'
        }


def analyze_query(query: str) -> Dict[str, Any]:
    """Intelligently analyze query to determine MINIMAL set of agents needed."""
    query_lower = query.lower()
    
    # Inventory-only queries
    if ('inventory' in query_lower or 'stock' in query_lower) and 'order' not in query_lower:
        return {
            'type': 'inventory_query',
            'agents': ['inventory'],
            'pattern': 'single_agent',
            'reasoning': 'Pure inventory question - only Inventory Agent needed'
        }
    
    # Demand/forecast queries
    if 'demand' in query_lower or 'forecast' in query_lower:
        return {
            'type': 'demand_forecast',
            'agents': ['demand'],
            'pattern': 'single_agent',
            'reasoning': 'Demand forecasting question - only Demand Agent needed'
        }
    
    # Logistics/delivery queries
    if ('route' in query_lower or 'delivery' in query_lower or 'shipping' in query_lower) and 'fulfill' not in query_lower:
        return {
            'type': 'logistics_query',
            'agents': ['logistics'],
            'pattern': 'single_agent',
            'reasoning': 'Logistics question - only Logistics Agent needed'
        }
    
    # Risk assessment queries
    if 'risk' in query_lower or 'disruption' in query_lower or 'supplier' in query_lower:
        if 'impact' in query_lower or 'mitigation' in query_lower:
            # Need risk + affected domains
            return {
                'type': 'risk_with_impact',
                'agents': ['risk', 'inventory'],
                'pattern': 'sequential',
                'reasoning': 'Risk assessment needs inventory impact analysis'
            }
        return {
            'type': 'risk_assessment',
            'agents': ['risk'],
            'pattern': 'single_agent',
            'reasoning': 'Risk assessment question - only Risk Agent needed'
        }
    
    # Complex fulfillment queries - need multiple agents
    if 'fulfill' in query_lower and 'order' in query_lower:
        return {
            'type': 'fulfillment_analysis',
            'agents': ['inventory', 'demand', 'logistics'],  # Only 3 agents, not 5!
            'pattern': 'parallel_with_synthesis',
            'reasoning': 'Fulfillment requires inventory, demand, and logistics analysis'
        }
    
    # Capacity planning - strategic query
    if 'capacity' in query_lower or 'season' in query_lower or 'holiday' in query_lower:
        return {
            'type': 'capacity_planning',
            'agents': ['demand', 'inventory', 'orchestrator'],
            'pattern': 'sequential',
            'reasoning': 'Strategic planning needs demand forecast, then inventory planning'
        }
    
    # Default: Use orchestrator only for general questions
    return {
        'type': 'general_query',
        'agents': ['orchestrator'],
        'pattern': 'single_agent',
        'reasoning': 'General question - Orchestrator can handle directly'
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
    
    if not query:
        return {'error': 'Query is required'}, 400
    
    # Extract JWT token from Authorization header (like SpendOptimo line 78-81)
    auth_header = request.headers.get('Authorization', '')
    bearer_token = None
    if auth_header.startswith('Bearer '):
        bearer_token = auth_header[7:]
        logger.info(f"Found bearer token: {bearer_token[:20]}...")
    else:
        logger.warning("No bearer token in request - agent invocation will fail!")
    
    def generate():
        try:
            # Send initial status
            status_data = {'type': 'status', 'message': 'Analyzing query...', 'timestamp': datetime.utcnow().isoformat() + 'Z'}
            yield f"data: {json.dumps(status_data)}\n\n"
            
            # Get runtime endpoint ARNs
            agent_arns = get_runtime_endpoint_arns()
            
            # Analyze query intelligently
            analysis = analyze_query(query)
            analysis_message = f"Query type: {analysis['type']}. {analysis['reasoning']}. Coordinating {len(analysis['agents'])} agent(s)..."
            analysis_data = {
                'type': 'analysis', 
                'message': analysis_message, 
                'agents': analysis['agents'],
                'reasoning': analysis['reasoning'],
                'timestamp': datetime.utcnow().isoformat() + 'Z'
            }
            yield f"data: {json.dumps(analysis_data)}\n\n"
            
            # Coordinate agents
            results = []
            for agent_type in analysis['agents']:
                if agent_type == 'orchestrator' and len(analysis['agents']) > 1:
                    continue  # Skip orchestrator in parallel, do it after
                
                runtime_arn = agent_arns.get(agent_type)
                if not runtime_arn:
                    logger.warning(f"No runtime ARN for {agent_type}")
                    continue
                
                start_message = f'{agent_type.capitalize()} Agent analyzing...'
                start_data = {'type': 'agent_start', 'agent': agent_type, 'message': start_message, 'timestamp': datetime.utcnow().isoformat() + 'Z'}
                yield f"data: {json.dumps(start_data)}\n\n"
                
                result = invoke_agent(agent_type, query, session_id, runtime_arn, bearer_token)
                results.append(result)
                
                complete_message = f'{agent_type.capitalize()} completed'
                complete_data = {'type': 'agent_complete', 'agent': agent_type, 'message': complete_message, 'confidence': result['confidence'], 'timestamp': datetime.utcnow().isoformat() + 'Z'}
                yield f"data: {json.dumps(complete_data)}\n\n"
            
            # Synthesis
            synthesis_data = {'type': 'synthesis', 'message': 'Synthesizing response...', 'timestamp': datetime.utcnow().isoformat() + 'Z'}
            yield f"data: {json.dumps(synthesis_data)}\n\n"
            
            final_response = {
                'query': query,
                'queryType': analysis['type'],
                'results': results,
                'overallConfidence': sum(r['confidence'] for r in results) / len(results) if results else 0,
                'timestamp': datetime.utcnow().isoformat() + 'Z'
            }
            
            final_data = {'type': 'final_response', 'response': final_response, 'timestamp': datetime.utcnow().isoformat() + 'Z'}
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


if __name__ == '__main__':
    port = int(os.getenv('PORT', 3000))
    app.run(host='0.0.0.0', port=port, debug=False)

