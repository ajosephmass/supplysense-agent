"""
SupplySense AgentCore Custom Resource Provisioner

This Lambda function handles the setup and configuration of AgentCore runtimes
for the SupplySense multi-agent system.
"""

import json
import boto3
import logging
import time
from typing import Dict, Any, List
import urllib3

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS clients
bedrock_agent = boto3.client('bedrock-agent')
ssm = boto3.client('ssm')
http = urllib3.PoolManager()

def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Main Lambda handler for AgentCore provisioning
    """
    try:
        logger.info(f"Received event: {json.dumps(event)}")
        
        request_type = event['RequestType']
        resource_properties = event['ResourceProperties']
        
        if request_type == 'Create':
            return handle_create(event, context, resource_properties)
        elif request_type == 'Update':
            return handle_update(event, context, resource_properties)
        elif request_type == 'Delete':
            return handle_delete(event, context, resource_properties)
        else:
            raise ValueError(f"Unknown request type: {request_type}")
            
    except Exception as e:
        logger.error(f"Error in lambda_handler: {str(e)}")
        send_response(event, context, 'FAILED', {}, str(e))
        return {'statusCode': 500, 'body': str(e)}

def handle_create(event: Dict[str, Any], context: Any, properties: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle CREATE requests - provision AgentCore runtimes
    """
    try:
        logger.info("Starting AgentCore provisioning...")
        
        # Get agent configurations from properties
        agent_configs = properties.get('AgentConfigurations', [])
        provisioned_agents = {}
        
        for agent_config in agent_configs:
            agent_id = provision_agent(agent_config)
            provisioned_agents[agent_config['name']] = agent_id
            
            # Store agent ID in SSM for runtime access
            store_agent_id_in_ssm(agent_config['name'], agent_id)
            
            # Prepare the agent for use
            prepare_agent(agent_id)
            
        # Wait for all agents to be ready
        wait_for_agents_ready(list(provisioned_agents.values()))
        
        response_data = {
            'AgentIds': provisioned_agents,
            'Status': 'SUCCESS',
            'Message': f'Successfully provisioned {len(provisioned_agents)} agents'
        }
        
        send_response(event, context, 'SUCCESS', response_data)
        return {'statusCode': 200, 'body': json.dumps(response_data)}
        
    except Exception as e:
        logger.error(f"Error in handle_create: {str(e)}")
        send_response(event, context, 'FAILED', {}, str(e))
        raise

def handle_update(event: Dict[str, Any], context: Any, properties: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle UPDATE requests - update agent configurations
    """
    try:
        logger.info("Updating AgentCore configurations...")
        
        # For now, updates are handled by recreating agents
        # In production, you might want more sophisticated update logic
        return handle_create(event, context, properties)
        
    except Exception as e:
        logger.error(f"Error in handle_update: {str(e)}")
        send_response(event, context, 'FAILED', {}, str(e))
        raise

def handle_delete(event: Dict[str, Any], context: Any, properties: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle DELETE requests - cleanup AgentCore resources
    """
    try:
        logger.info("Cleaning up AgentCore resources...")
        
        # Get agent IDs from SSM
        agent_ids = get_agent_ids_from_ssm()
        
        # Delete agents
        for agent_name, agent_id in agent_ids.items():
            try:
                delete_agent(agent_id)
                delete_agent_id_from_ssm(agent_name)
                logger.info(f"Deleted agent {agent_name} ({agent_id})")
            except Exception as e:
                logger.warning(f"Error deleting agent {agent_name}: {str(e)}")
        
        response_data = {
            'Status': 'SUCCESS',
            'Message': f'Successfully cleaned up {len(agent_ids)} agents'
        }
        
        send_response(event, context, 'SUCCESS', response_data)
        return {'statusCode': 200, 'body': json.dumps(response_data)}
        
    except Exception as e:
        logger.error(f"Error in handle_delete: {str(e)}")
        send_response(event, context, 'FAILED', {}, str(e))
        raise

def provision_agent(agent_config: Dict[str, Any]) -> str:
    """
    Provision a single AgentCore runtime
    """
    try:
        logger.info(f"Provisioning agent: {agent_config['name']}")
        
        # Create agent
        create_params = {
            'agentName': agent_config['name'],
            'description': agent_config.get('description', ''),
            'foundationModel': agent_config['modelId'],
            'instruction': agent_config.get('systemPrompt', ''),
            'agentResourceRoleArn': agent_config['roleArn']
        }
        
        if 'idleSessionTTLInSeconds' in agent_config:
            create_params['idleSessionTTLInSeconds'] = agent_config['idleSessionTTLInSeconds']
            
        response = bedrock_agent.create_agent(**create_params)
        agent_id = response['agent']['agentId']
        
        logger.info(f"Created agent {agent_config['name']} with ID: {agent_id}")
        
        # Add action groups (tools) if specified
        if 'tools' in agent_config:
            add_action_groups(agent_id, agent_config['tools'])
        
        return agent_id
        
    except Exception as e:
        logger.error(f"Error provisioning agent {agent_config['name']}: {str(e)}")
        raise

def add_action_groups(agent_id: str, tools: List[Dict[str, Any]]) -> None:
    """
    Add action groups (tools) to an agent
    """
    try:
        for tool in tools:
            action_group_params = {
                'agentId': agent_id,
                'agentVersion': 'DRAFT',
                'actionGroupName': tool['name'],
                'description': tool.get('description', ''),
                'actionGroupExecutor': {
                    'lambda': tool['lambdaArn']
                } if 'lambdaArn' in tool else {
                    'customControl': 'RETURN_CONTROL'
                }
            }
            
            if 'apiSchema' in tool:
                action_group_params['apiSchema'] = {
                    'payload': tool['apiSchema']
                }
            
            bedrock_agent.create_agent_action_group(**action_group_params)
            logger.info(f"Added action group {tool['name']} to agent {agent_id}")
            
    except Exception as e:
        logger.error(f"Error adding action groups to agent {agent_id}: {str(e)}")
        raise

def prepare_agent(agent_id: str) -> None:
    """
    Prepare an agent for use
    """
    try:
        logger.info(f"Preparing agent {agent_id}...")
        
        bedrock_agent.prepare_agent(agentId=agent_id)
        logger.info(f"Agent {agent_id} preparation initiated")
        
    except Exception as e:
        logger.error(f"Error preparing agent {agent_id}: {str(e)}")
        raise

def wait_for_agents_ready(agent_ids: List[str], max_wait_time: int = 300) -> None:
    """
    Wait for all agents to be in PREPARED state
    """
    start_time = time.time()
    
    while time.time() - start_time < max_wait_time:
        all_ready = True
        
        for agent_id in agent_ids:
            try:
                response = bedrock_agent.get_agent(agentId=agent_id)
                status = response['agent']['agentStatus']
                
                if status != 'PREPARED':
                    all_ready = False
                    logger.info(f"Agent {agent_id} status: {status}")
                    break
                    
            except Exception as e:
                logger.warning(f"Error checking agent {agent_id} status: {str(e)}")
                all_ready = False
                break
        
        if all_ready:
            logger.info("All agents are ready!")
            return
            
        time.sleep(10)  # Wait 10 seconds before checking again
    
    raise TimeoutError(f"Agents not ready after {max_wait_time} seconds")

def delete_agent(agent_id: str) -> None:
    """
    Delete an agent
    """
    try:
        bedrock_agent.delete_agent(
            agentId=agent_id,
            skipResourceInUseCheck=True
        )
        logger.info(f"Deleted agent {agent_id}")
        
    except Exception as e:
        logger.error(f"Error deleting agent {agent_id}: {str(e)}")
        raise

def store_agent_id_in_ssm(agent_name: str, agent_id: str) -> None:
    """
    Store agent ID in SSM Parameter Store
    """
    try:
        parameter_name = f"/supplysense/agents/{agent_name}/runtime-id"
        
        ssm.put_parameter(
            Name=parameter_name,
            Value=agent_id,
            Type='String',
            Overwrite=True,
            Description=f'AgentCore runtime ID for {agent_name} agent'
        )
        
        logger.info(f"Stored agent ID {agent_id} in SSM parameter {parameter_name}")
        
    except Exception as e:
        logger.error(f"Error storing agent ID in SSM: {str(e)}")
        raise

def get_agent_ids_from_ssm() -> Dict[str, str]:
    """
    Get all agent IDs from SSM Parameter Store
    """
    try:
        response = ssm.get_parameters_by_path(
            Path='/supplysense/agents/',
            Recursive=True
        )
        
        agent_ids = {}
        for param in response['Parameters']:
            path_parts = param['Name'].split('/')
            if len(path_parts) >= 4 and path_parts[4] == 'runtime-id':
                agent_name = path_parts[3]
                agent_ids[agent_name] = param['Value']
        
        return agent_ids
        
    except Exception as e:
        logger.error(f"Error getting agent IDs from SSM: {str(e)}")
        return {}

def delete_agent_id_from_ssm(agent_name: str) -> None:
    """
    Delete agent ID from SSM Parameter Store
    """
    try:
        parameter_name = f"/supplysense/agents/{agent_name}/runtime-id"
        ssm.delete_parameter(Name=parameter_name)
        logger.info(f"Deleted SSM parameter {parameter_name}")
        
    except Exception as e:
        logger.warning(f"Error deleting SSM parameter: {str(e)}")

def send_response(event: Dict[str, Any], context: Any, response_status: str, 
                 response_data: Dict[str, Any], reason: str = None) -> None:
    """
    Send response to CloudFormation
    """
    response_url = event['ResponseURL']
    
    response_body = {
        'Status': response_status,
        'Reason': reason or f'See CloudWatch Log Stream: {context.log_stream_name}',
        'PhysicalResourceId': context.log_stream_name,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': response_data
    }
    
    json_response_body = json.dumps(response_body)
    
    headers = {
        'content-type': '',
        'content-length': str(len(json_response_body))
    }
    
    try:
        response = http.request('PUT', response_url, body=json_response_body, headers=headers)
        logger.info(f"CloudFormation response sent: {response.status}")
    except Exception as e:
        logger.error(f"Error sending response to CloudFormation: {str(e)}")