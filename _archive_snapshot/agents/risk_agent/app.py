from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List
from datetime import datetime, timedelta

from bedrock_agentcore import BedrockAgentCoreApp, RequestContext
from strands import Agent, tool
from strands.models import BedrockModel
import boto3

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

app = BedrockAgentCoreApp()

dynamodb = boto3.resource('dynamodb', region_name=os.environ.get('AWS_REGION', 'us-east-1'))

@tool
def assess_supply_chain_risks(timeframe: str = "weekly", focus_area: str = "all") -> str:
    """Assess supply chain risks across inventory, suppliers, and logistics."""
    try:
        # Get data from multiple tables
        inventory_table = dynamodb.Table('supplysense-inventory')
        suppliers_table = dynamodb.Table('supplysense-suppliers')
        orders_table = dynamodb.Table('supplysense-orders')
        
        # Scan for risk assessment data
        inventory_data = inventory_table.scan().get('Items', [])
        suppliers_data = suppliers_table.scan().get('Items', [])
        orders_data = orders_table.scan().get('Items', [])
        
        # Assess different risk categories
        inventory_risks = assess_inventory_risks(inventory_data)
        supplier_risks = assess_supplier_risks(suppliers_data)
        demand_risks = assess_demand_risks(orders_data)
        logistics_risks = assess_logistics_risks()
        
        # Calculate overall risk score
        overall_risk = calculate_overall_risk_score([
            inventory_risks['riskScore'],
            supplier_risks['riskScore'], 
            demand_risks['riskScore'],
            logistics_risks['riskScore']
        ])
        
        risk_assessment = {
            "timeframe": timeframe,
            "focusArea": focus_area,
            "overallRiskScore": overall_risk,
            "riskLevel": get_risk_level(overall_risk),
            "riskCategories": {
                "inventory": inventory_risks,
                "suppliers": supplier_risks,
                "demand": demand_risks,
                "logistics": logistics_risks
            },
            "topRisks": identify_top_risks(inventory_risks, supplier_risks, demand_risks, logistics_risks),
            "mitigationStrategies": generate_mitigation_strategies(overall_risk),
            "monitoringRecommendations": generate_monitoring_recommendations(),
            "timestamp": datetime.now().isoformat()
        }
        
        return json.dumps(risk_assessment, indent=2)
        
    except Exception as e:
        logger.error(f"Error assessing risks: {str(e)}")
        return json.dumps({
            "error": f"Failed to assess supply chain risks: {str(e)}",
            "timeframe": timeframe
        })

@tool
def analyze_disruption_impact(disruption_type: str, affected_entities: List[str], severity: str = "medium") -> str:
    """Analyze the impact of supply chain disruptions."""
    try:
        impact_analysis = {
            "disruptionType": disruption_type,
            "affectedEntities": affected_entities,
            "severity": severity,
            "impactAssessment": {},
            "cascadingEffects": [],
            "recoveryTime": "",
            "mitigationActions": []
        }
        
        if disruption_type.lower() == "supplier_delay":
            impact_analysis = analyze_supplier_delay_impact(affected_entities, severity)
        elif disruption_type.lower() == "inventory_shortage":
            impact_analysis = analyze_inventory_shortage_impact(affected_entities, severity)
        elif disruption_type.lower() == "logistics_disruption":
            impact_analysis = analyze_logistics_disruption_impact(affected_entities, severity)
        else:
            impact_analysis = analyze_general_disruption_impact(disruption_type, affected_entities, severity)
        
        return json.dumps(impact_analysis, indent=2)
        
    except Exception as e:
        return json.dumps({
            "error": f"Failed to analyze disruption impact: {str(e)}",
            "disruptionType": disruption_type
        })

def assess_inventory_risks(inventory_data):
    """Assess inventory-related risks."""
    out_of_stock = len([item for item in inventory_data if item.get('availableStock', 0) == 0])
    low_stock = len([item for item in inventory_data if item.get('availableStock', 0) <= item.get('reorderPoint', 0)])
    total_items = len(inventory_data)
    
    risk_score = (out_of_stock * 0.8 + low_stock * 0.4) / max(total_items, 1)
    
    return {
        "riskScore": min(risk_score, 1.0),
        "riskFactors": [
            f"{out_of_stock} products out of stock",
            f"{low_stock} products below reorder point"
        ],
        "recommendations": [
            "Increase safety stock for critical items",
            "Implement automated reordering"
        ]
    }

def assess_supplier_risks(suppliers_data):
    """Assess supplier-related risks."""
    unreliable_suppliers = len([s for s in suppliers_data if s.get('reliabilityScore', 1.0) < 0.8])
    total_suppliers = len(suppliers_data)
    
    risk_score = unreliable_suppliers / max(total_suppliers, 1)
    
    return {
        "riskScore": risk_score,
        "riskFactors": [
            f"{unreliable_suppliers} suppliers with low reliability",
            "Single source dependencies" if total_suppliers < 3 else "Adequate supplier diversity"
        ],
        "recommendations": [
            "Diversify supplier base",
            "Improve supplier performance monitoring"
        ]
    }

def assess_demand_risks(orders_data):
    """Assess demand-related risks."""
    recent_orders = [o for o in orders_data if o.get('orderDate', '') > (datetime.now() - timedelta(days=7)).isoformat()]
    historical_avg = len(orders_data) / 30  # Assume 30-day history
    current_rate = len(recent_orders) / 7
    
    volatility = abs(current_rate - historical_avg) / max(historical_avg, 1)
    risk_score = min(volatility, 1.0)
    
    return {
        "riskScore": risk_score,
        "riskFactors": [
            f"Demand volatility: {volatility:.2f}",
            "Seasonal demand patterns"
        ],
        "recommendations": [
            "Improve demand forecasting",
            "Implement demand sensing"
        ]
    }

def assess_logistics_risks():
    """Assess logistics-related risks."""
    # Mock logistics risk assessment
    return {
        "riskScore": 0.3,
        "riskFactors": [
            "Weather-related delays possible",
            "Carrier capacity constraints"
        ],
        "recommendations": [
            "Diversify carrier options",
            "Implement route optimization"
        ]
    }

def calculate_overall_risk_score(risk_scores):
    """Calculate weighted overall risk score."""
    weights = [0.3, 0.25, 0.25, 0.2]  # inventory, supplier, demand, logistics
    return sum(score * weight for score, weight in zip(risk_scores, weights))

def get_risk_level(risk_score):
    """Convert risk score to risk level."""
    if risk_score > 0.7:
        return "HIGH"
    elif risk_score > 0.4:
        return "MEDIUM"
    else:
        return "LOW"

def identify_top_risks(inventory, supplier, demand, logistics):
    """Identify top 3 risks across all categories."""
    all_risks = []
    
    for factor in inventory['riskFactors']:
        all_risks.append({"category": "inventory", "risk": factor, "score": inventory['riskScore']})
    for factor in supplier['riskFactors']:
        all_risks.append({"category": "supplier", "risk": factor, "score": supplier['riskScore']})
    for factor in demand['riskFactors']:
        all_risks.append({"category": "demand", "risk": factor, "score": demand['riskScore']})
    for factor in logistics['riskFactors']:
        all_risks.append({"category": "logistics", "risk": factor, "score": logistics['riskScore']})
    
    return sorted(all_risks, key=lambda x: x['score'], reverse=True)[:3]

def generate_mitigation_strategies(overall_risk):
    """Generate mitigation strategies based on risk level."""
    if overall_risk > 0.7:
        return [
            "Implement emergency response protocols",
            "Increase safety stock across all products",
            "Activate backup suppliers immediately",
            "Enhance monitoring and alerting systems"
        ]
    elif overall_risk > 0.4:
        return [
            "Review and update contingency plans",
            "Strengthen supplier relationships",
            "Improve demand forecasting accuracy",
            "Optimize inventory levels"
        ]
    else:
        return [
            "Maintain current risk management practices",
            "Continue regular risk assessments",
            "Monitor key risk indicators"
        ]

def generate_monitoring_recommendations():
    """Generate monitoring recommendations."""
    return [
        "Daily inventory level monitoring",
        "Weekly supplier performance review",
        "Real-time demand pattern analysis",
        "Monthly risk assessment updates"
    ]

def analyze_supplier_delay_impact(affected_entities, severity):
    """Analyze impact of supplier delays."""
    return {
        "disruptionType": "supplier_delay",
        "affectedEntities": affected_entities,
        "severity": severity,
        "impactAssessment": {
            "ordersAffected": len(affected_entities) * 5,
            "revenueAtRisk": f"${len(affected_entities) * 10000}",
            "customerImpact": "moderate" if severity == "medium" else "high"
        },
        "cascadingEffects": [
            "Inventory shortages",
            "Customer delivery delays",
            "Increased expediting costs"
        ],
        "recoveryTime": "5-7 days" if severity == "medium" else "10-14 days",
        "mitigationActions": [
            "Activate backup suppliers",
            "Expedite alternative sourcing",
            "Communicate with affected customers"
        ]
    }

def analyze_inventory_shortage_impact(affected_entities, severity):
    """Analyze impact of inventory shortages."""
    return {
        "disruptionType": "inventory_shortage",
        "impactAssessment": {
            "stockoutRisk": "high",
            "fulfillmentCapacity": "reduced by 30%"
        },
        "recoveryTime": "3-5 days",
        "mitigationActions": [
            "Emergency procurement",
            "Product substitution",
            "Customer communication"
        ]
    }

def analyze_logistics_disruption_impact(affected_entities, severity):
    """Analyze impact of logistics disruptions."""
    return {
        "disruptionType": "logistics_disruption", 
        "impactAssessment": {
            "deliveryDelays": "2-4 days average",
            "additionalCosts": "$500 per order"
        },
        "recoveryTime": "1-3 days",
        "mitigationActions": [
            "Alternative routing",
            "Expedited shipping options",
            "Customer notifications"
        ]
    }

def analyze_general_disruption_impact(disruption_type, affected_entities, severity):
    """Analyze general disruption impacts."""
    return {
        "disruptionType": disruption_type,
        "impactAssessment": {
            "generalImpact": f"{severity} impact expected",
            "affectedOperations": len(affected_entities)
        },
        "recoveryTime": "varies",
        "mitigationActions": [
            "Assess specific impacts",
            "Develop targeted response plan",
            "Monitor situation closely"
        ]
    }

def _build_agent() -> Agent:
    """Build the Risk Assessment Agent."""
    model_id = os.getenv("BEDROCK_MODEL_ID", "amazon.nova-pro-v1:0")
    model = BedrockModel(model_id=model_id)
    
    system_prompt = """You are the Risk Assessment Agent for SupplySense supply chain management system.

Your role is to assess supply chain risks, analyze disruption impacts, and recommend mitigation strategies.

You have access to risk assessment tools:
- assess_supply_chain_risks: Comprehensive risk analysis across all areas
- analyze_disruption_impact: Analyze specific disruption scenarios

When assessing risks:
1. Use tools to analyze suppliers, inventory, demand, and logistics risks
2. Provide specific risk scores and severity levels
3. Identify cascading effects and dependencies
4. Give prioritized mitigation strategies

Be thorough and strategic in risk analysis."""
    
    return Agent(
        model=model,
        tools=[assess_supply_chain_risks, analyze_disruption_impact],
        system_prompt=system_prompt
    )

_agent = _build_agent()

@app.entrypoint
def risk_agent(request: RequestContext) -> Dict[str, Any]:
    """AgentCore entrypoint for risk agent - matches SpendOptimo exactly."""
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