from __future__ import annotations

import json
import logging
import os
from decimal import Decimal
from typing import Any, Dict, List

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
    """Safely convert DynamoDB numeric values (including Decimal) to int."""
    if isinstance(value, Decimal):
        return int(value)
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _normalize_order_items(order: Dict[str, Any]) -> List[Dict[str, int]]:
    """Normalize different order schemas into a consistent list of product/quantity pairs."""
    normalized: List[Dict[str, int]] = []

    items = order.get('items') or []
    for item in items:
        product_id = item.get('productId')
        if not product_id:
            continue
        quantity = _to_int(item.get('quantity', 0))
        normalized.append({
            'productId': product_id,
            'quantity': max(quantity, 0)
        })

    if normalized:
        return normalized

    product_ids = order.get('productIds') or []
    total_quantity = _to_int(order.get('quantity', 0))

    if not product_ids:
        return normalized

    if total_quantity <= 0:
        return [{'productId': pid, 'quantity': 0} for pid in product_ids]

    # Evenly distribute total quantity across products, keeping remainder on last item
    base_quantity = max(1, total_quantity // len(product_ids))
    remaining = total_quantity
    for index, product_id in enumerate(product_ids):
        allocated = base_quantity if index < len(product_ids) - 1 else max(remaining, 0)
        normalized.append({
            'productId': product_id,
            'quantity': max(allocated, 0)
        })
        remaining -= allocated

    return normalized

@tool
def analyze_inventory(location_filter: str = None, include_forecasts: bool = False) -> str:
    """Analyze current inventory levels across all locations and identify issues."""
    try:
        inventory_table = dynamodb.Table('supplysense-inventory')
        
        # Scan inventory table
        if location_filter:
            response = inventory_table.scan(
                FilterExpression='locationId = :location',
                ExpressionAttributeValues={':location': location_filter}
            )
        else:
            response = inventory_table.scan()
        
        items = response.get('Items', [])
        logger.info(
            "Inventory scan returned %d items (location_filter=%s)",
            len(items),
            location_filter or "ALL"
        )

        if not items:
            return json.dumps({
                "status": "no_data",
                "message": "No inventory data found",
                "location_filter": location_filter
            })
        
        # Analyze inventory levels
        total_products = len(items)
        low_stock_items = []
        out_of_stock_items = []
        healthy_stock_items = []
        
        total_value = 0
        reorder_recommendations = []
        
        for item in items:
            current_stock = _to_int(item.get('currentStock', 0))
            reserved_stock = _to_int(item.get('reservedStock', 0))
            available_stock = _to_int(item.get('availableStock', 0))
            reorder_point = _to_int(item.get('reorderPoint', 0))
            max_stock = _to_int(item.get('maxStock', 100))
            product_id = item.get('productId', 'Unknown')
            location_id = item.get('locationId', 'Unknown')
            
            # Calculate value (mock unit price of $50)
            total_value += available_stock * 50
            
            # Categorize inventory status
            if available_stock == 0:
                out_of_stock_items.append({
                    "productId": product_id,
                    "locationId": location_id,
                    "currentStock": current_stock,
                    "status": "OUT_OF_STOCK"
                })
            elif available_stock <= reorder_point:
                low_stock_items.append({
                    "productId": product_id,
                    "locationId": location_id,
                    "currentStock": current_stock,
                    "reservedStock": reserved_stock,
                    "availableStock": available_stock,
                    "reorderPoint": reorder_point,
                    "status": "LOW_STOCK"
                })
                
                # Generate reorder recommendation
                recommended_quantity = max_stock - current_stock
                reorder_recommendations.append({
                    "productId": product_id,
                    "locationId": location_id,
                    "recommendedQuantity": recommended_quantity,
                    "urgency": "CRITICAL" if available_stock == 0 else "HIGH",
                    "estimatedCost": recommended_quantity * 50,
                    "reason": "Below reorder point"
                })
            else:
                healthy_stock_items.append({
                    "productId": product_id,
                    "locationId": location_id,
                    "availableStock": available_stock,
                    "status": "HEALTHY"
                })
        
        # Generate insights
        insights = []
        if out_of_stock_items:
            insights.append(f"🚨 CRITICAL: {len(out_of_stock_items)} products are out of stock")
        if low_stock_items:
            insights.append(f"⚠️ WARNING: {len(low_stock_items)} products below reorder point")
        if not out_of_stock_items and not low_stock_items:
            insights.append("✅ All inventory levels are healthy")
        
        analysis_result = {
            "summary": {
                "totalProducts": total_products,
                "healthyStock": len(healthy_stock_items),
                "lowStock": len(low_stock_items),
                "outOfStock": len(out_of_stock_items),
                "totalValue": f"${total_value:,.2f}",
                "location_filter": location_filter
            },
            "insights": insights,
            "lowStockItems": low_stock_items,
            "outOfStockItems": out_of_stock_items,
            "reorderRecommendations": reorder_recommendations,
            "timestamp": json.dumps({"timestamp": "now"}, default=str)
        }
        
        return json.dumps(analysis_result, indent=2)
        
    except Exception as e:
        logger.error(f"Error analyzing inventory: {str(e)}")
        return json.dumps({
            "error": f"Failed to analyze inventory: {str(e)}",
            "status": "error"
        })

@tool
def check_order_fulfillment_capacity() -> str:
    """Check if current inventory can fulfill ALL pending orders. Use this when asked about fulfilling all/multiple orders."""
    try:
        inventory_table = dynamodb.Table('supplysense-inventory')
        orders_table = dynamodb.Table('supplysense-orders')
        
        # Get all pending orders
        orders_response = orders_table.scan(
            FilterExpression='#status = :status',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':status': 'pending'}
        )
        pending_orders = orders_response.get('Items', [])
        
        # Get current inventory
        inventory_response = inventory_table.scan()
        inventory_items = inventory_response.get('Items', [])
        logger.info(
            "Fulfillment check: %d pending orders, %d inventory rows",
            len(pending_orders),
            len(inventory_items)
        )

        if not inventory_items:
            return json.dumps({
                "status": "no_inventory",
                "message": "No inventory records available",
                "totalPendingOrders": len(pending_orders)
            })

        # Aggregate inventory by product
        inventory_by_product: Dict[str, int] = {}
        for item in inventory_items:
            product_id = item.get('productId')
            if not product_id:
                continue
            available = _to_int(item.get('availableStock', 0))
            inventory_by_product[product_id] = inventory_by_product.get(product_id, 0) + max(available, 0)

        # Calculate total demand from orders (normalize schema variations)
        product_demand: Dict[str, int] = {}
        orders_evaluated = 0
        orders_missing_line_items: List[str] = []
        for order in pending_orders:
            order_id = order.get('orderId', 'UNKNOWN')
            normalized_items = _normalize_order_items(order)
            if not normalized_items:
                orders_missing_line_items.append(order_id)
                continue

            orders_evaluated += 1
            for item in normalized_items:
                product_id = item['productId']
                quantity = max(item['quantity'], 0)
                product_demand[product_id] = product_demand.get(product_id, 0) + quantity
        
        if not product_demand:
            return json.dumps({
                "status": "no_demand_data",
                "message": "Pending orders do not contain line-item details. Unable to calculate fulfillment capacity.",
                "ordersMissingLineItems": orders_missing_line_items,
                "totalPendingOrders": len(pending_orders)
            })

        # Check fulfillment capability
        can_fulfill_all = True
        shortages = []
        sufficient_stock = []
        
        for product_id, required_qty in product_demand.items():
            # Find inventory for this product across all locations
            total_available = inventory_by_product.get(product_id, 0)
            
            if total_available < required_qty:
                can_fulfill_all = False
                shortages.append({
                    "productId": product_id,
                    "required": required_qty,
                    "available": total_available,
                    "shortage": required_qty - total_available
                })
            else:
                sufficient_stock.append({
                    "productId": product_id,
                    "required": required_qty,
                    "available": total_available,
                    "surplus": total_available - required_qty
                })
        
        summary_message = (
            "All orders can be fulfilled from current inventory"
            if can_fulfill_all
            else f"Cannot fulfill all orders - {len(shortages)} product(s) have insufficient stock"
        )

        return json.dumps({
            "canFulfillAllOrders": can_fulfill_all,
            "totalPendingOrders": len(pending_orders),
            "ordersEvaluated": orders_evaluated,
            "ordersMissingLineItems": orders_missing_line_items,
            "uniqueProductsRequested": len(product_demand),
            "productsWithSufficientStock": len(sufficient_stock),
            "productsWithShortages": len(shortages),
            "shortages": shortages,
            "sufficientStock": sufficient_stock[:5],  # Limit to first 5
            "inventorySummary": inventory_by_product,
            "recommendation": summary_message
        }, indent=2)
        
    except Exception as e:
        logger.error(f"Error checking fulfillment capacity: {str(e)}")
        return json.dumps({"error": f"Failed to check fulfillment capacity: {str(e)}"})

@tool
def check_availability(product_id: str, quantity: int, location_id: str = None) -> str:
    """Check product availability for specific quantities at specific or all locations."""
    try:
        inventory_table = dynamodb.Table('supplysense-inventory')
        
        if location_id:
            # Check specific location
            response = inventory_table.get_item(
                Key={'productId': product_id, 'locationId': location_id}
            )
            items = [response['Item']] if 'Item' in response else []
        else:
            # Check all locations for the product
            response = inventory_table.query(
                KeyConditionExpression='productId = :productId',
                ExpressionAttributeValues={':productId': product_id}
            )
            items = response.get('Items', [])
        
        if not items:
            return json.dumps({
                "available": False,
                "reason": "Product not found in inventory",
                "productId": product_id,
                "locationId": location_id,
                "requestedQuantity": quantity
            })
        
        # Calculate total availability
        total_available = sum(item.get('availableStock', 0) for item in items)
        can_fulfill = total_available >= quantity
        
        location_breakdown = []
        for item in items:
            available_at_location = item.get('availableStock', 0)
            location_breakdown.append({
                "locationId": item.get('locationId'),
                "availableStock": available_at_location,
                "canFulfillFully": available_at_location >= quantity,
                "canContribute": available_at_location > 0
            })
        
        result = {
            "available": can_fulfill,
            "productId": product_id,
            "requestedQuantity": quantity,
            "totalAvailable": total_available,
            "shortfall": max(0, quantity - total_available),
            "locationBreakdown": location_breakdown,
            "fulfillmentStrategy": "single_location" if location_id else "multi_location",
            "recommendations": []
        }
        
        # Add recommendations
        if can_fulfill:
            result["recommendations"].append("✅ Stock available for fulfillment")
            if not location_id and len(location_breakdown) > 1:
                # Find best single location
                best_location = max(location_breakdown, key=lambda x: x['availableStock'])
                if best_location['canFulfillFully']:
                    result["recommendations"].append(f"💡 Can fulfill entirely from {best_location['locationId']}")
                else:
                    result["recommendations"].append("💡 Requires multi-location fulfillment")
        else:
            result["recommendations"].append(f"❌ Insufficient stock - need {quantity - total_available} more units")
            result["recommendations"].append("🔄 Consider emergency reorder or customer communication")
        
        return json.dumps(result, indent=2)
        
    except Exception as e:
        logger.error(f"Error checking availability: {str(e)}")
        return json.dumps({
            "error": f"Failed to check availability: {str(e)}",
            "available": False,
            "productId": product_id,
            "requestedQuantity": quantity
        })

@tool
def reserve_stock(product_id: str, location_id: str, quantity: int, order_id: str = None) -> str:
    """Reserve inventory for orders at a specific location."""
    try:
        inventory_table = dynamodb.Table('supplysense-inventory')
        
        # Get current inventory
        response = inventory_table.get_item(
            Key={'productId': product_id, 'locationId': location_id}
        )
        
        if 'Item' not in response:
            return json.dumps({
                "success": False,
                "reason": "Product not found at specified location",
                "productId": product_id,
                "locationId": location_id,
                "requestedQuantity": quantity
            })
        
        item = response['Item']
        available_stock = item.get('availableStock', 0)
        
        if available_stock < quantity:
            return json.dumps({
                "success": False,
                "reason": "Insufficient stock available",
                "productId": product_id,
                "locationId": location_id,
                "requestedQuantity": quantity,
                "availableStock": available_stock,
                "shortfall": quantity - available_stock
            })
        
        # Update inventory - reserve stock
        new_reserved = item.get('reservedStock', 0) + quantity
        new_available = available_stock - quantity
        
        inventory_table.update_item(
            Key={'productId': product_id, 'locationId': location_id},
            UpdateExpression='SET reservedStock = :reserved, availableStock = :available, lastUpdated = :timestamp',
            ExpressionAttributeValues={
                ':reserved': new_reserved,
                ':available': new_available,
                ':timestamp': json.dumps({"timestamp": "now"}, default=str)
            }
        )
        
        result = {
            "success": True,
            "productId": product_id,
            "locationId": location_id,
            "reservedQuantity": quantity,
            "orderId": order_id or "manual-reservation",
            "remainingAvailable": new_available,
            "totalReserved": new_reserved,
            "timestamp": json.dumps({"timestamp": "now"}, default=str)
        }
        
        return json.dumps(result, indent=2)
        
    except Exception as e:
        logger.error(f"Error reserving stock: {str(e)}")
        return json.dumps({
            "error": f"Failed to reserve stock: {str(e)}",
            "success": False,
            "productId": product_id,
            "locationId": location_id,
            "requestedQuantity": quantity
        })

def _build_agent() -> Agent:
    """Build the Inventory Intelligence Agent."""
    model_id = os.getenv("BEDROCK_MODEL_ID", "amazon.nova-pro-v1:0")
    model = BedrockModel(model_id=model_id)
    
    system_prompt = """You are the Inventory Intelligence Agent for SupplySense supply chain management system.

Your role is to analyze inventory levels, check product availability, and provide reorder recommendations.

You have access to real-time inventory data across multiple warehouses through your tools:
- check_order_fulfillment_capacity: Check if current inventory can fulfill ALL pending orders (USE THIS for "all orders" questions)
- analyze_inventory: Get comprehensive inventory status
- check_availability: Check if specific products are available
- reserve_stock: Reserve inventory for orders

When analyzing inventory:
1. Use the tools to get actual data
2. Provide specific insights about stock levels, shortages, and reorder needs
3. Give confidence scores based on data completeness
4. Include actionable recommendations

Be concise but thorough. Always use tools to get real data rather than guessing."""
    
    return Agent(
        model=model,
        tools=[
            check_order_fulfillment_capacity,
            analyze_inventory,
            check_availability,
            reserve_stock,
        ],
        system_prompt=system_prompt
    )

_agent = _build_agent()

@app.entrypoint
def inventory_agent(request: RequestContext) -> Dict[str, Any]:
    """AgentCore entrypoint for inventory agent - matches SpendOptimo exactly."""
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