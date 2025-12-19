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


def _to_float(value: Any) -> float:
    if isinstance(value, Decimal):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


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
    for index, product_id in enumerate(product_ids):
        allocated = base_qty if index < len(product_ids) - 1 else max(remaining, 0)
        normalized.append({
            'productId': product_id,
            'quantity': max(allocated, 0)
        })
        remaining -= allocated

    return normalized


def _summarize_demand_payload(payload: Dict[str, Any], base_summary: str | None = None) -> Dict[str, Any]:
    """Shape demand analytics into a structured insight."""
    total_orders = payload.get('totalPendingOrders') or payload.get('totalOrders') or 0
    orders_with_line_items = payload.get('ordersWithLineItems') or payload.get('ordersEvaluated') or total_orders
    revenue_at_risk = payload.get('revenueAtRisk') or payload.get('totalOrderValue') or 0.0
    margin_at_risk = payload.get('marginAtRisk') or round(float(revenue_at_risk) * 0.32, 2)
    avg_order_size = payload.get('averageOrderSize')
    demand_trend = payload.get('demandTrend') or payload.get('recommendation') or ''
    surge_detected = bool(payload.get('surgeDetected'))
    high_demand_products = payload.get('highDemandProducts') or payload.get('productSurges') or []
    high_demand_products = high_demand_products if isinstance(high_demand_products, list) else []

    status = 'surge' if surge_detected or (isinstance(demand_trend, str) and 'high' in demand_trend.lower()) else 'insight'

    # Build highlight summary (2-3 sentences)
    highlight_lines: List[str] = []
    if revenue_at_risk:
        highlight_lines.append(f"Revenue at risk this cycle: ${float(revenue_at_risk):,.0f}.")
    if margin_at_risk:
        highlight_lines.append(f"Estimated margin exposure: ${float(margin_at_risk):,.0f}.")
    if demand_trend:
        highlight_lines.append(f"Demand outlook: {demand_trend}.")
    
    highlight_summary = ' '.join(highlight_lines).strip() or "Demand analysis complete."
    
    # Build detailed summary (5-8 sentences)
    detailed_lines: List[str] = []
    detailed_lines.append(f"Analysis of pending orders reveals total revenue at risk of ${float(revenue_at_risk):,.0f} with an estimated margin exposure of ${float(margin_at_risk):,.0f}.")
    
    if demand_trend:
        detailed_lines.append(f"The demand outlook is {demand_trend.lower()}.")
    
    if surge_detected:
        detailed_lines.append("A demand surge has been detected against historical baseline, requiring immediate attention.")
    else:
        detailed_lines.append("No unusual demand patterns or surges have been detected in the current cycle.")
    
    if high_demand_products:
        top_products_detail = []
        for item in high_demand_products[:3]:
            if isinstance(item, dict) and item.get('productId'):
                qty = item.get('orderedQuantity', 0)
                value = item.get('totalValue', 0)
                orders = item.get('orderCount', 0)
                if qty and value:
                    top_products_detail.append(f"{item['productId']} with {qty} units ordered across {orders} orders (${float(value):,.0f} value)")
                else:
                    top_products_detail.append(f"{item['productId']}")
        if top_products_detail:
            detailed_lines.append(f"Top demand drivers include {', '.join(top_products_detail)}.")
    
    if avg_order_size:
        detailed_lines.append(f"Average order size is {avg_order_size:.1f} items per order across {total_orders} pending orders.")
    
    if orders_with_line_items < total_orders:
        detailed_lines.append(f"{total_orders - orders_with_line_items} orders lack complete line-item data, which may impact forecast accuracy.")
    
    confidence_score = payload.get('confidence', 0.78 if surge_detected else 0.82)
    detailed_lines.append(f"Demand forecasting confidence is {int(confidence_score * 100)}% based on data completeness and historical patterns.")
    
    detailed_summary = ' '.join(detailed_lines).strip()

    risk_signals: List[str] = []
    if surge_detected:
        risk_signals.append("Demand surge flagged against historical baseline.")
    if orders_with_line_items < total_orders:
        risk_signals.append(
            f"{total_orders - orders_with_line_items} order(s) missing SKU detail; forecast confidence reduced."
        )

    recommendations: List[str] = []
    if surge_detected:
        recommendations.append("Align procurement with surge SKUs to prevent stockouts.")
        recommendations.append("Adjust demand forecasts and margin protections for impacted products.")
    else:
        recommendations.append("Maintain current fulfillment plan; monitor run-rate weekly.")
    if high_demand_products:
        recommendations.append("Prioritize production/allocation for highlighted high-velocity SKUs.")

    metrics = {
        'totalPendingOrders': total_orders,
        'ordersWithLineItems': orders_with_line_items,
        'revenueAtRisk': revenue_at_risk,
        'marginAtRisk': margin_at_risk,
        'averageOrderSize': avg_order_size,
        'highDemandProductCount': len(high_demand_products),
    }

    return {
        'status': status,
        'summary': highlight_summary,  # For Agent Highlights
        'highlightSummary': highlight_summary,  # Explicit field
        'detailedSummary': detailed_summary,  # For Agent Insights
        'metrics': metrics,
        'riskSignals': risk_signals,
        'highDemandProducts': high_demand_products,
        'recommendations': recommendations,
        'confidence': payload.get('confidence', 0.78 if surge_detected else 0.82),
    }

@tool
def analyze_demand_for_pending_orders() -> str:
    """Analyze demand patterns and forecast needs for ALL pending orders. Use this when asked about fulfilling all/multiple orders."""
    try:
        orders_table = dynamodb.Table('supplysense-orders')
        forecast_table = dynamodb.Table('supplysense-demand-forecast')
        
        # Get all pending orders
        orders_response = orders_table.scan(
            FilterExpression='#status = :status',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':status': 'pending'}
        )
        pending_orders = orders_response.get('Items', [])
        
        if not pending_orders:
            return json.dumps({
                "message": "No pending orders to analyze",
                "totalOrders": 0
            })
        
        # Analyze demand patterns
        product_orders: Dict[str, Dict[str, Any]] = {}
        total_value = 0.0
        total_units_ordered = 0
        orders_with_line_items = 0
        for order in pending_orders:
            normalized_items = _normalize_order_items(order)
            total_line_quantity = sum(item['quantity'] for item in normalized_items)
            order_value = _to_float(order.get('value', 0))
            unit_price_hint = (order_value / total_line_quantity) if total_line_quantity else _to_float(order.get('unitPrice', 50))

            if normalized_items:
                orders_with_line_items += 1
                total_units_ordered += total_line_quantity

            for item in normalized_items:
                product_id = item['productId']
                quantity = item['quantity']
                unit_price = _to_float(item.get('unitPrice', unit_price_hint or 50))
                
                if product_id not in product_orders:
                    product_orders[product_id] = {
                        "totalQuantity": 0,
                        "totalValue": 0.0,
                        "orderCount": 0
                    }
                
                product_orders[product_id]["totalQuantity"] += quantity
                product_orders[product_id]["totalValue"] += quantity * unit_price
                product_orders[product_id]["orderCount"] += 1
                total_value += quantity * unit_price
        
        if not product_orders:
            return json.dumps({
                "message": "Pending orders are missing line-item details. Unable to analyze demand.",
                "totalOrders": len(pending_orders)
            }, indent=2)

        # Get demand forecasts for context
        high_demand_products = []
        for product_id, stats in product_orders.items():
            if stats["totalQuantity"] > 10:  # Threshold for high demand
                high_demand_products.append({
                    "productId": product_id,
                    "orderedQuantity": stats["totalQuantity"],
                    "orderCount": stats["orderCount"],
                    "totalValue": stats["totalValue"]
                })
        
        # Calculate demand metrics
        avg_order_size = 0.0
        if pending_orders:
            total_line_items = sum(len(_normalize_order_items(o)) for o in pending_orders)
            avg_order_size = total_line_items / len(pending_orders) if total_line_items else 0.0
        
        demand_trend = "Stable" if len(pending_orders) < 30 else "High"
        orders_missing_line_items = len(pending_orders) - orders_with_line_items
        revenue_at_risk = round(total_value, 2)
        margin_at_risk = round(revenue_at_risk * 0.32, 2)
        demand_velocity = round(total_units_ordered / max(orders_with_line_items, 1), 2) if orders_with_line_items else None

        return json.dumps({
            "totalPendingOrders": len(pending_orders),
            "ordersWithLineItems": orders_with_line_items,
            "uniqueProducts": len(product_orders),
            "totalOrderValue": revenue_at_risk,
            "averageOrderSize": round(avg_order_size, 2),
            "highDemandProducts": high_demand_products[:5],  # Top 5
            "demandTrend": demand_trend,
            "recommendation": f"Current demand is {'manageable' if len(pending_orders) < 30 else 'elevated'} with {len(pending_orders)} pending orders",
            "revenueAtRisk": revenue_at_risk,
            "marginAtRisk": margin_at_risk,
            "ordersMissingLineItems": orders_missing_line_items,
            "demandVelocity": demand_velocity,
            "confidence": 0.83 if orders_missing_line_items == 0 else 0.75
        }, indent=2)
        
    except Exception as e:
        logger.error(f"Error analyzing demand for pending orders: {str(e)}")
        return json.dumps({"error": f"Failed to analyze demand: {str(e)}"})

@tool
def forecast_demand(product_id: str, timeframe: str, include_seasonality: bool = True) -> str:
    """Generate demand forecast for products based on historical data and patterns."""
    try:
        # Get historical orders data
        orders_table = dynamodb.Table('supplysense-orders')
        forecast_table = dynamodb.Table('supplysense-demand-forecast')
        
        # Scan orders for the product
        orders_response = orders_table.scan(
            FilterExpression='contains(productIds, :productId)',
            ExpressionAttributeValues={':productId': product_id}
        )
        orders = orders_response.get('Items', [])
        
        # Get existing forecasts
        forecast_response = forecast_table.query(
            KeyConditionExpression='productId = :productId',
            ExpressionAttributeValues={':productId': product_id}
        )
        existing_forecasts = forecast_response.get('Items', [])
        
        # Analyze historical demand
        total_historical_demand = sum(int(order.get('quantity', 0)) for order in orders)
        avg_order_size = total_historical_demand / max(len(orders), 1)
        
        # Generate forecast based on timeframe
        forecast_periods = []
        base_demand = avg_order_size
        
        if timeframe.lower() == 'weekly':
            periods = 4  # 4 weeks
            period_label = 'week'
        elif timeframe.lower() == 'monthly':
            periods = 3  # 3 months
            period_label = 'month'
        elif timeframe.lower() == 'quarterly':
            periods = 4  # 4 quarters
            period_label = 'quarter'
        else:
            periods = 7  # 7 days (default)
            period_label = 'day'
        
        for i in range(periods):
            # Apply seasonal factors if requested
            seasonal_factor = 1.0
            if include_seasonality:
                # Mock seasonal patterns
                current_month = datetime.now().month
                if current_month in [11, 12]:  # Holiday season
                    seasonal_factor = 1.3
                elif current_month in [6, 7, 8]:  # Summer
                    seasonal_factor = 0.9
                else:
                    seasonal_factor = 1.0
            
            # Apply trend factor (slight growth)
            trend_factor = 1.0 + (i * 0.02)  # 2% growth per period
            
            # Calculate predicted demand
            predicted_demand = int(base_demand * seasonal_factor * trend_factor)
            
            # Calculate confidence based on data quality
            confidence = min(0.95, 0.6 + (len(orders) * 0.05))
            
            forecast_periods.append({
                "period": i + 1,
                "periodLabel": f"{period_label} {i + 1}",
                "predictedDemand": predicted_demand,
                "confidence": round(confidence, 2),
                "seasonalFactor": round(seasonal_factor, 2),
                "trendFactor": round(trend_factor, 2)
            })
        
        # Store forecast in database
        forecast_record = {
            "productId": product_id,
            "forecastDate": datetime.now().strftime('%Y-%m-%d'),
            "timeframe": timeframe,
            "forecastPeriods": forecast_periods,
            "historicalDataPoints": len(orders),
            "avgHistoricalDemand": round(avg_order_size, 2),
            "createdAt": datetime.now().isoformat()
        }
        
        forecast_table.put_item(Item=forecast_record)
        
        # Generate insights
        total_forecast = sum(p["predictedDemand"] for p in forecast_periods)
        avg_confidence = sum(p["confidence"] for p in forecast_periods) / len(forecast_periods)
        
        insights = []
        if avg_confidence > 0.8:
            insights.append("📊 High confidence forecast based on solid historical data")
        elif avg_confidence > 0.6:
            insights.append("📊 Moderate confidence forecast - consider additional data sources")
        else:
            insights.append("⚠️ Low confidence forecast - limited historical data available")
        
        if seasonal_factor > 1.1:
            insights.append("🎄 Seasonal demand increase expected")
        elif seasonal_factor < 0.9:
            insights.append("📉 Seasonal demand decrease expected")
        
        result = {
            "productId": product_id,
            "timeframe": timeframe,
            "forecastSummary": {
                "totalForecastDemand": total_forecast,
                "averagePerPeriod": round(total_forecast / periods, 2),
                "averageConfidence": round(avg_confidence, 2),
                "historicalAverage": round(avg_order_size, 2),
                "growthTrend": "increasing" if trend_factor > 1.0 else "stable"
            },
            "forecastPeriods": forecast_periods,
            "insights": insights,
            "recommendations": [
                f"📦 Ensure inventory can support {total_forecast} units over {periods} {period_label}s",
                f"🔄 Review forecast accuracy after {period_label} 1 completion",
                "📈 Consider demand shaping strategies if capacity constraints exist"
            ],
            "timestamp": datetime.now().isoformat()
        }
        
        return json.dumps(result, indent=2)
        
    except Exception as e:
        logger.error(f"Error forecasting demand: {str(e)}")
        return json.dumps({
            "error": f"Failed to forecast demand: {str(e)}",
            "productId": product_id,
            "timeframe": timeframe
        })

@tool
def analyze_demand_patterns(product_id: str = None, analysis_type: str = "trend") -> str:
    """Analyze historical demand patterns and trends for products."""
    try:
        orders_table = dynamodb.Table('supplysense-orders')
        
        # Get orders data
        if product_id:
            response = orders_table.scan(
                FilterExpression='contains(productIds, :productId)',
                ExpressionAttributeValues={':productId': product_id}
            )
        else:
            response = orders_table.scan()
        
        orders = response.get('Items', [])
        
        if not orders:
            return json.dumps({
                "status": "no_data",
                "message": "No order data found for analysis",
                "productId": product_id,
                "analysisType": analysis_type
            })
        
        # Analyze based on type
        if analysis_type == "trend":
            analysis = analyze_trend_patterns(orders, product_id)
        elif analysis_type == "seasonal":
            analysis = analyze_seasonal_patterns(orders, product_id)
        elif analysis_type == "anomaly":
            analysis = analyze_anomaly_patterns(orders, product_id)
        else:
            analysis = analyze_general_patterns(orders, product_id)
        
        return json.dumps(analysis, indent=2)
        
    except Exception as e:
        logger.error(f"Error analyzing demand patterns: {str(e)}")
        return json.dumps({
            "error": f"Failed to analyze demand patterns: {str(e)}",
            "productId": product_id,
            "analysisType": analysis_type
        })

@tool
def detect_demand_surge(time_window: str = "7days", sensitivity: str = "medium") -> str:
    """Detect unusual demand patterns and surges in recent orders."""
    try:
        orders_table = dynamodb.Table('supplysense-orders')
        
        # Calculate time window
        if time_window == "7days":
            days_back = 7
        elif time_window == "14days":
            days_back = 14
        elif time_window == "30days":
            days_back = 30
        else:
            days_back = 7
        
        cutoff_date = (datetime.now() - timedelta(days=days_back)).isoformat()
        
        # Get recent orders
        response = orders_table.scan(
            FilterExpression='orderDate >= :cutoff',
            ExpressionAttributeValues={':cutoff': cutoff_date}
        )
        recent_orders = response.get('Items', [])
        
        # Get historical baseline (previous period)
        historical_cutoff = (datetime.now() - timedelta(days=days_back * 2)).isoformat()
        historical_response = orders_table.scan(
            FilterExpression='orderDate >= :historical_cutoff AND orderDate < :cutoff',
            ExpressionAttributeValues={
                ':historical_cutoff': historical_cutoff,
                ':cutoff': cutoff_date
            }
        )
        historical_orders = historical_response.get('Items', [])
        
        # Calculate demand metrics
        recent_total = sum(int(order.get('quantity', 0)) for order in recent_orders)
        historical_total = sum(int(order.get('quantity', 0)) for order in historical_orders)
        
        recent_avg_daily = recent_total / days_back
        historical_avg_daily = historical_total / days_back if historical_total > 0 else recent_avg_daily
        
        # Calculate surge percentage
        if historical_avg_daily > 0:
            surge_percentage = ((recent_avg_daily - historical_avg_daily) / historical_avg_daily) * 100
        else:
            surge_percentage = 0
        
        # Determine surge threshold based on sensitivity
        thresholds = {
            "low": 50,      # 50% increase
            "medium": 30,   # 30% increase
            "high": 15      # 15% increase
        }
        threshold = thresholds.get(sensitivity, 30)
        
        surge_detected = surge_percentage > threshold
        
        # Analyze by product
        product_analysis = {}
        for order in recent_orders:
            for product_id in order.get('productIds', []):
                if product_id not in product_analysis:
                    product_analysis[product_id] = {"recent": 0, "historical": 0}
                product_analysis[product_id]["recent"] += int(order.get('quantity', 0))
        
        for order in historical_orders:
            for product_id in order.get('productIds', []):
                if product_id not in product_analysis:
                    product_analysis[product_id] = {"recent": 0, "historical": 0}
                product_analysis[product_id]["historical"] += int(order.get('quantity', 0))
        
        # Identify products with surges
        product_surges = []
        for product_id, data in product_analysis.items():
            if data["historical"] > 0:
                product_surge = ((data["recent"] - data["historical"]) / data["historical"]) * 100
                if product_surge > threshold:
                    product_surges.append({
                        "productId": product_id,
                        "surgePercentage": round(product_surge, 1),
                        "recentDemand": data["recent"],
                        "historicalDemand": data["historical"]
                    })
        
        # Generate recommendations
        recommendations = []
        if surge_detected:
            recommendations.extend([
                "🚨 Demand surge detected - review inventory levels immediately",
                "📞 Contact suppliers for expedited delivery if needed",
                "📊 Analyze root cause of demand increase",
                "🎯 Consider dynamic pricing or demand shaping strategies"
            ])
        else:
            recommendations.append("✅ No significant demand surges detected")
        
        result = {
            "surgeDetected": surge_detected,
            "surgeLevel": "HIGH" if surge_percentage > 50 else "MEDIUM" if surge_percentage > 20 else "LOW",
            "overallSurgePercentage": round(surge_percentage, 1),
            "timeWindow": time_window,
            "sensitivity": sensitivity,
            "threshold": threshold,
            "demandMetrics": {
                "recentAvgDaily": round(recent_avg_daily, 2),
                "historicalAvgDaily": round(historical_avg_daily, 2),
                "recentTotal": recent_total,
                "historicalTotal": historical_total,
                "recentOrderCount": len(recent_orders),
                "historicalOrderCount": len(historical_orders)
            },
            "productSurges": sorted(product_surges, key=lambda x: x["surgePercentage"], reverse=True),
            "recommendations": recommendations,
            "timestamp": datetime.now().isoformat()
        }
        
        return json.dumps(result, indent=2)
        
    except Exception as e:
        logger.error(f"Error detecting demand surge: {str(e)}")
        return json.dumps({
            "error": f"Failed to detect demand surge: {str(e)}",
            "timeWindow": time_window,
            "sensitivity": sensitivity
        })

# Helper functions for pattern analysis
def analyze_trend_patterns(orders, product_id):
    """Analyze trend patterns in demand data."""
    # Group orders by week
    weekly_demand = {}
    for order in orders:
        order_date = order.get('orderDate', '')
        if order_date:
            # Simple week grouping (would use proper date parsing in production)
            week_key = order_date[:10]  # Use date as week key for simplicity
            if week_key not in weekly_demand:
                weekly_demand[week_key] = 0
            weekly_demand[week_key] += int(order.get('quantity', 0))
    
    # Calculate trend
    weeks = sorted(weekly_demand.keys())
    if len(weeks) >= 2:
        recent_avg = sum(weekly_demand[week] for week in weeks[-2:]) / 2
        older_avg = sum(weekly_demand[week] for week in weeks[:-2]) / max(len(weeks) - 2, 1)
        trend_direction = "increasing" if recent_avg > older_avg * 1.1 else "decreasing" if recent_avg < older_avg * 0.9 else "stable"
        trend_percentage = ((recent_avg - older_avg) / older_avg * 100) if older_avg > 0 else 0
    else:
        trend_direction = "insufficient_data"
        trend_percentage = 0
    
    return {
        "analysisType": "trend",
        "productId": product_id,
        "trendDirection": trend_direction,
        "trendPercentage": round(trend_percentage, 1),
        "weeklyDemand": weekly_demand,
        "totalWeeks": len(weeks),
        "insights": [
            f"📈 Demand trend is {trend_direction}",
            f"📊 {trend_percentage:+.1f}% change in recent periods" if trend_percentage != 0 else "📊 Stable demand pattern"
        ]
    }

def analyze_seasonal_patterns(orders, product_id):
    """Analyze seasonal patterns in demand data."""
    monthly_demand = {}
    for order in orders:
        order_date = order.get('orderDate', '')
        if order_date and len(order_date) >= 7:
            month_key = order_date[:7]  # YYYY-MM
            if month_key not in monthly_demand:
                monthly_demand[month_key] = 0
            monthly_demand[month_key] += int(order.get('quantity', 0))
    
    # Identify seasonal patterns (mock analysis)
    peak_months = sorted(monthly_demand.items(), key=lambda x: x[1], reverse=True)[:3]
    
    return {
        "analysisType": "seasonal",
        "productId": product_id,
        "monthlyDemand": monthly_demand,
        "peakMonths": [{"month": month, "demand": demand} for month, demand in peak_months],
        "seasonalPattern": "holiday_peak" if any("12" in month or "11" in month for month, _ in peak_months) else "summer_peak",
        "insights": [
            "🎄 Holiday season shows increased demand" if any("12" in month or "11" in month for month, _ in peak_months) else "☀️ Summer season shows peak demand",
            f"📊 Peak demand in {peak_months[0][0]} with {peak_months[0][1]} units"
        ]
    }

def analyze_anomaly_patterns(orders, product_id):
    """Analyze anomaly patterns in demand data."""
    daily_demand = {}
    for order in orders:
        order_date = order.get('orderDate', '')[:10] if order.get('orderDate') else 'unknown'
        if order_date not in daily_demand:
            daily_demand[order_date] = 0
        daily_demand[order_date] += int(order.get('quantity', 0))
    
    # Calculate average and identify anomalies
    demands = list(daily_demand.values())
    avg_demand = sum(demands) / len(demands) if demands else 0
    anomaly_threshold = avg_demand * 2  # 2x average is anomaly
    
    anomalies = []
    for date, demand in daily_demand.items():
        if demand > anomaly_threshold:
            anomalies.append({"date": date, "demand": demand, "multiplier": round(demand / avg_demand, 1)})
    
    return {
        "analysisType": "anomaly",
        "productId": product_id,
        "averageDailyDemand": round(avg_demand, 2),
        "anomalyThreshold": round(anomaly_threshold, 2),
        "anomaliesDetected": len(anomalies),
        "anomalies": sorted(anomalies, key=lambda x: x["demand"], reverse=True),
        "insights": [
            f"🔍 {len(anomalies)} demand anomalies detected",
            f"📊 Average daily demand: {avg_demand:.1f} units",
            "⚠️ High variability in demand patterns" if len(anomalies) > 3 else "✅ Relatively stable demand patterns"
        ]
    }

def analyze_general_patterns(orders, product_id):
    """General pattern analysis combining multiple aspects."""
    total_orders = len(orders)
    total_demand = sum(int(order.get('quantity', 0)) for order in orders)
    avg_order_size = total_demand / total_orders if total_orders > 0 else 0
    
    return {
        "analysisType": "general",
        "productId": product_id,
        "totalOrders": total_orders,
        "totalDemand": total_demand,
        "averageOrderSize": round(avg_order_size, 2),
        "demandVolatility": "high" if total_orders > 0 and (max(int(o.get('quantity', 0)) for o in orders) / avg_order_size > 3) else "low",
        "insights": [
            f"📊 {total_orders} orders analyzed with {total_demand} total units",
            f"📦 Average order size: {avg_order_size:.1f} units",
            "📈 Consistent ordering patterns" if total_orders > 5 else "⚠️ Limited order history available"
        ]
    }

def _build_agent() -> Agent:
    """Build the Demand Forecasting Agent."""
    model_id = os.getenv("BEDROCK_MODEL_ID", "amazon.nova-lite-v1:0")
    model = BedrockModel(model_id=model_id)
    
    system_prompt = """You are the Demand Forecasting Agent for SupplySense supply chain management system.

Your role is to generate demand forecasts, identify patterns, and detect demand surges.

You have access to historical order data and forecasting tools:
- analyze_demand_for_pending_orders: Analyze demand for ALL pending orders (USE THIS for "all orders" questions)
- forecast_demand: Generate statistical demand forecasts
- analyze_demand_patterns: Identify trends and seasonality
- detect_demand_surge: Detect unusual demand patterns

IMPORTANT - RESPONSE FORMAT:
You MUST respond in the following JSON structure. Use the tools to get actual data, then format your response as:

{
  "highlightSummary": "A concise 2-3 sentence summary of key demand findings (e.g., 'Revenue at risk this cycle: $8,050. Estimated margin exposure: $2,576. Demand outlook: Stable with top drivers being PROD-001, PROD-003, and PROD-002.')",
  "detailedSummary": "A comprehensive 5-8 sentence analysis explaining demand patterns, revenue impact, high-demand products, and forecasting insights. Include specific product IDs, quantities, revenue figures, and trend analysis. (e.g., 'Analysis of pending orders reveals total revenue at risk of $8,050 with an estimated margin exposure of $2,576. The demand outlook remains stable with no significant surges detected. Top demand drivers include PROD-001 with 105 units ordered across 2 orders ($5,250 value), PROD-003 with 30 units ($1,800 value), and PROD-002 with 20 units ($1,000 value). Average order size is 1.33 items per order across 3 pending orders. No unusual demand patterns or surges have been detected in the current cycle. Demand forecasting confidence is high at 83% based on complete order data availability.')",
  "status": "insight" or "data_gap" based on data completeness,
  "confidence": 0.0 to 1.0 confidence score,
  "blockers": ["List of specific blockers if any, e.g., 'Incomplete historical data for PROD-004'"],
  "recommendations": ["Actionable recommendations, e.g., 'Maintain current fulfillment plan', 'Prioritize high-velocity SKUs'"],
  "analysis": "Additional demand insights beyond the summaries"
}

CRITICAL REQUIREMENTS:
1. ALWAYS use tools first to get actual data before responding
2. highlightSummary MUST be 2-3 sentences, concise and factual
3. detailedSummary MUST be 5-8 sentences, comprehensive with specific product IDs, quantities, and revenue figures
4. Include actual data from tools (product IDs, order counts, revenue, margin exposure)
5. status should be "insight" for normal analysis, "data_gap" if data is incomplete
6. Be data-driven - reference specific findings from the demand data you accessed

Be data-driven and concise."""
    
    return Agent(
        model=model,
        tools=[
            analyze_demand_for_pending_orders,
            forecast_demand,
            analyze_demand_patterns,
            detect_demand_surge,
        ],
        system_prompt=system_prompt
    )

_agent = _build_agent()

@app.entrypoint
def demand_agent(request: RequestContext) -> Dict[str, Any]:
    """AgentCore entrypoint for demand agent."""
    prompt = (request.get("prompt") or request.get("input") or "").strip()
    logger.info("=" * 80)
    logger.info("DEMAND AGENT - REQUEST RECEIVED")
    logger.info(f"Prompt: {prompt}")
    logger.info("=" * 80)
    
    if not prompt:
        return {
            "brand": "SupplySense",
            "message": "No prompt provided.",
        }
    
    response = _agent(prompt)
    text = response.message["content"][0]["text"]
    
    logger.info("DEMAND AGENT - RAW LLM RESPONSE")
    logger.info(f"Response:\n{text}")
    logger.info("=" * 80)
    
    # Clean up hidden reasoning tags
    import re
    clean_text = re.sub(r'<(thinking|analysis|response)>.*?</\1>', '', text, flags=re.DOTALL | re.IGNORECASE).strip()
    clean_text = re.sub(r'</?(thinking|analysis|response)>', '', clean_text, flags=re.IGNORECASE).strip()

    normalized_payload: Dict[str, Any] | None = None
    try:
        parsed = json.loads(clean_text)
        if isinstance(parsed, dict):
            normalized_payload = parsed
            logger.info(f"DEMAND AGENT - Parsed JSON with keys: {list(parsed.keys())}")
    except json.JSONDecodeError:
        logger.warning("DEMAND AGENT - JSON parse failed")
        normalized_payload = None

    prompt_lower = prompt.lower()
    needs_structured = normalized_payload is None or ('highlightSummary' not in normalized_payload and any(keyword in prompt_lower for keyword in ('fulfill', 'all order', 'pending order', 'demand', 'forecast')))

    if needs_structured:
        try:
            demand_raw = analyze_demand_for_pending_orders()
            parsed_demand = json.loads(demand_raw)
            if isinstance(parsed_demand, dict):
                normalized_payload = parsed_demand
        except Exception as exc:
            logger.warning("Demand aggregation recalculation failed: %s", exc, exc_info=True)

    if isinstance(normalized_payload, dict):
        # If LLM already provided both summaries, use them directly
        if 'highlightSummary' in normalized_payload and 'detailedSummary' in normalized_payload:
            logger.info("DEMAND AGENT - Using LLM-provided summaries directly")
            final_response = json.dumps(normalized_payload, indent=2)
        else:
            logger.info("DEMAND AGENT - Creating structured response from tool data")
            summary_payload = _summarize_demand_payload(normalized_payload, base_summary=None if needs_structured else clean_text)
            final_response = json.dumps(summary_payload, indent=2)
    else:
        final_response = clean_text

    logger.info("DEMAND AGENT - FINAL RESPONSE")
    logger.info(f"Response:\n{final_response}")
    logger.info("=" * 80)

    return {
        "brand": "SupplySense",
        "message": final_response,
    }

if __name__ == "__main__":
    app.run()