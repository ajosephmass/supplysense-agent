from __future__ import annotations

import json
import logging
import os
from decimal import Decimal
from typing import Any, Dict, List
from datetime import datetime, timedelta

from bedrock_agentcore import BedrockAgentCoreApp, RequestContext
from strands import Agent, tool
from strands.models import BedrockModel
import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

app = BedrockAgentCoreApp()

# Initialize DynamoDB client
dynamodb = boto3.resource('dynamodb', region_name=os.environ.get('AWS_REGION', 'us-east-1'))


def _to_int(value: Any) -> int:
    if isinstance(value, Decimal):
        return int(value)
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
        normalized.append({
            'productId': product_id,
            'quantity': _to_int(item.get('quantity', 0))
        })

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
    for idx, product_id in enumerate(product_ids):
        allocated = base_qty if idx < len(product_ids) - 1 else max(remaining, 0)
        normalized.append({
            'productId': product_id,
            'quantity': max(allocated, 0)
        })
        remaining -= allocated

    return normalized

@tool
def optimize_routes(order_id: str, urgency: str = "medium", constraints: Dict = None) -> str:
    """Optimize delivery routes and logistics for orders."""
    try:
        # Get order and logistics data
        orders_table = dynamodb.Table('supplysense-orders')
        logistics_table = dynamodb.Table('supplysense-logistics')
        
        # Get order details
        order_response = orders_table.get_item(Key={'orderId': order_id})
        if 'Item' not in order_response:
            return json.dumps({
                "error": "Order not found",
                "orderId": order_id
            })
        
        order = order_response['Item']
        
        # Get existing logistics data
        logistics_response = logistics_table.scan(
            FilterExpression='orderId = :orderId',
            ExpressionAttributeValues={':orderId': order_id}
        )
        existing_logistics = logistics_response.get('Items', [])
        
        # Generate route optimization
        optimization_result = generate_route_optimization(order, urgency, constraints, existing_logistics)
        
        return json.dumps(optimization_result, indent=2)
        
    except Exception as e:
        logger.error(f"Error optimizing routes: {str(e)}")
        return json.dumps({
            "error": f"Failed to optimize routes: {str(e)}",
            "orderId": order_id
        })

@tool
def analyze_all_pending_orders() -> str:
    """Analyze ALL pending orders for logistics feasibility. Use this when asked about fulfilling all/multiple orders."""
    try:
        orders_table = dynamodb.Table('supplysense-orders')
        
        # Get all pending orders
        response = orders_table.scan(
            FilterExpression='#status = :status',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':status': 'pending'}
        )
        orders = response.get('Items', [])
        
        if not orders:
            return json.dumps({
                "message": "No pending orders found",
                "totalOrders": 0,
                "canFulfillAll": True
            })
        
        # Analyze logistics capacity
        total_orders = len(orders)
        orders_with_routes = 0
        delayed_orders = 0
        total_items = 0
        orders_missing_line_items: List[str] = []
        
        for order in orders:
            order_id = order.get('orderId', 'UNKNOWN')
            normalized_items = _normalize_order_items(order)
            if not normalized_items:
                orders_missing_line_items.append(order_id)
            total_items += sum(item['quantity'] for item in normalized_items)
            
            # Check if route exists
            if order.get('deliveryRoute'):
                orders_with_routes += 1
            
            # Check delivery date
            if order.get('requestedDeliveryDate'):
                # Simplified check - in real world would compare dates
                delayed_orders += 0
        
        # Calculate fulfillment capacity
        max_daily_capacity = 50  # orders per day
        can_fulfill = total_orders <= max_daily_capacity
        
        return json.dumps({
            "totalPendingOrders": total_orders,
            "ordersMissingLineItems": orders_missing_line_items,
            "totalItems": total_items,
            "ordersWithRoutes": orders_with_routes,
            "ordersNeedingRoutes": total_orders - orders_with_routes,
            "maxDailyCapacity": max_daily_capacity,
            "canFulfillAll": can_fulfill,
            "capacityUtilization": f"{(total_orders / max_daily_capacity * 100):.1f}%",
            "recommendation": "Can fulfill all orders" if can_fulfill else f"Exceeds capacity by {total_orders - max_daily_capacity} orders"
        }, indent=2)
        
    except Exception as e:
        logger.error(f"Error analyzing pending orders: {str(e)}")
        return json.dumps({"error": f"Failed to analyze orders: {str(e)}"})

@tool  
def calculate_shipping_options(order_id: str, destination: str, urgency: str = "standard") -> str:
    """Calculate available shipping options and costs for orders."""
    try:
        # Mock shipping calculation logic
        shipping_options = []
        
        base_cost = 50.0
        base_time = 5  # days
        
        if urgency == "standard":
            shipping_options = [
                {
                    "carrier": "Standard Ground",
                    "cost": base_cost,
                    "estimatedDays": base_time,
                    "reliability": 0.95
                },
                {
                    "carrier": "Express Ground", 
                    "cost": base_cost * 1.5,
                    "estimatedDays": base_time - 2,
                    "reliability": 0.98
                }
            ]
        elif urgency == "high":
            shipping_options = [
                {
                    "carrier": "Express Air",
                    "cost": base_cost * 3,
                    "estimatedDays": 1,
                    "reliability": 0.99
                },
                {
                    "carrier": "Overnight",
                    "cost": base_cost * 4,
                    "estimatedDays": 1,
                    "reliability": 0.99
                }
            ]
        
        return json.dumps({
            "orderId": order_id,
            "destination": destination,
            "urgency": urgency,
            "shippingOptions": shipping_options,
            "recommendation": shipping_options[0] if shipping_options else None
        }, indent=2)
        
    except Exception as e:
        return json.dumps({
            "error": f"Failed to calculate shipping: {str(e)}",
            "orderId": order_id
        })

def generate_route_optimization(order, urgency, constraints, existing_logistics):
    """Generate optimized routing recommendations."""
    # Mock route optimization logic
    current_route = existing_logistics[0] if existing_logistics else None
    
    optimization = {
        "orderId": order.get('orderId'),
        "currentRoute": {
            "origin": current_route.get('origin', 'WH-EAST') if current_route else 'WH-EAST',
            "destination": "Customer Location",
            "estimatedDelivery": current_route.get('estimatedDelivery') if current_route else None,
            "carrier": current_route.get('carrier', 'Standard') if current_route else 'Standard'
        },
        "optimizedRoute": {
            "origin": "WH-CENTRAL",  # Closer warehouse
            "destination": "Customer Location", 
            "estimatedDelivery": (datetime.now() + timedelta(days=2)).isoformat(),
            "carrier": "Express" if urgency == "high" else "Standard"
        },
        "improvements": {
            "timeSaved": "1 day",
            "costSaved": "$50" if urgency != "high" else "$0",
            "reliabilityIncrease": "5%"
        },
        "recommendations": [
            "Switch to closer warehouse for faster delivery",
            "Use express carrier for high urgency orders",
            "Consolidate with other orders if possible"
        ]
    }
    
    return optimization

def _build_agent() -> Agent:
    """Build the Logistics Optimization Agent."""
    model_id = os.getenv("BEDROCK_MODEL_ID", "amazon.nova-lite-v1:0")
    model = BedrockModel(model_id=model_id)
    
    system_prompt = """You are the Logistics Optimization Agent for SupplySense supply chain management system.

Your role is to optimize delivery routes, calculate shipping options, and coordinate logistics operations.

You have access to logistics tools:
- analyze_all_pending_orders: Analyze logistics for ALL pending orders (USE THIS for "all orders" questions)
- optimize_routes: Optimize delivery routes for specific orders
- calculate_shipping_options: Analyze shipping methods and costs

IMPORTANT: When asked about "all orders", use analyze_all_pending_orders first.

When optimizing logistics:
1. Use tools to analyze current logistics data
2. Provide specific route and carrier recommendations
3. Balance cost and delivery time based on urgency
4. Give actionable optimization suggestions

Be efficient and practical."""
    
    return Agent(
        model=model,
        tools=[
            analyze_all_pending_orders,
            optimize_routes,
            calculate_shipping_options,
        ],
        system_prompt=system_prompt
    )

_agent = _build_agent()

@app.entrypoint
def logistics_agent(request: RequestContext) -> Dict[str, Any]:
    """AgentCore entrypoint for logistics agent - matches SpendOptimo exactly."""
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