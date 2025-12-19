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


def _safe_json_loads(value: str) -> Any:
    try:
        return json.loads(value)
    except Exception:
        return None


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


def _summarize_logistics_payload(payload: Dict[str, Any], base_summary: str | None = None) -> Dict[str, Any]:
    """Shape logistics analytics into structured findings with both highlight and detailed summaries."""
    total_orders = payload.get('totalPendingOrders') or payload.get('orderSummary', {}).get('totalOrders') or 0
    orders_with_routes = payload.get('ordersWithRoutes') or payload.get('assignedRoutes') or 0
    orders_needing_routes = payload.get('ordersNeedingRoutes') or max(total_orders - orders_with_routes, 0)
    capacity_utilization = payload.get('capacityUtilization')
    max_daily_capacity = payload.get('maxDailyCapacity')
    can_fulfill = bool(payload.get('canFulfillAll') or payload.get('canFulfillAllOrders') or payload.get('logisticsCapacity'))
    recommendation_text = payload.get('recommendation') or payload.get('recommendations')

    status = 'constraint' if orders_needing_routes > 0 or not can_fulfill else 'clear'

    # Build highlight summary (2-3 sentences)
    highlight_lines: List[str] = []
    if capacity_utilization:
        highlight_lines.append(f"Capacity utilization at {capacity_utilization}.")
    if orders_needing_routes:
        highlight_lines.append(f"{orders_needing_routes} order(s) require route assignment.")
    if can_fulfill:
        highlight_lines.append("All orders can be fulfilled within current capacity.")
    else:
        highlight_lines.append("Current throughput cannot cover all pending orders.")
    
    highlight_summary = ' '.join(highlight_lines).strip() or "Logistics assessment complete."
    
    # Build detailed summary (5-8 sentences)
    detailed_lines: List[str] = []
    detailed_lines.append(f"Analysis of logistics capacity shows {total_orders} pending orders against a maximum daily capacity of {max_daily_capacity} orders, resulting in {capacity_utilization} utilization.")
    
    if orders_needing_routes > 0:
        detailed_lines.append(f"{orders_needing_routes} orders currently lack assigned routes and require logistics planning.")
    if orders_with_routes > 0:
        detailed_lines.append(f"{orders_with_routes} orders have been assigned routes and are ready for shipment.")
    
    if can_fulfill:
        detailed_lines.append("All pending orders can be fulfilled within current logistics capacity constraints.")
        detailed_lines.append("Route optimization opportunities exist for consolidating shipments to improve cost efficiency.")
    else:
        detailed_lines.append("Current logistics capacity is insufficient to handle all pending orders.")
        detailed_lines.append("Immediate action required to activate overflow carriers or extend operational shifts.")
    
    # Don't add generic recommendation text to detailed summary - it's redundant and often contradictory
    # The recommendations list below will capture specific actionable items
    
    detailed_summary = ' '.join(detailed_lines).strip()

    blockers: List[str] = []
    if orders_needing_routes:
        blockers.append(f"{orders_needing_routes} orders lack assigned routes.")
    if not can_fulfill:
        blockers.append("Logistics capacity below demand volume.")

    metrics = {
        'totalPendingOrders': total_orders,
        'ordersWithRoutes': orders_with_routes,
        'ordersNeedingRoutes': orders_needing_routes,
        'maxDailyCapacity': max_daily_capacity,
        'capacityUtilization': capacity_utilization,
    }

    recommendations: List[str] = []
    # Filter out generic/contradictory recommendations from tool output
    if isinstance(recommendation_text, list):
        for item in recommendation_text:
            item_str = str(item).strip()
            # Skip generic "can fulfill" statements - they're often contradictory in context
            if item_str and 'can fulfill all' not in item_str.lower():
                recommendations.append(item_str)
    elif isinstance(recommendation_text, str):
        rec_str = recommendation_text.strip()
        # Skip generic "can fulfill" statements
        if rec_str and 'can fulfill all' not in rec_str.lower() and rec_str not in recommendations:
            recommendations.append(rec_str)

    # Add specific actionable recommendations
    if orders_needing_routes:
        recommendations.append("Assign routes or consolidate shipments for unplanned orders.")
    if not can_fulfill:
        recommendations.append("Activate overflow carriers or extend shifts to lift capacity.")

    return {
        'status': status,
        'summary': highlight_summary,  # For Agent Highlights
        'highlightSummary': highlight_summary,  # Explicit field for consistency
        'detailedSummary': detailed_summary,  # For Agent Insights
        'metrics': metrics,
        'blockers': blockers,
        'recommendations': recommendations,
        'confidence': 0.82 if can_fulfill else 0.68,
    }

@tool
def optimize_routes(order_id: str, urgency: str = "medium", constraints: dict[str, Any] | None = None) -> str:
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
            "capacityUtilization": f"{(total_orders / max_daily_capacity * 100):.1f}%"
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


def _fallback_logistics_summary(prompt: str) -> str:
    """
    Generate a fallback summary when tool execution fails.
    Focuses on aggregate logistics capacity for pending orders.
    """
    try:
        pending_orders_table = dynamodb.Table('supplysense-orders')
        response = pending_orders_table.scan(
            FilterExpression='#status = :status',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':status': 'pending'}
        )
        orders = response.get('Items', [])
        total_orders = len(orders)
        total_items = 0
        orders_missing_line_items: List[str] = []
        for order in orders:
            normalized = _normalize_order_items(order)
            if not normalized:
                orders_missing_line_items.append(order.get('orderId', 'UNKNOWN'))
            total_items += sum(item['quantity'] for item in normalized)

        max_daily_capacity = 50
        can_fulfill = total_orders <= max_daily_capacity
        utilization = f"{(total_orders / max_daily_capacity * 100):.1f}%" if max_daily_capacity else "N/A"
        payload = {
            "totalPendingOrders": total_orders,
            "ordersWithRoutes": total_orders - len(orders_missing_line_items),
            "ordersNeedingRoutes": len(orders_missing_line_items),
            "ordersMissingLineItems": orders_missing_line_items,
            "maxDailyCapacity": max_daily_capacity,
            "capacityUtilization": utilization,
            "canFulfillAll": can_fulfill,
            "recommendation": (
                f"Exceeds capacity by {total_orders - max_daily_capacity} orders; activate overflow carriers."
                if not can_fulfill else
                "Proceed with planned carrier assignments; monitor utilisation."
            ),
            "totalItems": total_items,
            "fallbackUsed": True,
        }
        summary = _summarize_logistics_payload(
            payload,
            base_summary=f"Logistics fallback analysis executed due to tool error. Prompt excerpt: \"{prompt[:120]}{'...' if len(prompt) > 120 else ''}\""
        )
        return json.dumps(summary, indent=2)
    except Exception as exc:
        logger.error("Fallback logistics analysis failed: %s", exc, exc_info=True)
        failure_payload = {
            "status": "error",
            "summary": "Logistics fallback attempted but data retrieval failed.",
            "blockers": ["Unable to access pending orders dataset."],
            "recommendations": ["Retry analysis after refreshing logistics datasets."],
            "confidence": 0.4,
        }
        return json.dumps(failure_payload, indent=2)

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

IMPORTANT - RESPONSE FORMAT:
You MUST respond in the following JSON structure. Use the tools to get actual data, then format your response as:

{
  "highlightSummary": "A concise 2-3 sentence summary of key logistics findings (e.g., 'Capacity utilization at 6.0%. 3 orders require route assignment. All orders can be fulfilled within capacity.')",
  "detailedSummary": "A comprehensive 5-8 sentence analysis explaining logistics capacity, route assignments, carrier recommendations, and delivery timelines. Include specific order IDs, capacity metrics, and optimization opportunities. (e.g., 'Analysis of logistics capacity shows 3 pending orders against a maximum daily capacity of 50 orders, resulting in 6.0% utilization. Orders ORD-001, ORD-002, and ORD-003 currently lack assigned routes. Recommended carriers include Standard Shipping for ORD-001 and ORD-002 (3-5 day delivery), and Express Logistics for ORD-003 (1-2 day delivery). All orders can be fulfilled within current capacity constraints. Route optimization suggests consolidating ORD-001 and ORD-002 for cost efficiency.')",
  "status": "clear" or "constraint" based on whether logistics can handle all orders,
  "confidence": 0.0 to 1.0 confidence score,
  "blockers": ["List of specific blockers, e.g., '3 orders lack assigned routes'"],
  "recommendations": ["Actionable recommendations, e.g., 'Assign routes to pending orders', 'Consolidate shipments for cost efficiency'"],
  "analysis": "Additional logistics insights beyond the summaries"
}

CRITICAL REQUIREMENTS:
1. ALWAYS use tools first to get actual data before responding
2. highlightSummary MUST be 2-3 sentences, concise and factual
3. detailedSummary MUST be 5-8 sentences, comprehensive with specific order IDs, carriers, and delivery timelines
4. Include actual data from tools (order IDs, capacity metrics, carrier names, delivery dates)
5. status MUST be "constraint" if there are capacity issues or unassigned routes, otherwise "clear"
6. Be data-driven - reference specific findings from the logistics data you accessed

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
    """AgentCore entrypoint for logistics agent."""
    prompt = (request.get("prompt") or request.get("input") or "").strip()
    logger.info("=" * 80)
    logger.info("LOGISTICS AGENT - REQUEST RECEIVED")
    logger.info(f"Prompt: {prompt}")
    logger.info("=" * 80)
    
    if not prompt:
        return {
            "brand": "SupplySense",
            "message": "No prompt provided.",
        }
    
    # Call the LLM agent
    response = _agent(prompt)
    text = response.message["content"][0]["text"]
    
    logger.info("=" * 80)
    logger.info("LOGISTICS AGENT - RAW LLM RESPONSE")
    logger.info(f"Response length: {len(text)} characters")
    logger.info(f"Raw response:\n{text}")
    logger.info("=" * 80)
    
    # Clean up hidden reasoning tags and other artifacts
    import re
    clean_text = re.sub(r'<(thinking|analysis|response)>.*?</\1>', '', text, flags=re.DOTALL | re.IGNORECASE).strip()
    clean_text = re.sub(r'</?(thinking|analysis|response)>', '', clean_text, flags=re.IGNORECASE).strip()
    
    logger.info("LOGISTICS AGENT - CLEANED RESPONSE")
    logger.info(f"Cleaned text:\n{clean_text}")
    logger.info("=" * 80)
    
    clean_lower = clean_text.lower()

    # Check if LLM returned proper JSON
    normalized_payload = _safe_json_loads(clean_text)
    
    # Check for error conditions that need fallback
    needs_fallback = (
        normalized_payload is None or
        'issue with the optimize_routes tool' in clean_lower
        or 'failed to optimize routes' in clean_lower
        or ('error' in clean_lower and 'optimize routes' in clean_lower)
        or ('unable to optimize' in clean_lower)
        or ('provide the specific order ids' in clean_lower)
        or ('could you please provide the specific order ids' in clean_lower)
        or ('please provide the order ids' in clean_lower)
    )

    if needs_fallback:
        logger.info("LOGISTICS AGENT - Using fallback summary")
        fallback_summary = _fallback_logistics_summary(prompt)
        clean_text = fallback_summary

    normalized_payload: Dict[str, Any] | None = None
    try:
        parsed = json.loads(clean_text)
        if isinstance(parsed, dict):
            normalized_payload = parsed
    except json.JSONDecodeError:
        normalized_payload = None

    prompt_lower = prompt.lower()
    needs_structured = False
    if normalized_payload is None:
        needs_structured = True
    elif not any(
        key in normalized_payload
        for key in ('totalPendingOrders', 'ordersNeedingRoutes', 'capacityUtilization', 'maxDailyCapacity')
    ):
        needs_structured = True

    if any(keyword in prompt_lower for keyword in ('fulfill', 'all order', 'logistics', 'route', 'shipping')):
        needs_structured = True

    if needs_structured and not needs_fallback:
        try:
            logistics_raw = analyze_all_pending_orders()
            parsed_logistics = json.loads(logistics_raw)
            if isinstance(parsed_logistics, dict):
                normalized_payload = parsed_logistics
        except Exception as exc:
            logger.warning("Logistics aggregation recalculation failed: %s", exc, exc_info=True)

    if isinstance(normalized_payload, dict):
        # If LLM already provided both summaries, use them directly
        if 'highlightSummary' in normalized_payload and 'detailedSummary' in normalized_payload:
            logger.info("LOGISTICS AGENT - Using LLM-provided summaries directly")
            if 'status' not in normalized_payload:
                normalized_payload['status'] = 'constraint' if normalized_payload.get('blockers') else 'clear'
            if 'confidence' not in normalized_payload:
                normalized_payload['confidence'] = 0.85
            final_response = json.dumps(normalized_payload, indent=2)
        else:
            # Use _summarize_logistics_payload to create structured response
            logger.info("LOGISTICS AGENT - Creating structured response from tool data")
            summary_payload = _summarize_logistics_payload(normalized_payload, base_summary=None if needs_structured else clean_text)
            logger.info(f"LOGISTICS AGENT - Structured payload keys: {list(summary_payload.keys())}")
            final_response = json.dumps(summary_payload, indent=2)
    else:
        logger.error("LOGISTICS AGENT - No valid payload to return")
        final_response = clean_text

    logger.info("=" * 80)
    logger.info("LOGISTICS AGENT - FINAL RESPONSE")
    logger.info(f"Response:\n{final_response}")
    logger.info("=" * 80)

    return {
        "brand": "SupplySense",
        "message": final_response,
    }

if __name__ == "__main__":
    app.run()