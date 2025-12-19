from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List
from datetime import datetime

from bedrock_agentcore import BedrockAgentCoreApp, RequestContext
from strands import Agent, tool
from strands.models import BedrockModel
import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

app = BedrockAgentCoreApp()

# Initialize AWS clients
dynamodb = boto3.resource('dynamodb', region_name=os.environ.get('AWS_REGION', 'us-east-1'))
ssm = boto3.client('ssm', region_name=os.environ.get('AWS_REGION', 'us-east-1'))

@tool
def orchestrate_fulfillment(timeframe: str = "weekly", order_ids: List[str] = None, constraints: Dict = None) -> str:
    """Orchestrate multi-agent analysis to determine fulfillment capability for orders."""
    try:
        logger.info(f"Starting fulfillment orchestration for timeframe: {timeframe}")
        
        # Step 1: Get order data
        orders_table = dynamodb.Table('supplysense-orders')
        
        if order_ids:
            # Get specific orders
            orders = []
            for order_id in order_ids:
                response = orders_table.get_item(Key={'orderId': order_id})
                if 'Item' in response:
                    orders.append(response['Item'])
        else:
            # Get all pending orders
            response = orders_table.scan(
                FilterExpression='#status = :status',
                ExpressionAttributeNames={'#status': 'status'},
                ExpressionAttributeValues={':status': 'pending'}
            )
            orders = response.get('Items', [])
        
        if not orders:
            return json.dumps({
                "fulfillmentCapable": True,
                "reason": "No orders found for fulfillment analysis",
                "orderCount": 0,
                "timeframe": timeframe
            })
        
        # Step 2: Analyze inventory capability (simulate calling Inventory Agent)
        inventory_analysis = simulate_inventory_agent_call(orders)
        
        # Step 3: Analyze demand patterns (simulate calling Demand Agent)
        demand_analysis = simulate_demand_agent_call(orders, timeframe)
        
        # Step 4: Assess logistics capability (simulate calling Logistics Agent)
        logistics_analysis = simulate_logistics_agent_call(orders, timeframe)
        
        # Step 5: Assess risks (simulate calling Risk Agent)
        risk_analysis = simulate_risk_agent_call(orders, timeframe, constraints)
        
        # Step 6: Synthesize comprehensive fulfillment plan
        fulfillment_plan = synthesize_fulfillment_plan(
            orders, inventory_analysis, demand_analysis, 
            logistics_analysis, risk_analysis, timeframe, constraints
        )
        
        return json.dumps(fulfillment_plan, indent=2)
        
    except Exception as e:
        logger.error(f"Error orchestrating fulfillment: {str(e)}")
        return json.dumps({
            "error": f"Failed to orchestrate fulfillment: {str(e)}",
            "fulfillmentCapable": False,
            "timeframe": timeframe
        })

@tool
def create_action_plan(scenario: str, priority: str = "high", constraints: Dict = None) -> str:
    """Create comprehensive action plans for supply chain scenarios."""
    try:
        logger.info(f"Creating action plan for scenario: {scenario}")
        
        # Analyze scenario type
        scenario_lower = scenario.lower()
        
        if "supplier delay" in scenario_lower or "delay" in scenario_lower:
            action_plan = create_supplier_delay_plan(scenario, priority, constraints)
        elif "inventory shortage" in scenario_lower or "shortage" in scenario_lower:
            action_plan = create_inventory_shortage_plan(scenario, priority, constraints)
        elif "demand surge" in scenario_lower or "surge" in scenario_lower:
            action_plan = create_demand_surge_plan(scenario, priority, constraints)
        elif "fulfillment" in scenario_lower:
            action_plan = create_fulfillment_plan(scenario, priority, constraints)
        else:
            action_plan = create_general_action_plan(scenario, priority, constraints)
        
        return json.dumps(action_plan, indent=2)
        
    except Exception as e:
        logger.error(f"Error creating action plan: {str(e)}")
        return json.dumps({
            "error": f"Failed to create action plan: {str(e)}",
            "scenario": scenario,
            "priority": priority
        })

@tool
def synthesize_multi_agent_response(agent_responses: List[Dict], original_query: str, context: Dict = None) -> str:
    """Synthesize responses from multiple agents into a comprehensive answer."""
    try:
        logger.info(f"Synthesizing responses from {len(agent_responses)} agents")
        
        # Extract key insights from each agent
        inventory_insights = []
        demand_insights = []
        logistics_insights = []
        risk_insights = []
        
        for response in agent_responses:
            agent_type = response.get('agentType', 'unknown')
            content = response.get('content', '')
            
            if agent_type == 'inventory':
                inventory_insights.extend(extract_insights_from_response(content, 'inventory'))
            elif agent_type == 'demand':
                demand_insights.extend(extract_insights_from_response(content, 'demand'))
            elif agent_type == 'logistics':
                logistics_insights.extend(extract_insights_from_response(content, 'logistics'))
            elif agent_type == 'risk':
                risk_insights.extend(extract_insights_from_response(content, 'risk'))
        
        # Create comprehensive synthesis
        synthesis = {
            "originalQuery": original_query,
            "agentCoordination": {
                "agentsInvolved": len(agent_responses),
                "coordinationPattern": "parallel_analysis_with_synthesis",
                "executionTime": f"{len(agent_responses) * 3}s (estimated)"
            },
            "comprehensiveAnalysis": {
                "inventoryStatus": {
                    "insights": inventory_insights,
                    "keyFindings": summarize_insights(inventory_insights, 'inventory')
                },
                "demandAnalysis": {
                    "insights": demand_insights,
                    "keyFindings": summarize_insights(demand_insights, 'demand')
                },
                "logisticsAssessment": {
                    "insights": logistics_insights,
                    "keyFindings": summarize_insights(logistics_insights, 'logistics')
                },
                "riskEvaluation": {
                    "insights": risk_insights,
                    "keyFindings": summarize_insights(risk_insights, 'risk')
                }
            },
            "synthesizedRecommendations": generate_synthesized_recommendations(
                inventory_insights, demand_insights, logistics_insights, risk_insights
            ),
            "overallConfidence": calculate_overall_confidence(agent_responses),
            "nextSteps": generate_next_steps(original_query, context),
            "timestamp": datetime.now().isoformat()
        }
        
        return json.dumps(synthesis, indent=2)
        
    except Exception as e:
        logger.error(f"Error synthesizing multi-agent response: {str(e)}")
        return json.dumps({
            "error": f"Failed to synthesize responses: {str(e)}",
            "originalQuery": original_query,
            "agentResponseCount": len(agent_responses)
        })

# Helper functions for orchestration

def simulate_inventory_agent_call(orders):
    """Simulate calling the Inventory Agent for analysis."""
    # In real implementation, this would call the actual Inventory Agent
    total_demand = sum(int(order.get('quantity', 0)) for order in orders)
    
    return {
        "totalDemand": total_demand,
        "inventoryCapable": total_demand < 500,  # Mock threshold
        "shortfalls": [
            {"productId": "PROD-002", "shortage": 30},
            {"productId": "PROD-003", "shortage": 25}
        ] if total_demand > 300 else [],
        "confidence": 0.85
    }

def simulate_demand_agent_call(orders, timeframe):
    """Simulate calling the Demand Agent for forecasting."""
    return {
        "forecastedDemand": len(orders) * 1.2,  # 20% increase expected
        "demandTrend": "increasing",
        "seasonalFactor": 1.1,
        "confidence": 0.78
    }

def simulate_logistics_agent_call(orders, timeframe):
    """Simulate calling the Logistics Agent for capacity assessment."""
    return {
        "logisticsCapacity": len(orders) < 10,  # Can handle up to 10 orders
        "deliveryConstraints": ["weather_risk", "carrier_capacity"] if len(orders) > 5 else [],
        "estimatedDeliveryTime": f"{len(orders) * 2} days",
        "confidence": 0.82
    }

def simulate_risk_agent_call(orders, timeframe, constraints):
    """Simulate calling the Risk Agent for risk assessment."""
    risk_level = "high" if len(orders) > 8 else "medium" if len(orders) > 4 else "low"
    
    return {
        "overallRiskLevel": risk_level,
        "riskFactors": [
            "supplier_reliability",
            "demand_volatility",
            "logistics_constraints"
        ] if risk_level == "high" else ["demand_volatility"],
        "mitigationStrategies": [
            "diversify_suppliers",
            "increase_safety_stock",
            "expedited_shipping_options"
        ],
        "confidence": 0.80
    }

def synthesize_fulfillment_plan(orders, inventory, demand, logistics, risk, timeframe, constraints):
    """Synthesize all agent inputs into a comprehensive fulfillment plan."""
    total_orders = len(orders)
    total_value = sum(float(order.get('value', 0)) for order in orders)
    
    # Calculate overall fulfillment capability
    capability_factors = [
        inventory.get('inventoryCapable', False),
        logistics.get('logisticsCapacity', False),
        risk.get('overallRiskLevel') != 'high'
    ]
    
    overall_capability = sum(capability_factors) / len(capability_factors)
    can_fulfill = overall_capability > 0.6
    
    # Generate action items
    action_items = []
    if not inventory.get('inventoryCapable', True):
        action_items.extend([
            {
                "action": "emergency_reorder",
                "description": "Emergency reorder for shortage items",
                "priority": "critical",
                "timeline": "24-48 hours",
                "cost": "$5,000",
                "approvalRequired": True
            }
        ])
    
    if not logistics.get('logisticsCapacity', True):
        action_items.extend([
            {
                "action": "logistics_optimization",
                "description": "Optimize delivery routes and schedules",
                "priority": "high",
                "timeline": "4-8 hours",
                "cost": "$500",
                "approvalRequired": False
            }
        ])
    
    return {
        "fulfillmentAssessment": {
            "canFulfill": can_fulfill,
            "fulfillmentPercentage": round(overall_capability * 100, 1),
            "confidence": round(sum([
                inventory.get('confidence', 0.8),
                demand.get('confidence', 0.8),
                logistics.get('confidence', 0.8),
                risk.get('confidence', 0.8)
            ]) / 4, 2)
        },
        "orderSummary": {
            "totalOrders": total_orders,
            "totalValue": f"${total_value:,.2f}",
            "timeframe": timeframe
        },
        "agentAnalysis": {
            "inventory": inventory,
            "demand": demand,
            "logistics": logistics,
            "risk": risk
        },
        "actionItems": action_items,
        "recommendations": [
            "✅ Proceed with fulfillment as planned" if can_fulfill else "⚠️ Address critical issues before proceeding",
            "📊 Monitor key metrics during execution",
            "🔄 Review and adjust plan based on real-time data"
        ],
        "timestamp": datetime.now().isoformat()
    }

def create_supplier_delay_plan(scenario, priority, constraints):
    """Create action plan for supplier delay scenarios."""
    return {
        "scenario": scenario,
        "planType": "supplier_delay_mitigation",
        "priority": priority,
        "immediateActions": [
            {
                "action": "assess_impact",
                "description": "Assess impact of delay on current orders",
                "timeline": "1 hour",
                "owner": "supply_chain_manager"
            },
            {
                "action": "contact_backup_suppliers",
                "description": "Contact backup suppliers for affected products",
                "timeline": "2-4 hours",
                "owner": "procurement_team"
            },
            {
                "action": "customer_communication",
                "description": "Notify affected customers of potential delays",
                "timeline": "4 hours",
                "owner": "customer_service"
            }
        ],
        "shortTermActions": [
            {
                "action": "expedited_shipping",
                "description": "Arrange expedited shipping from backup suppliers",
                "timeline": "1-2 days",
                "cost": "$2,000",
                "approvalRequired": True
            }
        ],
        "longTermActions": [
            {
                "action": "supplier_diversification",
                "description": "Evaluate and onboard additional suppliers",
                "timeline": "2-4 weeks",
                "owner": "strategic_sourcing"
            }
        ],
        "successMetrics": [
            "Customer satisfaction maintained > 90%",
            "Order fulfillment delay < 2 days",
            "Additional cost < 5% of order value"
        ]
    }

def create_inventory_shortage_plan(scenario, priority, constraints):
    """Create action plan for inventory shortage scenarios."""
    return {
        "scenario": scenario,
        "planType": "inventory_shortage_response",
        "priority": priority,
        "immediateActions": [
            {
                "action": "inventory_audit",
                "description": "Conduct immediate inventory audit",
                "timeline": "2 hours",
                "owner": "warehouse_manager"
            },
            {
                "action": "emergency_procurement",
                "description": "Initiate emergency procurement process",
                "timeline": "4 hours",
                "approvalRequired": True
            }
        ],
        "mitigationStrategies": [
            "Product substitution where possible",
            "Partial fulfillment with customer approval",
            "Expedited supplier delivery"
        ],
        "preventiveActions": [
            "Increase safety stock levels",
            "Implement automated reorder points",
            "Improve demand forecasting accuracy"
        ]
    }

def create_demand_surge_plan(scenario, priority, constraints):
    """Create action plan for demand surge scenarios."""
    return {
        "scenario": scenario,
        "planType": "demand_surge_response",
        "priority": priority,
        "immediateActions": [
            {
                "action": "capacity_assessment",
                "description": "Assess current fulfillment capacity",
                "timeline": "1 hour"
            },
            {
                "action": "inventory_reallocation",
                "description": "Reallocate inventory to high-demand products",
                "timeline": "2-4 hours"
            }
        ],
        "scalingActions": [
            "Activate backup suppliers",
            "Increase production capacity",
            "Implement demand shaping strategies"
        ]
    }

def create_fulfillment_plan(scenario, priority, constraints):
    """Create general fulfillment action plan."""
    return {
        "scenario": scenario,
        "planType": "fulfillment_optimization",
        "priority": priority,
        "optimizationActions": [
            "Route optimization",
            "Inventory allocation",
            "Supplier coordination",
            "Customer communication"
        ]
    }

def create_general_action_plan(scenario, priority, constraints):
    """Create general action plan for unspecified scenarios."""
    return {
        "scenario": scenario,
        "planType": "general_response",
        "priority": priority,
        "recommendedApproach": [
            "Analyze situation thoroughly",
            "Identify key stakeholders",
            "Develop response strategy",
            "Execute with monitoring",
            "Review and adjust"
        ]
    }

def extract_insights_from_response(content, agent_type):
    """Extract key insights from agent response content."""
    # Mock insight extraction - in real implementation would use NLP
    insights = []
    if agent_type == 'inventory':
        insights = ["Inventory levels analyzed", "Reorder recommendations generated"]
    elif agent_type == 'demand':
        insights = ["Demand patterns identified", "Forecast generated"]
    elif agent_type == 'logistics':
        insights = ["Logistics capacity assessed", "Delivery optimization suggested"]
    elif agent_type == 'risk':
        insights = ["Risk factors identified", "Mitigation strategies proposed"]
    
    return insights

def summarize_insights(insights, agent_type):
    """Summarize insights for an agent type."""
    if not insights:
        return f"No {agent_type} insights available"
    
    return f"{len(insights)} {agent_type} insights analyzed"

def generate_synthesized_recommendations(inventory, demand, logistics, risk):
    """Generate synthesized recommendations from all agent insights."""
    recommendations = []
    
    if inventory:
        recommendations.append("📦 Address inventory optimization opportunities")
    if demand:
        recommendations.append("📈 Implement demand-driven planning")
    if logistics:
        recommendations.append("🚚 Optimize logistics and delivery processes")
    if risk:
        recommendations.append("⚠️ Implement risk mitigation strategies")
    
    recommendations.append("🔄 Establish continuous monitoring and adjustment processes")
    
    return recommendations

def calculate_overall_confidence(agent_responses):
    """Calculate overall confidence from agent responses."""
    if not agent_responses:
        return 0.5
    
    confidences = [response.get('confidence', 0.8) for response in agent_responses]
    return round(sum(confidences) / len(confidences), 2)

def generate_next_steps(query, context):
    """Generate next steps based on query and context."""
    return [
        "Review and approve recommended actions",
        "Monitor execution progress",
        "Adjust plan based on real-time feedback",
        "Document lessons learned"
    ]

def _build_agent() -> Agent:
    """Build the Orchestrator Agent."""
    model_id = os.getenv("BEDROCK_MODEL_ID", "amazon.nova-pro-v1:0")
    model = BedrockModel(model_id=model_id)
    
    system_prompt = """You are the Supply Chain Orchestrator Agent for SupplySense.

Your role is to coordinate multi-agent workflows, synthesize insights, and create comprehensive action plans.

You have access to orchestration tools:
- orchestrate_fulfillment: Coordinate multi-agent fulfillment analysis
- create_action_plan: Generate comprehensive action plans for scenarios
- synthesize_multi_agent_response: Combine insights from multiple agents

When orchestrating:
1. Coordinate other agents to gather comprehensive insights
2. Synthesize findings into clear, actionable recommendations
3. Resolve conflicts between agent recommendations
4. Provide strategic guidance and decision support

Be strategic, comprehensive, and action-oriented."""
    
    return Agent(
        model=model,
        tools=[orchestrate_fulfillment, create_action_plan, synthesize_multi_agent_response],
        system_prompt=system_prompt
    )

_agent = _build_agent()

@app.entrypoint
def orchestrator_agent(request: RequestContext) -> Dict[str, Any]:
    """AgentCore entrypoint for orchestrator agent - matches SpendOptimo exactly."""
    prompt = (request.get("prompt") or request.get("input") or "").strip()
    logger.info("Runtime received prompt: %s", prompt)
    if not prompt:
        return {
            "brand": "SupplySense",
            "message": "No prompt provided.",
        }
    response = _agent(prompt)
    text = response.message["content"][0]["text"]
    logger.info("Runtime response generated successfully")
    
    # Clean up hidden reasoning tags and other artifacts
    import re
    clean_text = re.sub(r'<(thinking|analysis|response)>.*?</\1>', '', text, flags=re.DOTALL | re.IGNORECASE).strip()
    clean_text = re.sub(r'</?(thinking|analysis|response)>', '', clean_text, flags=re.IGNORECASE).strip()
    
    return {
        "brand": "SupplySense",
        "message": clean_text,
    }

if __name__ == "__main__":
    app.run()