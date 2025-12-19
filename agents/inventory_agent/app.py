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


def _extract_summaries_from_llm_response(text: str | None) -> tuple[str | None, str | None]:
    """Extract highlight summary and detailed summary from LLM response text.
    
    Returns (highlight_summary, detailed_summary). If structured summaries aren't found,
    uses the full LLM response as detailed_summary.
    """
    if not text:
        return None, None
    
    highlight_summary = None
    detailed_summary = None
    
    # Try to parse as JSON first
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            highlight_summary = parsed.get('highlightSummary') or parsed.get('highlight')
            detailed_summary = parsed.get('detailedSummary') or parsed.get('detailed')
            # If both are found but they're identical, use full response for detailed
            if highlight_summary and detailed_summary:
                if highlight_summary.strip() == detailed_summary.strip():
                    # They're the same - use full response for detailed to ensure difference
                    detailed_summary = text.strip()
                return highlight_summary, detailed_summary
            # If only one is found, still return it
            if highlight_summary or detailed_summary:
                return highlight_summary, detailed_summary
    except:
        pass
    
    # Try to extract from text patterns
    import re
    highlight_patterns = [
        r'(?i)highlight\s+summary[:\-]\s*(.+?)(?=\n\s*(?:detailed|summary|$))',
        r'(?i)highlight[:\-]\s*(.+?)(?=\n\s*(?:detailed|summary|$))',
    ]
    detailed_patterns = [
        r'(?i)detailed\s+summary[:\-]\s*(.+?)(?=\n\s*(?:highlight|summary|$))',
        r'(?i)detailed[:\-]\s*(.+?)(?=\n\s*(?:highlight|summary|$))',
    ]
    
    for pattern in highlight_patterns:
        match = re.search(pattern, text, re.DOTALL)
        if match:
            highlight_summary = match.group(1).strip()
            break
    
    for pattern in detailed_patterns:
        match = re.search(pattern, text, re.DOTALL)
        if match:
            detailed_summary = match.group(1).strip()
            break
    
    # If we couldn't find structured summaries, use the LLM's full response as detailed summary
    # This ensures we always show the LLM's actual response, not static text
    if not detailed_summary and text:
        # Use the full LLM response as detailed summary
        detailed_summary = text.strip()
    
    return highlight_summary, detailed_summary


def _summarize_fulfillment_payload(payload: Dict[str, Any], base_summary: str | None = None) -> Dict[str, Any]:
    """Shape fulfillment payload into a structured inventory insight."""
    can_fulfill = bool(
        payload.get('canFulfillAllOrders')
        or payload.get('canFulfillAll')
        or payload.get('fulfillmentAssessment', {}).get('canFulfill')
    )
    shortages = payload.get('shortages') or payload.get('fulfillmentAssessment', {}).get('shortfalls') or []
    shortages = shortages if isinstance(shortages, list) else []
    shortage_units = sum(
        max(int(item.get('shortage', 0) or item.get('delta', 0) or 0), 0)
        for item in shortages
        if isinstance(item, dict)
    )
    total_orders = (
        payload.get('totalPendingOrders')
        or payload.get('ordersEvaluated')
        or payload.get('orderSummary', {}).get('totalOrders')
    )
    orders_missing = payload.get('ordersMissingLineItems') or []
    orders_missing_count = len(orders_missing) if isinstance(orders_missing, list) else 0

    summary_lines: List[str] = []
    if can_fulfill:
        summary_lines.append(
            f"Inventory coverage is sufficient for {total_orders or 'all'} pending orders."
        )
        if orders_missing_count:
            summary_lines.append(
                f"Line-item data is missing for {orders_missing_count} order(s); monitoring recommended."
            )
    else:
        if shortage_units > 0:
            summary_lines.append(
                f"Inventory gaps across {len(shortages)} SKU(s) totaling {shortage_units} units."
            )
        else:
            summary_lines.append("Inventory shortfalls detected for pending orders.")
        if orders_missing_count:
            summary_lines.append(
                f"Line-item detail unavailable for {orders_missing_count} order(s), increasing uncertainty."
            )
    # Extract highlight and detailed summaries from LLM response
    # This is CRITICAL: base_summary contains the LLM's actual response
    highlight_summary, detailed_summary = _extract_summaries_from_llm_response(base_summary)
    
    # Log what we extracted for debugging
    logger.info("Inventory agent - base_summary length: %d, highlight found: %s, detailed found: %s", 
                len(base_summary) if base_summary else 0, 
                bool(highlight_summary), 
                bool(detailed_summary))
    
    # For highlight summary: prefer LLM's highlight, fallback to constructed summary_lines
    if highlight_summary:
        final_summary = highlight_summary
    elif summary_lines:
        final_summary = ' '.join(summary_lines).strip()
    elif base_summary:
        # If no structured highlight found, use first part of LLM response as highlight
        final_summary = base_summary.split('\n')[0].strip() if base_summary else ''
    else:
        final_summary = ''
    
    # For detailed summary: ALWAYS use LLM's FULL response if available
    # This ensures Agent Insights shows the LLM's complete analysis, not a one-liner
    if not detailed_summary and base_summary:
        # Use the FULL LLM response as detailed summary - this is what the user wants to see
        detailed_summary = base_summary.strip()
        logger.info("Using full LLM response as detailed summary (length: %d)", len(detailed_summary))
    
    # CRITICAL: If highlight and detailed are the same, use full LLM response for detailed
    # This ensures they're always different
    if detailed_summary and final_summary and detailed_summary.strip() == final_summary.strip():
        logger.info("Highlight and detailed are identical, using full LLM response for detailed")
        if base_summary:
            detailed_summary = base_summary.strip()

    blockers: List[str] = []
    for item in shortages:
        product_id = item.get('productId') or item.get('sku')
        shortage = item.get('shortage') or item.get('delta')
        if product_id and shortage is not None:
            blockers.append(f"{product_id} shortage ({shortage} units)")

    recommendations: List[str] = []
    if not can_fulfill:
        recommendations.extend([
            "Activate emergency replenishment for shortage SKUs.",
            "Align procurement and logistics on mitigation timeline.",
        ])
    else:
        recommendations.append("Proceed with fulfillment; monitor high-velocity SKUs for restock.")
    if orders_missing_count:
        recommendations.append("Augment order data with SKU-level detail to improve accuracy.")

    metrics = {
        'totalPendingOrders': total_orders,
        'shortageUnits': shortage_units,
        'shortageSkuCount': len(shortages),
        'ordersMissingLineItems': orders_missing_count,
        'productsWithSufficientStock': payload.get('productsWithSufficientStock'),
    }

    # Determine status: if there are shortages, it's shortfall regardless of can_fulfill
    # This ensures consistency between highlight, insights, and metrics
    final_status = 'shortfall' if (shortages and len(shortages) > 0) else ('sufficient' if can_fulfill else 'shortfall')
    
    result = {
        'status': final_status,  # Use consistent status based on actual shortages
        'summary': final_summary,  # Highlight summary for Agent Highlights
        'blockers': blockers,
        'metrics': metrics,
        'shortages': shortages,
        'recommendations': recommendations,
        'confidence': 0.88 if can_fulfill else 0.7 if shortage_units else 0.6,
    }
    
    # ALWAYS include detailed summary - use LLM's response (detailed_summary or base_summary)
    # This ensures Agent Insights shows the LLM's actual analysis, not static text
    if detailed_summary:
        result['detailedSummary'] = detailed_summary
    elif base_summary:
        # Fallback: use full LLM response as detailed summary
        result['detailedSummary'] = base_summary.strip()
    elif final_summary:
        # Last resort: use highlight as detailed (shouldn't happen if LLM responded)
        result['detailedSummary'] = final_summary
    
    return result


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

IMPORTANT - RESPONSE FORMAT:
You MUST respond in the following JSON structure. Use the tools to get actual data, then format your response as:

{
  "highlightSummary": "A concise 2-3 sentence summary of key findings",
  "detailedSummary": "A comprehensive 5-8 sentence analysis explaining what you analyzed, specific findings, and implications. Include actual numbers, SKU details, and context from the data you accessed.",
  "status": "sufficient" or "shortfall" based on whether inventory can fulfill ALL orders (if ANY product has shortage, status MUST be "shortfall"),
  "confidence": 0.0 to 1.0 confidence score based on data completeness,
  "blockers": ["List of specific blockers, e.g., 'PROD-003 shortage (30 units)'"],
  "recommendations": ["Actionable recommendations, e.g., 'Activate emergency replenishment for shortage SKUs.'"],
  "analysis": "Additional analysis or insights beyond the summaries"
}

CRITICAL REQUIREMENTS:
1. ALWAYS use tools first to get actual data before responding
2. highlightSummary MUST be 2-3 sentences, concise and factual
3. detailedSummary MUST be 5-8 sentences, comprehensive with specific numbers and SKU details
4. Include actual data from tools (SKU IDs, quantities, order IDs, etc.) in your summaries
5. Be data-driven - reference specific findings from the inventory data you accessed
6. status MUST be "shortfall" if ANY product has insufficient inventory, even if other products are sufficient
7. NEVER say "can fulfill all orders" if there are ANY shortages - be precise and accurate
8. If you cannot access data, indicate this in your response but still provide the required JSON structure

Be thorough and accurate. Always use tools to get real data rather than guessing."""
    
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
    """AgentCore entrypoint for inventory agent."""
    prompt = (request.get("prompt") or request.get("input") or "").strip()
    logger.info("=" * 80)
    logger.info("INVENTORY AGENT - REQUEST RECEIVED")
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
    logger.info("INVENTORY AGENT - RAW LLM RESPONSE")
    logger.info(f"Response length: {len(text)} characters")
    logger.info(f"Raw response:\n{text}")
    logger.info("=" * 80)
    
    # Clean up hidden reasoning tags and other artifacts
    import re
    clean_text = re.sub(r'<(thinking|analysis|response)>.*?</\1>', '', text, flags=re.DOTALL | re.IGNORECASE).strip()
    clean_text = re.sub(r'</?(thinking|analysis|response)>', '', clean_text, flags=re.IGNORECASE).strip()
    
    logger.info("INVENTORY AGENT - CLEANED RESPONSE")
    logger.info(f"Cleaned text:\n{clean_text}")
    logger.info("=" * 80)

    # Try to parse as JSON
    normalized_payload: Dict[str, Any] | None = None
    try:
        parsed = json.loads(clean_text)
        if isinstance(parsed, dict):
            normalized_payload = parsed
            logger.info("INVENTORY AGENT - PARSED JSON SUCCESSFULLY")
            logger.info(f"JSON keys: {list(parsed.keys())}")
            logger.info(f"Has highlightSummary: {'highlightSummary' in parsed}")
            logger.info(f"Has detailedSummary: {'detailedSummary' in parsed}")
    except json.JSONDecodeError as e:
        logger.warning(f"INVENTORY AGENT - JSON PARSE FAILED: {e}")
        normalized_payload = None

    # If LLM didn't return proper JSON, call the tool directly
    prompt_lower = prompt.lower()
    if normalized_payload is None or ('fulfill' in prompt_lower and 'highlightSummary' not in normalized_payload):
        logger.info("INVENTORY AGENT - Calling check_order_fulfillment_capacity tool")
        try:
            fulfillment_raw = check_order_fulfillment_capacity()
            parsed_fulfillment = json.loads(fulfillment_raw)
            if isinstance(parsed_fulfillment, dict):
                normalized_payload = parsed_fulfillment
                logger.info(f"INVENTORY AGENT - Tool returned data with keys: {list(parsed_fulfillment.keys())}")
        except Exception as exc:
            logger.error(f"INVENTORY AGENT - Tool call failed: {exc}", exc_info=True)

    # Process the payload
    if isinstance(normalized_payload, dict):
        # If LLM already provided both summaries, use them directly
        if 'highlightSummary' in normalized_payload and 'detailedSummary' in normalized_payload:
            logger.info("INVENTORY AGENT - Using LLM-provided summaries directly")
            if 'status' not in normalized_payload:
                normalized_payload['status'] = 'shortfall' if normalized_payload.get('blockers') else 'sufficient'
            if 'confidence' not in normalized_payload:
                normalized_payload['confidence'] = 0.85
            final_response = json.dumps(normalized_payload, indent=2)
        else:
            # Use _summarize_fulfillment_payload to create structured response
            logger.info("INVENTORY AGENT - Creating structured response from tool data")
            summary_payload = _summarize_fulfillment_payload(normalized_payload, base_summary=clean_text)
            logger.info(f"INVENTORY AGENT - Structured payload keys: {list(summary_payload.keys())}")
            logger.info(f"INVENTORY AGENT - Summary length: {len(summary_payload.get('summary', ''))}")
            logger.info(f"INVENTORY AGENT - DetailedSummary length: {len(summary_payload.get('detailedSummary', ''))}")
            final_response = json.dumps(summary_payload, indent=2)
    else:
        logger.error("INVENTORY AGENT - No valid payload to return")
        final_response = clean_text

    logger.info("=" * 80)
    logger.info("INVENTORY AGENT - FINAL RESPONSE")
    logger.info(f"Response:\n{final_response}")
    logger.info("=" * 80)
    
    return {
        "brand": "SupplySense",
        "message": final_response,
    }

if __name__ == "__main__":
    app.run()