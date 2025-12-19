from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List, Tuple
from datetime import datetime, timedelta

from bedrock_agentcore import BedrockAgentCoreApp, RequestContext
from strands import Agent, tool
from strands.models import BedrockModel
import boto3

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

app = BedrockAgentCoreApp()

dynamodb = boto3.resource('dynamodb', region_name=os.environ.get('AWS_REGION', 'us-east-1'))


def _to_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _normalize_order_items(order: Dict[str, Any]) -> List[Dict[str, int]]:
    normalized: List[Dict[str, int]] = []
    items = order.get('items') or []
    for item in items:
        product_id = item.get('productId')
        if not product_id:
            continue
        quantity = _to_int(item.get('quantity', 0))
        normalized.append({'productId': product_id, 'quantity': max(quantity, 0)})
    if normalized:
        return normalized

    product_ids = order.get('productIds') or []
    total_quantity = _to_int(order.get('quantity', 0))
    if not product_ids:
        return normalized

    if total_quantity <= 0:
        return [{'productId': pid, 'quantity': 0} for pid in product_ids]

    base_qty = max(1, total_quantity // len(product_ids))
    remaining = total_quantity
    for index, product_id in enumerate(product_ids):
        allocated = base_qty if index < len(product_ids) - 1 else max(remaining, 0)
        normalized.append({'productId': product_id, 'quantity': max(allocated, 0)})
        remaining -= allocated

    return normalized


def _compute_inventory_exposure(
    inventory_data: List[Dict[str, Any]],
    orders_data: List[Dict[str, Any]],
) -> Dict[str, Any]:
    inventory_by_product: Dict[str, int] = {}
    for item in inventory_data:
        product_id = item.get('productId')
        if not product_id:
            continue
        available = _to_int(item.get('availableStock', item.get('currentStock', 0)))
        inventory_by_product[product_id] = inventory_by_product.get(product_id, 0) + max(available, 0)

    product_demand: Dict[str, int] = {}
    product_revenue: Dict[str, float] = {}
    product_to_orders: Dict[str, List[str]] = {}

    for order in orders_data:
        order_id = order.get('orderId', 'UNKNOWN')
        normalized_items = _normalize_order_items(order)
        total_qty = sum(item['quantity'] for item in normalized_items) or 1
        order_value = float(order.get('value') or 0)
        unit_price_hint = (order_value / total_qty) if total_qty else 50.0

        for item in normalized_items:
            product_id = item['productId']
            quantity = item['quantity']
            product_demand[product_id] = product_demand.get(product_id, 0) + quantity
            product_revenue[product_id] = product_revenue.get(product_id, 0.0) + quantity * unit_price_hint
            product_to_orders.setdefault(product_id, []).append(order_id)

    shortages: List[Dict[str, Any]] = []
    orders_impacted: set[str] = set()
    total_shortage_units = 0
    revenue_at_risk = 0.0

    for product_id, required in product_demand.items():
        available = inventory_by_product.get(product_id, 0)
        if available < required:
            shortage = required - available
            total_shortage_units += shortage
            revenue_at_risk += product_revenue.get(product_id, shortage * 50.0)
            shortages.append({
                'productId': product_id,
                'required': required,
                'available': available,
                'shortage': shortage,
            })
            orders_impacted.update(product_to_orders.get(product_id, []))

    return {
        'shortages': shortages,
        'totalShortageUnits': total_shortage_units,
        'revenueAtRisk': round(revenue_at_risk, 2),
        'ordersImpacted': sorted([oid for oid in orders_impacted if oid != 'UNKNOWN']),
        'ordersAffectedCount': len(orders_impacted),
    }


def _compute_logistics_exposure(orders_data: List[Dict[str, Any]]) -> Dict[str, Any]:
    orders_needing_routes: List[str] = []
    delayed_orders: List[str] = []
    expedited_orders: List[str] = []

    for order in orders_data:
        order_id = order.get('orderId', 'UNKNOWN')
        route = order.get('deliveryRoute') or order.get('routeId')
        status = (order.get('status') or '').lower()
        urgency = (order.get('urgency') or '').lower()

        if not route:
            orders_needing_routes.append(order_id)
        if status in {'delayed', 'blocked', 'at_risk'}:
            delayed_orders.append(order_id)
        if urgency in {'high', 'expedite'}:
            expedited_orders.append(order_id)

    total_orders = len(orders_data)
    return {
        'totalPendingOrders': total_orders,
        'ordersNeedingRoutes': len(orders_needing_routes),
        'ordersNeedingRouteIds': orders_needing_routes,
        'delayedOrders': delayed_orders,
        'expeditedOrders': expedited_orders,
    }

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
        
        # Compute exposures
        inventory_exposure = _compute_inventory_exposure(inventory_data, orders_data)
        logistics_exposure = _compute_logistics_exposure(orders_data)

        # Assess different risk categories
        inventory_risks = assess_inventory_risks(inventory_data, inventory_exposure)
        supplier_risks = assess_supplier_risks(suppliers_data)
        demand_risks = assess_demand_risks(orders_data)
        logistics_risks = assess_logistics_risks(logistics_exposure)
        
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
            "exposureSummary": {
                "inventory": inventory_exposure,
                "logistics": logistics_exposure,
            },
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
def analyze_disruption_impact(disruption_type: str, affected_entities: list[str] | None, severity: str = "medium") -> str:
    """Analyze the impact of supply chain disruptions."""
    try:
        entities = affected_entities or []
        impact_analysis = {
            "disruptionType": disruption_type,
            "affectedEntities": entities,
            "severity": severity,
            "impactAssessment": {},
            "cascadingEffects": [],
            "recoveryTime": "",
            "mitigationActions": []
        }
        
        if disruption_type.lower() == "supplier_delay":
            impact_analysis = analyze_supplier_delay_impact(entities, severity)
        elif disruption_type.lower() == "inventory_shortage":
            impact_analysis = analyze_inventory_shortage_impact(entities, severity)
        elif disruption_type.lower() == "logistics_disruption":
            impact_analysis = analyze_logistics_disruption_impact(entities, severity)
        else:
            impact_analysis = analyze_general_disruption_impact(disruption_type, entities, severity)
        
        return json.dumps(impact_analysis, indent=2)
        
    except Exception as e:
        return json.dumps({
            "error": f"Failed to analyze disruption impact: {str(e)}",
            "disruptionType": disruption_type
        })

def assess_inventory_risks(inventory_data, exposure: Dict[str, Any] | None = None):
    """Assess inventory-related risks."""
    out_of_stock = len([item for item in inventory_data if item.get('availableStock', 0) == 0])
    low_stock = len([item for item in inventory_data if item.get('availableStock', 0) <= item.get('reorderPoint', 0)])
    total_items = len(inventory_data)
    
    base_risk = (out_of_stock * 0.8 + low_stock * 0.4) / max(total_items, 1)
    exposure = exposure or {}
    shortage_units = exposure.get('totalShortageUnits', 0)
    revenue_at_risk = exposure.get('revenueAtRisk', 0.0)
    exposure_factor = min(0.4, shortage_units / 200) + min(0.2, revenue_at_risk / 50000)
    risk_score = min(base_risk + exposure_factor, 1.0)
    risk_factors = [
        f"{out_of_stock} products out of stock",
        f"{low_stock} products below reorder point",
    ]
    if shortage_units:
        risk_factors.append(f"Shortage exposure: {shortage_units} units")
    if revenue_at_risk:
        risk_factors.append(f"Revenue at risk ≈ ${revenue_at_risk:,.0f}")
    
    return {
        "riskScore": min(risk_score, 1.0),
        "riskFactors": risk_factors,
        "recommendations": [
            "Increase safety stock for critical items",
            "Implement automated reordering"
        ],
        "exposure": exposure,
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

def assess_logistics_risks(exposure: Dict[str, Any] | None = None):
    """Assess logistics-related risks."""
    exposure = exposure or {}
    total_orders = exposure.get('totalPendingOrders', 1)
    orders_needing_routes = exposure.get('ordersNeedingRoutes', 0)
    delayed_orders = len(exposure.get('delayedOrders', []))
    expedited_orders = len(exposure.get('expeditedOrders', []))

    route_pressure = orders_needing_routes / max(total_orders, 1)
    delay_factor = min(0.3, delayed_orders * 0.05)
    expedite_factor = min(0.15, expedited_orders * 0.04)
    base_risk = 0.2
    risk_score = min(1.0, base_risk + route_pressure * 0.6 + delay_factor + expedite_factor)

    risk_factors = [
        f"{orders_needing_routes} orders lacking assigned routes",
        f"{delayed_orders} delayed orders with customer impact" if delayed_orders else "No current delays reported",
    ]
    if expedited_orders:
        risk_factors.append(f"{expedited_orders} orders require expedited shipping")

    return {
        "riskScore": risk_score,
        "riskFactors": risk_factors,
        "recommendations": [
            "Diversify carrier options",
            "Implement route optimization",
            "Activate overflow capacity for unplanned orders" if orders_needing_routes else "Maintain current logistics cadence",
        ],
        "exposure": exposure,
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

    inventory_exposure = inventory.get('exposure') or {}
    if inventory_exposure.get('totalShortageUnits'):
        all_risks.append({
            "category": "inventory",
            "risk": f"Shortage exposure {inventory_exposure.get('totalShortageUnits')} units "
                    f"(~${inventory_exposure.get('revenueAtRisk', 0):,.0f} revenue risk)",
            "score": min(1.0, inventory_exposure.get('totalShortageUnits', 0) / 150 or 0.0)
        })
    logistics_exposure = logistics.get('exposure') or {}
    if logistics_exposure.get('ordersNeedingRoutes'):
        all_risks.append({
            "category": "logistics",
            "risk": f"{logistics_exposure.get('ordersNeedingRoutes')} orders need routing",
            "score": min(1.0, logistics_exposure.get('ordersNeedingRoutes', 0) / max(logistics_exposure.get('totalPendingOrders', 1), 1))
        })
    
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
    """AgentCore entrypoint for risk agent."""
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