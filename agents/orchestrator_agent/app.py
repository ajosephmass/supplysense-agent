from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from statistics import mean
from typing import Any, Dict, List, Optional, Tuple

import boto3
from bedrock_agentcore import BedrockAgentCoreApp, RequestContext
from bedrock_agentcore_starter_toolkit.services.runtime import (
    HttpBedrockAgentCoreClient,
    generate_session_id,
)
from botocore.exceptions import ClientError
from strands import Agent, tool
from strands.models import BedrockModel

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

app = BedrockAgentCoreApp()

# Initialize AWS clients
dynamodb = boto3.resource('dynamodb', region_name=os.environ.get('AWS_REGION', 'us-east-1'))
ssm = boto3.client('ssm', region_name=os.environ.get('AWS_REGION', 'us-east-1'))
http_client = HttpBedrockAgentCoreClient(os.environ.get('AWS_REGION', 'us-east-1'))
_runtime_cache: Dict[str, str] = {}

# DynamoDB table names
ACTIONS_TABLE_NAME = os.environ.get('ACTIONS_TABLE_NAME', 'supplysense-actions')
APPROVALS_TABLE_NAME = os.environ.get('APPROVALS_TABLE_NAME', 'supplysense-approvals')


def _get_completed_actions_global() -> Dict[str, Dict[str, Any]]:
    """
    Scan DynamoDB for ALL completed actions (global, not session-specific).
    Returns a dict keyed by action description for easy lookup.
    This ensures any user sees if an action was already taken by anyone.
    """
    completed = {}
    try:
        table = dynamodb.Table(ACTIONS_TABLE_NAME)
        # Scan for all completed actions (use sparingly, consider GSI for production)
        response = table.scan(
            FilterExpression='#status = :completed',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':completed': 'completed'},
            Limit=100  # Limit to recent actions
        )
        for item in response.get('Items', []):
            description = item.get('description', '')
            # Create a normalized key from description
            key = description.lower().strip()
            # Also track by affected SKUs if available
            payload = item.get('payload') or {}
            data = payload.get('data') or {}
            shortages = data.get('shortages') or []
            affected_skus = sorted([s.get('productId', '') for s in shortages if s.get('productId')])
            if affected_skus:
                key = f"{key}|{','.join(affected_skus)}"
            
            completed[key] = {
                'completedAt': item.get('completedAt'),
                'completedBy': item.get('completedBy'),
                'actionId': item.get('actionId'),
                'sessionId': item.get('sessionId'),
                'description': description,
            }
        logger.info(f"Found {len(completed)} completed actions globally")
    except Exception as e:
        logger.warning(f"Failed to query completed actions: {e}")
    return completed


def _get_decided_approvals_global() -> Dict[str, Dict[str, Any]]:
    """
    Scan DynamoDB for ALL decided approvals (global, not session-specific).
    Returns a dict keyed by approval title for easy lookup.
    """
    decided = {}
    try:
        table = dynamodb.Table(APPROVALS_TABLE_NAME)
        # Scan for all decided approvals
        response = table.scan(
            FilterExpression='#status IN (:approved, :rejected)',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':approved': 'approved', ':rejected': 'rejected'},
            Limit=100
        )
        for item in response.get('Items', []):
            title = item.get('title', '')
            key = title.lower().strip()
            decided[key] = {
                'status': item.get('status'),
                'decidedAt': item.get('decisionAt'),
                'decidedBy': item.get('decidedBy'),
                'approvalId': item.get('approvalId'),
                'sessionId': item.get('sessionId'),
                'title': title,
            }
        logger.info(f"Found {len(decided)} decided approvals globally")
    except Exception as e:
        logger.warning(f"Failed to query decided approvals: {e}")
    return decided


def _safe_json_loads(value: str) -> Any:
    try:
        return json.loads(value)
    except Exception:
        return None


def _get_agent_result(agent_results: List[Dict[str, Any]], agent_type: str) -> Dict[str, Any]:
    return next((result for result in agent_results if result.get('agentType') == agent_type), {})


def _aggregate_confidence(agent_results: List[Dict[str, Any]]) -> float | None:
    scores = [result.get('confidence') for result in agent_results if isinstance(result.get('confidence'), (int, float))]
    if not scores:
        return None
    return round(mean(scores), 2)


def _infer_confidence(agent_type: str, structured: Dict[str, Any]) -> float:
    status = (structured.get('status') or '').lower()
    base = 0.8
    status_confidence = {
        'error': 0.25,
        'data_gap': 0.45,
        'shortfall': 0.7,
        'constraint': 0.65,
        'insight': 0.82,
        'clear': 0.9,
        'sufficient': 0.88,
        'surplus': 0.9,
        'high': 0.62,
        'medium': 0.75,
        'low': 0.88,
    }
    base = status_confidence.get(status, base)
    if agent_type == 'inventory' and status in {'shortfall', 'constraint'}:
        base = max(base - 0.05, 0.5)
    if agent_type == 'risk' and status in {'high', 'medium'}:
        base = min(base + 0.05, 0.92)
    if structured.get('blockers'):
        base = max(base - 0.05, 0.4)
    return round(base, 2)


def _append_unique_metric(metrics_section: List[str], entry: str | None) -> None:
    if entry and entry not in metrics_section:
        metrics_section.append(entry)


def _extract_inventory_metrics_from_summary(summary: str) -> List[str]:
    metrics: List[str] = []
    if not summary:
        return metrics
    sku_match = re.search(r'(\d+)\s+SKU', summary, re.IGNORECASE)
    units_match = re.search(r'(\d+)\s+unit', summary, re.IGNORECASE)
    if sku_match:
        metrics.append(f"Shortages mentioned: {sku_match.group(1)} SKU(s)")
    if units_match:
        metrics.append(f"Units impacted: {units_match.group(1)}")
    product_matches = re.findall(r'([A-Z0-9\-]+-\d+)', summary)
    if product_matches:
        metrics.append(f"Products referenced: {', '.join(product_matches[:3])}")
    return metrics


def _extract_demand_metrics_from_summary(summary: str) -> List[str]:
    metrics: List[str] = []
    if not summary:
        return metrics
    revenue_match = re.search(r'\$([\d,]+)', summary)
    order_match = re.search(r'(\d+)\s+order', summary, re.IGNORECASE)
    product_matches = re.findall(r'([A-Z0-9\-]+-\d+)', summary)
    if revenue_match:
        metrics.append(f"Revenue referenced: ${revenue_match.group(1)}")
    if order_match:
        metrics.append(f"Orders referenced: {order_match.group(1)}")
    if product_matches:
        metrics.append(f"Products referenced: {', '.join(product_matches[:3])}")
    return metrics


def _extract_logistics_metrics_from_summary(summary: str) -> List[str]:
    metrics: List[str] = []
    if not summary:
        return metrics
    pct_match = re.findall(r'(\d+\.?\d*)\s*%', summary)
    order_match = re.findall(r'(\d+)\s+order', summary, re.IGNORECASE)
    if pct_match:
        metrics.append(f"Capacity percentages mentioned: {', '.join(pct_match[:3])}%")
    if order_match:
        metrics.append(f"Orders referenced: {', '.join(order_match[:3])}")
    if 'route' in summary.lower():
        metrics.append("Routing requirements mentioned in summary")
    return metrics


def _build_inventory_overview(shortages: List[Dict[str, Any]], total_shortage_units: int, inventory_status: str) -> str:
    parts: List[str] = []
    if shortages:
        parts.append(f"Identified {len(shortages)} shortage SKU(s) totaling {total_shortage_units} units.")
        top_skus = ', '.join(item.get('productId') for item in shortages[:3] if isinstance(item, dict) and item.get('productId'))
        if top_skus:
            parts.append(f"Affected SKUs: {top_skus}.")
    else:
        parts.append("No active inventory shortages detected.")
    if inventory_status:
        parts.append(f"Inventory status: {inventory_status.replace('_', ' ').title()}.")
    return ' '.join(parts).strip()


def _build_demand_overview(
    total_orders: int,
    total_order_value: float,
    revenue_at_risk: float,
    margin_at_risk: float,
    high_demand_products: List[Dict[str, Any]],
    demand_trend: Optional[str],
) -> str:
    parts: List[str] = []
    if total_orders:
        if total_order_value:
            parts.append(f"Analyzed {total_orders} pending order(s) worth ${total_order_value:,.2f}.")
        else:
            parts.append(f"Analyzed {total_orders} pending order(s).")
    if revenue_at_risk:
        parts.append(f"Revenue at risk: ${revenue_at_risk:,.2f}.")
    if margin_at_risk:
        parts.append(f"Margin exposure: ${margin_at_risk:,.2f}.")
    if high_demand_products:
        top = ', '.join(item.get('productId') for item in high_demand_products[:3] if item.get('productId'))
        if top:
            parts.append(f"High-demand products: {top}.")
    if demand_trend:
        parts.append(f"Demand trend: {demand_trend}.")
    return ' '.join(parts).strip()


def _build_logistics_overview(
    total_orders: int,
    orders_with_routes: int,
    orders_needing_routes: int,
    capacity_utilization: Optional[str],
    can_fulfill_flag: Optional[bool],
    logistics_status: str,
) -> str:
    parts: List[str] = []
    if total_orders:
        parts.append(f"{total_orders} pending order(s) assessed.")
    if orders_with_routes:
        parts.append(f"{orders_with_routes} order(s) already have assigned routes.")
    if orders_needing_routes:
        parts.append(f"{orders_needing_routes} order(s) still require routing.")
    if capacity_utilization:
        parts.append(f"Capacity utilization: {capacity_utilization}.")
    if can_fulfill_flag is not None:
        parts.append(f"Logistics can fulfill all orders: {'Yes' if can_fulfill_flag else 'No'}.")
    if logistics_status:
        parts.append(f"Logistics status: {logistics_status.replace('_', ' ').title()}.")
    return ' '.join(parts).strip()


def _build_risk_overview(
    risk_level_label: str,
    risk_overall_score: Optional[float],
    risk_signals: List[str],
) -> str:
    parts: List[str] = []
    if risk_level_label and risk_level_label != 'Not assessed':
        parts.append(f"Risk level: {risk_level_label}.")
    if isinstance(risk_overall_score, (int, float)):
        parts.append(f"Score: {risk_overall_score:.2f}.")
    if risk_signals:
        parts.append(f"Signals: {', '.join(risk_signals[:3])}.")
    return ' '.join(parts).strip()


def _synthesize_summary_with_llm(user_question: str, agent_findings: List[Dict[str, Any]], risk_level: str) -> str:
    """Use LLM to synthesize agent findings into a direct answer to the user's question."""
    logger.info("=" * 60)
    logger.info("SYNTHESIZE SUMMARY - Starting LLM synthesis")
    logger.info(f"User question: {user_question}")
    logger.info(f"Number of agent findings: {len(agent_findings)}")
    logger.info(f"Risk level: {risk_level}")
    
    try:
        # Build context from all agent findings
        findings_context = []
        for finding in agent_findings:
            agent_type = finding.get('agent', 'unknown')
            summary = finding.get('summary', '')
            status = finding.get('status', '')
            insights = finding.get('insights', {})
            overview = insights.get('overview', '')
            blockers = insights.get('blockers', [])
            recommendations = insights.get('recommendations', [])
            
            logger.info(f"Agent {agent_type}: status={status}, summary_len={len(summary)}, overview_len={len(overview) if overview else 0}")
            
            agent_context = f"**{agent_type.upper()} AGENT:**\n"
            agent_context += f"Status: {status}\n"
            if summary:
                agent_context += f"Summary: {summary}\n"
            if overview:
                agent_context += f"Detailed Analysis: {overview}\n"
            if blockers:
                agent_context += f"Blockers: {', '.join(str(b) for b in blockers)}\n"
            if recommendations:
                agent_context += f"Recommendations: {', '.join(str(r) for r in recommendations)}\n"
            findings_context.append(agent_context)
        
        all_findings = "\n".join(findings_context)
        logger.info(f"Total findings context length: {len(all_findings)}")
        
        prompt = f"""You are a supply chain analyst. The user asked: "{user_question}"

Based on the following findings from multiple specialist agents, provide a DIRECT answer to the user's question.

{all_findings}

Overall Risk Level: {risk_level}

CRITICAL INSTRUCTIONS:
1. READ THE AGENT FINDINGS CAREFULLY - they contain the actual data
2. Start with a direct answer to the question (Yes/No if applicable, or the specific information requested)
3. Include specific numbers, SKU IDs, and quantities EXACTLY as stated in the agent findings
4. If agents report shortages or stockouts, you MUST mention them - do NOT say "no stockouts" if agents report shortages
5. Keep the response concise (3-5 sentences) but comprehensive
6. Do NOT contradict the agent findings - if inventory agent says there are shortages, there ARE shortages

Respond with ONLY the summary paragraph, no JSON or formatting."""

        logger.info("Calling _agent_narrative for synthesis...")
        response = _agent_narrative(prompt)
        text = response.message["content"][0]["text"]
        logger.info(f"Raw LLM response length: {len(text)}")
        logger.info(f"Raw LLM response preview: {text[:300]}...")
        
        # Clean up the response
        clean_text = re.sub(r'<(thinking|analysis|response)>.*?</\1>', '', text, flags=re.DOTALL | re.IGNORECASE).strip()
        clean_text = re.sub(r'</?(thinking|analysis|response)>', '', clean_text, flags=re.IGNORECASE).strip()
        
        logger.info(f"Cleaned LLM response length: {len(clean_text)}")
        
        if clean_text and len(clean_text) > 20:
            logger.info(f"SYNTHESIZE SUMMARY - Success: {clean_text[:200]}...")
            return clean_text
        else:
            logger.warning(f"SYNTHESIZE SUMMARY - Response too short or empty: '{clean_text}'")
        
    except Exception as e:
        logger.error(f"SYNTHESIZE SUMMARY - Failed: {e}", exc_info=True)
    
    logger.warning("SYNTHESIZE SUMMARY - Falling back to static summary")
    return ""  # Return empty string to fall back to static summary


def _build_fused_response(payload: Dict[str, Any]) -> Dict[str, Any]:
    agent_results: List[Dict[str, Any]] = payload.get('agentResults') or []
    analysis: Dict[str, Any] = payload.get('analysis') or {}
    session_id: str | None = payload.get('sessionId')
    user_query: str = payload.get('userQuery') or ''
    query_type = (analysis.get('type') or 'general_query').lower()

    inventory_structured = (_get_agent_result(agent_results, 'inventory') or {}).get('structured') or {}
    demand_structured = (_get_agent_result(agent_results, 'demand') or {}).get('structured') or {}
    logistics_structured = (_get_agent_result(agent_results, 'logistics') or {}).get('structured') or {}
    risk_structured = (_get_agent_result(agent_results, 'risk') or {}).get('structured') or {}
    risk_exposure_summary = risk_structured.get('exposureSummary') or risk_structured.get('metrics', {}).get('exposureSummary') or {}

    shortages = inventory_structured.get('metrics', {}).get('shortages', []) or []
    if not shortages:
        inventory_raw = _safe_json_loads(inventory_structured.get('raw') or '')
        if isinstance(inventory_raw, dict):
            shortages = inventory_raw.get('shortages') or inventory_raw.get('metrics', {}).get('shortages') or []
    # Also try to extract from blockers if shortages list is empty
    if not shortages:
        blockers_list = inventory_structured.get('blockers', [])
        for blocker in blockers_list:
            if isinstance(blocker, str) and 'shortage' in blocker.lower():
                # Parse "PROD-XXX shortage (N units)" pattern
                match = re.search(r'(PROD-\d+)\s+shortage\s*\((\d+)\s*units?\)', blocker, re.IGNORECASE)
                if match:
                    shortages.append({'productId': match.group(1), 'shortage': int(match.group(2))})
    logger.info(f"Extracted shortages: {shortages}")
    total_shortage_units = sum(
        item.get('shortage') or item.get('delta') or 0
        for item in shortages
        if isinstance(item, dict)
    )
    shortage_phrases = [
        f"{item['productId']} ({item.get('shortage', item.get('delta', 0))} units)"
        for item in shortages
        if isinstance(item, dict) and item.get('productId')
    ]
    logger.info(f"Total shortage units: {total_shortage_units}, shortage_phrases: {shortage_phrases}")
    # Get status from LLM response first
    inventory_status = (inventory_structured.get('status') or '').lower()
    # CRITICAL: If LLM says "shortfall" OR we have actual shortages, status MUST be shortfall
    # Check LLM's status string for "shortfall" keyword
    llm_status_text = inventory_structured.get('summary') or inventory_structured.get('detailedSummary') or ''
    llm_mentions_shortfall = 'shortfall' in llm_status_text.lower() or 'shortage' in llm_status_text.lower()
    
    # ALWAYS infer status from actual data - shortages take precedence over agent's status
    if shortages and len(shortages) > 0:
        inventory_status = 'shortfall'  # Override agent status if we have actual shortages
    elif llm_mentions_shortfall:
        inventory_status = 'shortfall'  # Override if LLM mentions shortfall
    elif not inventory_status or inventory_status == 'unknown':
        inventory_status = 'adequate'
    
    # has_inventory_shortfall should be True if status is shortfall OR we have shortages
    has_inventory_shortfall = (
        inventory_status in {'shortfall', 'error'} or 
        any('shortage' in (blocker or '').lower() for blocker in inventory_structured.get('blockers', [])) or 
        (shortages and len(shortages) > 0) or
        llm_mentions_shortfall
    )

    demand_metrics = demand_structured.get('metrics', {}) or {}
    if not demand_metrics:
        demand_raw = _safe_json_loads(demand_structured.get('raw') or '')
        if isinstance(demand_raw, dict):
            demand_metrics = demand_raw.get('metrics') or demand_raw
    high_demand_products = demand_metrics.get('highDemandProducts') or []
    demand_total_pending_orders = int(demand_metrics.get('totalPendingOrders') or 0)
    demand_total_order_value = float(demand_metrics.get('totalOrderValue') or 0.0)
    demand_revenue_at_risk = float(demand_metrics.get('revenueAtRisk') or 0.0)
    demand_margin_at_risk = float(demand_metrics.get('marginAtRisk') or 0.0)
    demand_trend_value = demand_metrics.get('demandTrend')

    logistics_metrics = logistics_structured.get('metrics', {}) or {}
    if not logistics_metrics:
        logistics_raw = _safe_json_loads(logistics_structured.get('raw') or '')
        if isinstance(logistics_raw, dict):
            logistics_metrics = logistics_raw.get('metrics') or logistics_raw
    capacity_utilization = logistics_metrics.get('capacityUtilization')
    logistics_status = (logistics_structured.get('status') or '').lower()
    logistics_constraint = logistics_status in {'constraint', 'delayed', 'blocked'}
    logistics_total_pending_orders = int(logistics_metrics.get('totalPendingOrders') or 0)
    logistics_orders_with_routes = int(logistics_metrics.get('ordersWithRoutes') or 0)
    logistics_orders_needing_routes = int(logistics_metrics.get('ordersNeedingRoutes') or 0)

    risk_struct_metrics = risk_structured.get('metrics', {})
    risk_overall_score = risk_struct_metrics.get('overallRiskScore')
    risk_level_from_metrics = (risk_struct_metrics.get('riskLevel') or '').lower()
    risk_status = (risk_structured.get('status') or '').lower()

    risk_score = 0
    risk_signals: List[str] = []

    def _map_level(level: str, allow_high: bool = True) -> int:
        normalized = level.lower()
        if normalized in {'critical', 'very_high', 'severe', 'high'}:
            return 3 if allow_high else 2
        if normalized in {'medium', 'moderate'}:
            return 2
        if normalized in {'low', 'minimal', 'clear'}:
            return 1
        return 0

    def _apply_risk_level(level: str, source: str, allow_high: bool = True) -> None:
        nonlocal risk_score
        mapped = _map_level(level, allow_high=allow_high)
        if mapped:
            risk_score = max(risk_score, mapped)
            if mapped == 3:
                risk_signals.append(f'{source}: High risk level reported.')
            elif mapped == 2:
                risk_signals.append(f'{source}: Medium risk level reported.')
            else:
                risk_signals.append(f'{source}: Low risk level reported.')

    if isinstance(risk_overall_score, (int, float)):
        if risk_overall_score >= 0.65:
            _apply_risk_level('high', 'Risk agent')
            risk_signals.append(f'Overall risk score {risk_overall_score:.2f}')
        elif risk_overall_score >= 0.45:
            _apply_risk_level('medium', 'Risk agent')
            risk_signals.append(f'Overall risk score {risk_overall_score:.2f}')
        else:
            _apply_risk_level('low', 'Risk agent')
            risk_signals.append(f'Overall risk score {risk_overall_score:.2f}')

    if risk_level_from_metrics:
        _apply_risk_level(risk_level_from_metrics, 'Risk categories')
    if risk_status:
        # Treat narrative/status hints as advisory to avoid spikes from descriptive text.
        _apply_risk_level(risk_status, 'Risk narrative', allow_high=False)

    blockers: List[str] = []
    if has_inventory_shortfall and logistics_constraint:
        risk_score = max(risk_score, 3)
        blockers.append('Inventory and logistics constraints require immediate mitigation.')
        risk_signals.append('Simultaneous inventory and logistics constraints detected.')
    elif has_inventory_shortfall:
        if shortage_phrases:
            blockers.append(f"Inventory shortages in {', '.join(shortage_phrases)}")
        else:
            blockers.extend(inventory_structured.get('blockers', []))
        risk_score = max(risk_score, 2)
        risk_signals.append('Inventory shortfall requires mitigation.')
    elif logistics_constraint:
        blockers.append('Logistics capacity below demand volume')
        risk_score = max(risk_score, 2)
        risk_signals.append('Logistics constraints detected.')
    if total_shortage_units > 0:
        risk_signals.append(f'Total shortage units identified: {total_shortage_units}')
    if capacity_utilization and isinstance(capacity_utilization, str):
        risk_signals.append(f'Logistics capacity utilisation {capacity_utilization}')
    if isinstance(risk_exposure_summary, dict):
        inventory_exposure = risk_exposure_summary.get('inventory') or {}
        logistics_exposure = risk_exposure_summary.get('logistics') or {}
        if inventory_exposure.get('totalShortageUnits'):
            risk_score = max(risk_score, 2)
            risk_signals.append(
                f"Inventory exposure: {inventory_exposure['totalShortageUnits']} shortage units (~${inventory_exposure.get('revenueAtRisk', 0):,.0f})"
            )
        if logistics_exposure.get('ordersNeedingRoutes'):
            risk_score = max(risk_score, 2)
            risk_signals.append(
                f"Logistics exposure: {logistics_exposure['ordersNeedingRoutes']} orders awaiting routing"
            )

    # deduplicate blockers keeping order
    blockers.extend([
        blocker for blocker in inventory_structured.get('blockers', [])
        if blocker and blocker not in blockers
    ])
    blockers.extend([
        blocker for blocker in logistics_structured.get('blockers', [])
        if blocker and blocker not in blockers
    ])
    blockers = list(dict.fromkeys(blockers))

    if risk_score >= 3:
        risk_level_label = 'High'
    elif risk_score == 2:
        risk_level_label = 'Medium'
    elif risk_score == 1:
        risk_level_label = 'Low'
    else:
        risk_level_label = 'Not assessed'

    high_risk = risk_level_label.lower() == 'high'
    if high_risk and 'Risk posture is high; mitigation required' not in blockers:
        blockers.append('Risk posture is high; mitigation required')

    can_fulfill = not has_inventory_shortfall and not logistics_constraint and not high_risk
    decision_status = 'ready' if can_fulfill else 'needs_mitigation'
    risk_signals = list(dict.fromkeys(risk_signals))

    confidence_weights = {
        'inventory': 0.35,
        'demand': 0.25,
        'logistics': 0.25,
        'risk': 0.15,
    }
    confidence_total = 0.0
    weight_total = 0.0
    for result in agent_results:
        agent_type = result.get('agentType')
        weight = confidence_weights.get(agent_type, 0.1)
        confidence_total += result.get('confidence', 0.78) * weight
        weight_total += weight
    overall_confidence = round(confidence_total / weight_total, 2) if weight_total else _aggregate_confidence(agent_results)

    # Build context-aware decision object
    decision: Dict[str, Any] = {
        'status': decision_status,
        'blockers': blockers,
        'confidence': overall_confidence,
        'riskLevel': risk_level_label,
        'riskSignals': risk_signals,
        'confidenceWeights': confidence_weights,
    }
    
    # Only include canFulfill for fulfillment-related queries
    if 'fulfillment' in query_type or query_type == 'general_query':
        decision['canFulfill'] = can_fulfill

    # Generate context-aware summary based on query type
    summary_lines: List[str] = []
    
    # Fulfillment-related queries
    if 'fulfillment' in query_type or query_type == 'general_query':
        # Get actual order counts from metrics
        total_orders = logistics_total_pending_orders or demand_total_pending_orders
        total_order_value = demand_total_order_value or demand_revenue_at_risk
        
        # Build a comprehensive direct-answer paragraph with actual numbers
        if can_fulfill:
            if total_orders > 0:
                answer_start = f"Yes, you can fulfill all {total_orders} customer order(s) this week given current inventory."
            else:
                answer_start = "Yes, you can fulfill all customer orders this week given current inventory."
            
            if not has_inventory_shortfall and not logistics_constraint:
                answer_start += " Inventory levels are sufficient and logistics capacity can handle all pending orders."
            elif not has_inventory_shortfall:
                answer_start += " While inventory is adequate,"
            summary_lines.append(answer_start)
            
            # Add specific details about shortages if they exist but don't block fulfillment
            if shortages and len(shortages) > 0:
                shortage_skus = ', '.join(item.get('productId') for item in shortages[:3] if item.get('productId'))
                if shortage_skus:
                    summary_lines.append(f"Note: Inventory gaps exist in {len(shortages)} SKU(s) ({shortage_skus}) totaling {total_shortage_units} units, but these do not prevent fulfillment of current orders.")
            
            # Add order details
            if total_orders > 0:
                if total_order_value > 0:
                    summary_lines.append(f"Total order value: ${total_order_value:,.2f}.")
                if logistics_orders_with_routes > 0:
                    summary_lines.append(f"{logistics_orders_with_routes} of {total_orders} order(s) have assigned routes.")
            
            if logistics_orders_needing_routes > 0:
                summary_lines.append(f"{logistics_orders_needing_routes} order(s) still require route assignment, but this does not prevent fulfillment.")
            if capacity_utilization:
                summary_lines.append(f"Logistics capacity utilization is at {capacity_utilization}, indicating sufficient headroom.")
            if high_demand_products:
                drivers = ', '.join(item.get('productId') for item in high_demand_products[:3] if item.get('productId'))
                if drivers:
                    summary_lines.append(f"High-demand products ({drivers}) are covered by current inventory.")
        else:
            answer_start = "No, you cannot fully fulfill all customer orders this week given current inventory."
            summary_lines.append(answer_start)
            
            if shortage_phrases:
                summary_lines.append(f"Critical shortages exist in {', '.join(shortage_phrases)}, preventing complete fulfillment.")
            elif has_inventory_shortfall:
                summary_lines.append(f"Inventory shortfalls totaling {total_shortage_units} units across {len(shortages)} SKU(s) must be addressed.")
            
            if logistics_constraint:
                summary_lines.append("Additionally, logistics capacity constraints limit the ability to deliver all orders on schedule.")
            if high_risk:
                summary_lines.append("High-risk factors require approvals before proceeding with mitigation actions.")
        
        if risk_level_label != 'Not assessed' and risk_level_label != 'Low':
            summary_lines.append(f"Overall risk posture is {risk_level_label.lower()}, which should be monitored.")
    
    # Stockout forecast queries
    elif 'stockout' in query_type or 'stock_out' in query_type:
        if shortage_phrases:
            summary_lines.append(f"SKUs at risk of stockout: {', '.join(shortage_phrases)}.")
        elif total_shortage_units > 0:
            summary_lines.append(f"{total_shortage_units} total units at risk across {len(shortages)} SKU(s).")
        else:
            summary_lines.append("No stockouts projected in the forecast period.")
        if inventory_structured.get('recommendations'):
            summary_lines.append("Replenishment recommendations available.")
    
    # Replenishment planning queries
    elif 'replenishment' in query_type:
        # Build detailed replenishment plan summary
        if shortage_phrases:
            summary_lines.append(f"Replenishment plan targets critical shortages: {', '.join(shortage_phrases)}.")
        elif has_inventory_shortfall:
            summary_lines.append(f"Replenishment plan addresses {len(shortages)} SKU shortage(s) totaling {total_shortage_units} units.")
        
        # Add specific replenishment actions
        if shortages:
            for item in shortages[:3]:  # Top 3 shortages
                product_id = item.get('productId')
                shortage_qty = item.get('shortage') or item.get('delta') or 0
                if product_id and shortage_qty:
                    summary_lines.append(f"Order {shortage_qty} units of {product_id} from primary supplier.")
        
        # Add demand-driven priorities
        if high_demand_products:
            drivers = ', '.join(item.get('productId') for item in high_demand_products[:3] if item.get('productId'))
            if drivers:
                summary_lines.append(f"Prioritize replenishment for high-velocity SKUs: {drivers}.")
        
        # Add timeline and coordination
        if has_inventory_shortfall:
            summary_lines.append("Coordinate with procurement for expedited delivery within 3-5 business days.")
        else:
            summary_lines.append("Standard replenishment cycle recommended based on stable demand patterns.")
    
    # Expedite assessment queries
    elif 'expedite' in query_type:
        if logistics_constraint or has_inventory_shortfall:
            summary_lines.append("Expedited shipments recommended to address constraints.")
        else:
            summary_lines.append("Standard shipping timelines are sufficient; expedite not required.")
        if logistics_metrics.get('ordersNeedingRoutes'):
            summary_lines.append(f"{logistics_metrics.get('ordersNeedingRoutes')} orders require routing assignment.")
    
    # Carrier comparison queries
    elif 'carrier' in query_type or 'logistics' in query_type:
        if capacity_utilization:
            summary_lines.append(f"Current capacity utilization: {capacity_utilization}.")
        if logistics_structured.get('recommendations'):
            summary_lines.append("Carrier comparison and recommendations available.")
        else:
            summary_lines.append("Logistics analysis complete with carrier performance metrics.")
    
    # Revenue impact queries
    elif 'revenue' in query_type or 'impact' in query_type:
        revenue_at_risk = demand_metrics.get('revenueAtRisk') or demand_metrics.get('totalOrderValue') or 0
        if revenue_at_risk:
            summary_lines.append(f"Revenue impact assessed: ${revenue_at_risk:,.2f} at risk.")
        if risk_level_label != 'Not assessed':
            summary_lines.append(f"Risk level: {risk_level_label}.")
        if risk_signals:
            summary_lines.append(f"Key risk factors: {', '.join(risk_signals[:2])}.")
    
    # Production scheduling queries
    elif 'production' in query_type or 'schedule' in query_type:
        if high_demand_products:
            drivers = ', '.join(item.get('productId') for item in high_demand_products[:3] if item.get('productId'))
            summary_lines.append(f"Production schedule optimized for high-demand SKUs: {drivers}.")
        if has_inventory_shortfall:
            summary_lines.append("Production schedule accounts for inventory gaps.")
        summary_lines.append("Cost-optimized production schedule generated.")
    
    # Order prioritization queries
    elif 'priorit' in query_type or 'priority' in query_type:
        if high_demand_products:
            drivers = ', '.join(item.get('productId') for item in high_demand_products[:3] if item.get('productId'))
            summary_lines.append(f"High-priority orders identified for SKUs: {drivers}.")
        if risk_level_label != 'Not assessed':
            summary_lines.append(f"Prioritization considers risk level: {risk_level_label}.")
        summary_lines.append("Customer order prioritization recommendations available.")
    
    # Supplier performance queries
    elif 'supplier' in query_type:
        if risk_signals:
            summary_lines.append(f"Supplier performance analysis: {', '.join(risk_signals[:2])}.")
        summary_lines.append("Supplier delivery performance assessment complete.")
    
    # SLA compliance queries
    elif 'sla' in query_type or 'compliance' in query_type:
        if logistics_constraint:
            summary_lines.append("SLA targets at risk due to logistics constraints.")
        elif has_inventory_shortfall:
            summary_lines.append("SLA targets at risk due to inventory shortages.")
        else:
            summary_lines.append("Current operations align with SLA targets.")
        if risk_level_label != 'Not assessed':
            summary_lines.append(f"Overall risk posture: {risk_level_label}.")
    
    # Markdown recommendations queries
    elif 'markdown' in query_type:
        if high_demand_products:
            summary_lines.append("Demand-driven markdown recommendations generated.")
        else:
            summary_lines.append("Markdown analysis complete based on demand patterns.")
    
    # Carrier activation queries
    elif 'carrier_activation' in query_type or 'backup' in query_type:
        if logistics_constraint:
            summary_lines.append("Backup carrier activation recommended.")
        else:
            summary_lines.append("Current carrier capacity sufficient; backup activation not required.")
    
    # Inventory forecast queries
    elif 'forecast' in query_type and 'inventory' in query_type:
        if shortage_phrases:
            summary_lines.append(f"Forecast indicates potential shortages: {', '.join(shortage_phrases)}.")
        else:
            summary_lines.append("Inventory forecast shows adequate stock levels.")
        if high_demand_products:
            drivers = ', '.join(item.get('productId') for item in high_demand_products[:3] if item.get('productId'))
            summary_lines.append(f"High-demand SKUs to monitor: {drivers}.")
    
    # Stock reallocation queries
    elif 'reallocat' in query_type or 'reallocate' in query_type:
        if has_inventory_shortfall or shortage_phrases:
            answer = "Yes, stock reallocation across warehouses is recommended."
            if shortage_phrases:
                answer += f" Critical shortages exist in {', '.join(shortage_phrases)}, which can be addressed through strategic reallocation."
            else:
                answer += f" Inventory gaps totaling {total_shortage_units} units across {len(shortages)} SKU(s) indicate reallocation would improve fulfillment capability."
            summary_lines.append(answer)
            if high_demand_products:
                drivers = ', '.join(item.get('productId') for item in high_demand_products[:3] if item.get('productId'))
                if drivers:
                    summary_lines.append(f"High-demand products ({drivers}) should be prioritized in the reallocation plan.")
        else:
            summary_lines.append("No immediate stock reallocation is required. Current inventory distribution across warehouses is adequate for demand.")
        summary_lines.append("Reallocation analysis considers warehouse capacity, demand patterns, and logistics constraints.")
    
    # Late delivery risk queries
    elif 'late' in query_type or 'delivery' in query_type:
        if logistics_constraint:
            summary_lines.append(f"Orders at risk of late delivery identified.")
        if logistics_metrics.get('ordersNeedingRoutes'):
            summary_lines.append(f"{logistics_metrics.get('ordersNeedingRoutes')} orders require routing to avoid delays.")
        summary_lines.append("Delivery risk assessment complete.")
    
    # Demand surge simulation queries
    elif 'surge' in query_type or 'simulate' in query_type:
        if demand_metrics.get('surgeDetected'):
            summary_lines.append("Demand surge impact analysis complete.")
        summary_lines.append("Simulation results available for demand surge scenario.")
    
    # Safety stock optimization queries
    elif 'safety_stock' in query_type or 'safety' in query_type:
        if shortage_phrases:
            summary_lines.append(f"Safety stock optimization addresses shortages in {', '.join(shortage_phrases)}.")
        summary_lines.append("Safety stock optimization recommendations generated.")
    
    # Demand reconciliation queries
    elif 'reconcil' in query_type or 'forecast' in query_type:
        summary_lines.append("Demand reconciliation analysis comparing actual vs forecast complete.")
        if demand_metrics.get('demandTrend'):
            summary_lines.append(f"Demand trend: {demand_metrics.get('demandTrend')}.")
    
    # Supplier diversification queries
    elif 'diversif' in query_type:
        if risk_level_label != 'Not assessed':
            summary_lines.append(f"Supplier diversification recommendations consider risk level: {risk_level_label}.")
        summary_lines.append("Supplier diversification analysis for critical SKUs complete.")
    
    # Executive briefing queries
    elif 'briefing' in query_type or 'executive' in query_type:
        summary_lines.append("Executive briefing generated with comprehensive supply chain insights.")
        if risk_level_label != 'Not assessed':
            summary_lines.append(f"Overall risk posture: {risk_level_label}.")
        if high_demand_products:
            drivers = ', '.join(item.get('productId') for item in high_demand_products[:3] if item.get('productId'))
            summary_lines.append(f"Key focus areas: {drivers}.")
    
    # Default fallback
    else:
        if risk_level_label != 'Not assessed':
            summary_lines.append(f"Risk posture is {risk_level_label.lower()}.")
        if high_demand_products:
            drivers = ', '.join(item.get('productId') for item in high_demand_products[:3] if item.get('productId'))
            if drivers:
                summary_lines.append(f"Demand pressure driven by: {drivers}.")
        if not summary_lines:
            summary_lines.append('Multi-agent analysis complete.')

    summary = ' '.join(summary_lines)

    actions: List[Dict[str, Any]] = []
    approvals: List[Dict[str, Any]] = []
    
    # Check for already-completed actions and decided approvals (GLOBAL - not session-specific)
    # This ensures any user sees if an action was already taken by anyone
    completed_actions = _get_completed_actions_global()
    decided_approvals = _get_decided_approvals_global()
    
    def _is_action_completed(description: str, affected_skus: List[str] = None) -> Optional[Dict[str, Any]]:
        """Check if an action with this description was already completed."""
        desc_lower = description.lower().strip()
        affected_skus = affected_skus or []
        sorted_skus = sorted([s for s in affected_skus if s])
        
        # Build the key the same way we store it
        if sorted_skus:
            lookup_key = f"{desc_lower}|{','.join(sorted_skus)}"
        else:
            lookup_key = desc_lower
        
        # Direct match
        if lookup_key in completed_actions:
            return completed_actions[lookup_key]
        
        # Try matching without SKUs
        if desc_lower in completed_actions:
            return completed_actions[desc_lower]
        
        # Fuzzy match on description
        for key, info in completed_actions.items():
            key_desc = key.split('|')[0] if '|' in key else key
            # Check if key words overlap significantly
            if key_desc in desc_lower or desc_lower in key_desc:
                return info
            key_words = set(key_desc.split())
            desc_words = set(desc_lower.split())
            if len(key_words & desc_words) >= 3:  # At least 3 words in common
                return info
        return None
    
    def _is_approval_decided(title: str) -> Optional[Dict[str, Any]]:
        """Check if an approval with this title was already decided."""
        title_lower = title.lower()
        for key, info in decided_approvals.items():
            if key in title_lower or title_lower in key:
                return info
            key_words = set(key.split())
            title_words = set(title_lower.split())
            if len(key_words & title_words) >= 3:
                return info
        return None
    
    def _add_action_if_not_completed(action: Dict[str, Any]) -> None:
        """Add action to list, or mark as already completed if it was done before."""
        description = action.get('description', '')
        # Extract affected SKUs from action data
        data = action.get('data') or {}
        shortages = data.get('shortages') or []
        affected_skus = [s.get('productId', '') for s in shortages if isinstance(s, dict) and s.get('productId')]
        
        completed_info = _is_action_completed(description, affected_skus)
        if completed_info:
            # Action was already completed - add with completed status
            action['status'] = 'already_completed'
            action['completedAt'] = completed_info.get('completedAt')
            action['completedBy'] = completed_info.get('completedBy')
            completed_date = completed_info.get('completedAt', 'unknown date')
            if completed_date and completed_date != 'unknown date':
                try:
                    from datetime import datetime
                    dt = datetime.fromisoformat(completed_date.replace('Z', '+00:00'))
                    completed_date = dt.strftime('%Y-%m-%d %H:%M')
                except:
                    pass
            action['note'] = f"Action already taken on {completed_date} by {completed_info.get('completedBy', 'unknown')}"
            logger.info(f"Action '{description}' already completed, marking as such")
        actions.append(action)
    
    def _add_approval_if_not_decided(approval: Dict[str, Any]) -> None:
        """Add approval to list, or mark as already decided if it was done before."""
        title = approval.get('title', '')
        decided_info = _is_approval_decided(title)
        if decided_info:
            # Approval was already decided - add with decided status
            approval['status'] = decided_info.get('status', 'decided')
            approval['decidedAt'] = decided_info.get('decidedAt')
            approval['decidedBy'] = decided_info.get('decidedBy')
            decided_date = decided_info.get('decidedAt', 'unknown date')
            if decided_date and decided_date != 'unknown date':
                try:
                    from datetime import datetime
                    dt = datetime.fromisoformat(decided_date.replace('Z', '+00:00'))
                    decided_date = dt.strftime('%Y-%m-%d %H:%M')
                except:
                    pass
            approval['note'] = f"Already {decided_info.get('status')} on {decided_date} by {decided_info.get('decidedBy', 'unknown')}"
            logger.info(f"Approval '{title}' already decided, marking as such")
        approvals.append(approval)

    # Generate context-aware actions and approvals based on query type
    # Fulfillment-specific actions
    if 'fulfillment' in query_type or query_type == 'general_query':
        if has_inventory_shortfall:
            shortages_for_payload: List[Dict[str, Any]] = []
            for item in shortages:
                if not item:
                    continue
                entry: Dict[str, Any] = {'productId': item.get('productId')}
                if item.get('required') is not None:
                    entry['required'] = item.get('required')
                if item.get('available') is not None:
                    entry['available'] = item.get('available')
                if item.get('shortage') is not None:
                    entry['shortage'] = item.get('shortage')
                elif item.get('surplus') is not None:
                    entry['surplus'] = item.get('surplus')
                shortages_for_payload.append(entry)

            if not shortages_for_payload and shortage_phrases:
                fallback_entries: List[Dict[str, Any]] = []
                for phrase in shortage_phrases:
                    product_match = re.match(r'([A-Za-z0-9\-\_]+)', phrase)
                    qty_match = re.search(r'(\d+)', phrase)
                    entry: Dict[str, Any] = {}
                    if product_match:
                        entry['productId'] = product_match.group(1)
                    if qty_match:
                        entry['shortage'] = int(qty_match.group(1))
                    fallback_entries.append(entry)
                shortages_for_payload = fallback_entries

            _add_approval_if_not_decided({
                'id': 'approve_emergency_replenishment',
                'title': 'Approve emergency replenishment for shortage SKUs',
                'risk': 'Medium',
                'requires': 'Supply chain manager',
                'details': {'shortages': shortages_for_payload},
                'status': 'pending',
            })
            _add_action_if_not_completed({
                'id': 'draft_emergency_po',
                'type': 'autonomous',
                'description': 'Draft emergency purchase orders for shortage SKUs',
                'status': 'ready',
                'data': {'shortages': shortages_for_payload},
                'riskLevel': 'Medium',
                'owner': 'Procurement',
            })

        if logistics_constraint:
            _add_approval_if_not_decided({
                'id': 'approve_expedited_shipments',
                'title': 'Approve expedited shipments to relieve logistics constraints',
                'risk': 'Medium',
                'requires': 'Logistics lead',
                'details': {'recommendations': logistics_structured.get('recommendations', [])},
                'status': 'pending',
            })
            _add_action_if_not_completed({
                'id': 'activate_overflow_carriers',
                'type': 'autonomous',
                'description': 'Activate overflow carriers or expedited lanes for constrained routes',
                'status': 'ready',
                'riskLevel': 'Medium',
                'owner': 'Logistics',
            })

        if can_fulfill:
            _add_action_if_not_completed({
                'id': 'notify_customer_service',
                'type': 'autonomous',
                'description': 'Notify customer service to communicate fulfillment plan to customers',
                'status': 'scheduled',
                'riskLevel': 'Low',
                'owner': 'Customer service',
            })
        elif not any(action['id'] == 'notify_customer_service' for action in actions):
            _add_action_if_not_completed({
                'id': 'notify_customer_service',
                'type': 'autonomous',
                'description': 'Notify customer service about partial fulfillment and expected delays',
                'status': 'planned',
                'riskLevel': 'Low',
                'owner': 'Customer service',
            })
    
    # Replenishment planning actions
    elif 'replenishment' in query_type:
        # Build detailed replenishment action with specific SKU details
        replenishment_details = {
            'shortages': shortages[:5] if shortages else [],  # Top 5 shortages
            'highDemandProducts': high_demand_products[:5] if high_demand_products else [],
            'totalShortageUnits': total_shortage_units,
            'revenueAtRisk': demand_revenue_at_risk,
            'demandTrend': demand_trend_value,
        }
        
        action = {
            'id': 'execute_replenishment_plan',
            'type': 'autonomous',
            'description': 'Execute replenishment plan based on demand trends',
            'status': 'ready',
            'riskLevel': 'Low',
            'owner': 'Procurement',
            'data': replenishment_details,
        }
        
        # Generate notification draft in the orchestrator
        notification = _generate_notification_draft(action, 'action')
        if notification:
            action['notification'] = notification
        
        _add_action_if_not_completed(action)
    
    # Expedite assessment actions
    elif 'expedite' in query_type:
        if logistics_constraint or has_inventory_shortfall:
            _add_action_if_not_completed({
                'id': 'initiate_expedited_shipments',
                'type': 'autonomous',
                'description': 'Initiate expedited inbound shipments',
                'status': 'ready',
                'riskLevel': 'Medium',
                'owner': 'Logistics',
            })
    
    # Carrier activation actions
    elif 'carrier_activation' in query_type or 'backup' in query_type:
        if logistics_constraint:
            _add_action_if_not_completed({
                'id': 'activate_backup_carriers',
                'type': 'autonomous',
                'description': 'Activate backup carriers to address capacity constraints',
                'status': 'ready',
                'riskLevel': 'Medium',
                'owner': 'Logistics',
            })
    
    # Production scheduling actions
    elif 'production' in query_type or 'schedule' in query_type:
        _add_action_if_not_completed({
            'id': 'implement_production_schedule',
            'type': 'autonomous',
            'description': 'Implement cost-optimized production schedule',
            'status': 'ready',
            'riskLevel': 'Low',
            'owner': 'Production',
        })
    
    # High-risk scenarios always get risk mitigation actions
    if risk_score >= 3 and not any(a['id'] == 'escalate_risk_review' for a in approvals):
        _add_approval_if_not_decided({
            'id': 'escalate_risk_review',
            'title': 'Approve risk mitigation plan for high-risk posture',
            'risk': 'High',
            'requires': 'Risk committee',
            'details': {'signals': risk_signals},
            'status': 'pending',
        })
        _add_action_if_not_completed({
            'id': 'prepare_risk_briefing',
            'type': 'autonomous',
            'description': 'Prepare executive briefing summarizing high-risk drivers and mitigations',
            'status': 'ready',
            'riskLevel': 'High',
            'owner': 'Risk management',
        })

    agent_findings: List[Dict[str, Any]] = []
    for result in agent_results:
        structured = result.get('structured') or {}
        agent_type = result.get('agentType')
        status_value = structured.get('status')
        metrics = structured.get('metrics', {})

        # Extract highlight and detailed summaries FIRST before any other processing
        # This ensures we always work with strings, not dicts
        highlight_summary = structured.get('summary')
        detailed_summary_text = structured.get('detailedSummary') or structured.get('detailed')
        
        # DEBUG: Log what we received
        logger.info(f"{agent_type} agent - summary type: {type(highlight_summary)}, detailedSummary type: {type(detailed_summary_text)}")
        
        # Ensure highlight_summary is a string (it might be a dict if not properly parsed)
        if isinstance(highlight_summary, dict):
            logger.warning(f"{agent_type}: summary is a dict with keys: {list(highlight_summary.keys())}")
            # Extract the actual string value from the dict
            highlight_summary = highlight_summary.get('highlightSummary', highlight_summary.get('summary', ''))
            if not highlight_summary:
                # If still no value, convert the whole dict to string as last resort
                highlight_summary = json.dumps(highlight_summary)
                logger.error(f"{agent_type}: Had to convert entire dict to string for highlight")
        
        if not isinstance(highlight_summary, str):
            logger.warning(f"{agent_type}: highlight_summary is {type(highlight_summary)}, converting to string")
            highlight_summary = str(highlight_summary) if highlight_summary else 'No findings provided for this query.'
        
        # Ensure detailed_summary_text is a string
        if isinstance(detailed_summary_text, dict):
            logger.warning(f"{agent_type}: detailedSummary is a dict with keys: {list(detailed_summary_text.keys())}")
            # Extract the actual string value from the dict
            detailed_summary_text = detailed_summary_text.get('detailedSummary', detailed_summary_text.get('analysis', ''))
            if not detailed_summary_text:
                detailed_summary_text = json.dumps(detailed_summary_text)
                logger.error(f"{agent_type}: Had to convert entire dict to string for detailed")
        
        if detailed_summary_text and not isinstance(detailed_summary_text, str):
            logger.warning(f"{agent_type}: detailed_summary_text is {type(detailed_summary_text)}, converting to string")
            detailed_summary_text = str(detailed_summary_text)
        
        # If summaries still look like embedded JSON, extract highlight/detailed fields
        if isinstance(highlight_summary, str) and highlight_summary.strip().startswith('{'):
            parsed_highlight, parsed_detailed = _extract_highlight_and_detailed(highlight_summary)
            if parsed_highlight:
                highlight_summary = parsed_highlight
            if parsed_detailed and not detailed_summary_text:
                detailed_summary_text = parsed_detailed

        if isinstance(detailed_summary_text, str) and detailed_summary_text.strip().startswith('{'):
            parsed_highlight, parsed_detailed = _extract_highlight_and_detailed(detailed_summary_text)
            if parsed_detailed:
                detailed_summary_text = parsed_detailed
            if parsed_highlight and not highlight_summary:
                highlight_summary = parsed_highlight

        # Now set summary_text and overview_text based on what we extracted
        # CRITICAL: summary_text is for Agent Highlights (concise), overview_text is for Agent Insights (detailed)
        # DO NOT use highlight_summary as fallback for overview_text - only use detailed_summary_text
        summary_text = highlight_summary or 'No findings provided for this query.'
        # Only use detailed_summary_text for Agent Insights - no fallback to highlight
        overview_text = detailed_summary_text if detailed_summary_text else None
        
        logger.info(f"{agent_type} agent - final summary_text length: {len(summary_text)}, overview_text length: {len(overview_text) if overview_text else 0}")

        # Special handling for risk agent
        if agent_type == 'risk':
            status_value = risk_level_label.lower()
            if isinstance(risk_overall_score, (int, float)):
                summary_text = f"Overall risk score {risk_overall_score:.2f} ({risk_level_label})."
            else:
                summary_text = f"Risk posture assessed as {risk_level_label}."
            if risk_signals:
                summary_text += f" Signals: {', '.join(risk_signals[:4])}."
            overview_text = summary_text

        # Build detailed insights for Agent Insights section
        detailed_insights: Dict[str, Any] = {}
        
        metrics_section: List[str] = []
        
        # ALWAYS extract from global computed variables (these are computed from agent responses)
        # These should always have data if the agents returned anything
        if agent_type == 'inventory':
            # Extract detailed metrics from actual data - use LLM's status from structured response
            # Status should come from LLM response, not inferred
            agent_status = structured.get('status', '').lower()
            # But if we have actual shortages, status MUST be shortfall
            if shortages and len(shortages) > 0:
                agent_status = 'shortfall'  # Override with actual data
                metrics_section.append(f"Shortages identified: {len(shortages)} SKU(s)")
                metrics_section.append(f"Total shortage units: {total_shortage_units}")
                metrics_section.append("Affected SKUs with details:")
                for item in shortages[:5]:
                    if isinstance(item, dict) and item.get('productId'):
                        shortage_qty = item.get('shortage') or item.get('delta', 0)
                        required = item.get('required', 0)
                        available = item.get('available', 0)
                        metrics_section.append(f"  - {item.get('productId')}: {shortage_qty} units short (required: {required}, available: {available})")
            else:
                total_available = inventory_structured.get('metrics', {}).get('totalAvailableStock') or inventory_structured.get('metrics', {}).get('currentStock')
                if total_available:
                    metrics_section.append(f"Total available stock: {total_available} units")
            # Add inventory status - use agent_status (from LLM or inferred from data)
            if agent_status and agent_status != 'unknown':
                status_label = agent_status.replace('_', ' ').title()
                metrics_section.append(f"Inventory status: {status_label}")
            # Also update status_value for the finding
            status_value = agent_status if agent_status else status_value
        
        elif agent_type == 'logistics':
            # Extract detailed metrics from actual data
            total_pending = logistics_metrics.get('totalPendingOrders') or 0
            orders_with_routes = logistics_metrics.get('ordersWithRoutes') or 0
            orders_needing_routes = logistics_metrics.get('ordersNeedingRoutes') or 0
            
            if total_pending > 0:
                metrics_section.append(f"Total pending orders: {total_pending}")
                if orders_with_routes > 0:
                    metrics_section.append(f"Orders with assigned routes: {orders_with_routes}")
                if orders_needing_routes > 0:
                    metrics_section.append(f"Orders requiring route assignment: {orders_needing_routes}")
                    unassigned_pct = round((orders_needing_routes / total_pending) * 100, 1) if total_pending > 0 else 0
                    metrics_section.append(f"Unassigned percentage: {unassigned_pct}%")
            # Always show capacity and status if available
            if logistics_metrics.get('maxDailyCapacity'):
                metrics_section.append(f"Maximum daily capacity: {logistics_metrics.get('maxDailyCapacity')} orders")
            if capacity_utilization:
                metrics_section.append(f"Current capacity utilization: {capacity_utilization}")
            if logistics_status:
                status_label = logistics_status.replace('_', ' ').title()
                metrics_section.append(f"Logistics status: {status_label}")
            can_fulfill_logistics = logistics_structured.get('canFulfillAll') or logistics_structured.get('canFulfillAllOrders')
            if can_fulfill_logistics is not None:
                metrics_section.append(f"Can fulfill all orders: {'Yes' if can_fulfill_logistics else 'No'}")
        
        elif agent_type == 'demand':
            # Extract detailed metrics from actual data
            total_pending_orders = demand_metrics.get('totalPendingOrders') or 0
            total_order_value = demand_metrics.get('totalOrderValue') or 0
            revenue_at_risk = demand_metrics.get('revenueAtRisk') or 0
            
            if total_pending_orders > 0:
                metrics_section.append(f"Total pending orders: {total_pending_orders}")
            if total_order_value > 0:
                metrics_section.append(f"Total order value: ${total_order_value:,.2f}")
            if revenue_at_risk > 0:
                metrics_section.append(f"Revenue at risk: ${revenue_at_risk:,.2f}")
            margin_at_risk = demand_metrics.get('marginAtRisk') or 0
            if margin_at_risk > 0:
                metrics_section.append(f"Estimated margin exposure: ${margin_at_risk:,.2f}")
            if demand_metrics.get('averageOrderSize'):
                metrics_section.append(f"Average order size: {demand_metrics.get('averageOrderSize'):.1f} items per order")
            if demand_metrics.get('ordersWithLineItems'):
                metrics_section.append(f"Orders with line items: {demand_metrics.get('ordersWithLineItems')}")
            if demand_metrics.get('uniqueProducts'):
                metrics_section.append(f"Unique products in orders: {demand_metrics.get('uniqueProducts')}")
            if demand_metrics.get('demandTrend'):
                metrics_section.append(f"Demand trend: {demand_metrics.get('demandTrend')}")
            if demand_metrics.get('surgeDetected'):
                surge_pct = demand_metrics.get('overallSurgePercentage') or 0
                metrics_section.append(f"Demand surge detected: {surge_pct:.1f}% increase")
            if high_demand_products and len(high_demand_products) > 0:
                metrics_section.append(f"High-demand products: {len(high_demand_products)} SKU(s) identified")
                metrics_section.append("Top demand drivers:")
                for item in high_demand_products[:5]:
                    if isinstance(item, dict) and item.get('productId'):
                        qty = item.get('orderedQuantity') or item.get('orderCount', 0)
                        product_id = item.get('productId')
                        metrics_section.append(f"  - {product_id}: {qty} units ordered")
        
        elif agent_type == 'risk':
            # Extract detailed metrics from actual data
            if isinstance(risk_overall_score, (int, float)):
                metrics_section.append(f"Overall risk score: {risk_overall_score:.2f} (scale 0-1)")
            if risk_level_label and risk_level_label != 'Not assessed':
                metrics_section.append(f"Risk level: {risk_level_label}")
            if risk_exposure_summary:
                inv_exposure = risk_exposure_summary.get('inventory', {})
                log_exposure = risk_exposure_summary.get('logistics', {})
                if inv_exposure.get('totalShortageUnits'):
                    metrics_section.append(f"Inventory exposure: {inv_exposure['totalShortageUnits']} shortage units")
                    if inv_exposure.get('revenueAtRisk'):
                        metrics_section.append(f"  Revenue at risk: ${inv_exposure.get('revenueAtRisk', 0):,.2f}")
                if log_exposure.get('ordersNeedingRoutes'):
                    metrics_section.append(f"Logistics exposure: {log_exposure['ordersNeedingRoutes']} orders awaiting routing")
            if risk_signals:
                metrics_section.append(f"Risk signals identified: {len(risk_signals)}")
                for signal in risk_signals[:3]:
                    metrics_section.append(f"  - {signal}")
        
        # Set overview (agent's detailed summary) and metrics
        # ALWAYS set overview if we have text - the UI will display it appropriately
        if overview_text:
            detailed_insights['overview'] = overview_text.strip()
            if overview_text == summary_text:
                logger.info(f"{agent_type} agent: Using same text for both highlight and detailed (LLM didn't differentiate)")
        else:
            logger.warning(f"{agent_type} agent: No overview text available")
        
        if metrics_section:
            detailed_insights['metrics'] = metrics_section
        
        # Add blockers section - only from actual agent responses, no static/mocked data
        blockers_list = structured.get('blockers', [])
        # Only infer blockers if we have actual data to support it (not static messages)
        if not blockers_list:
            if agent_type == 'inventory' and has_inventory_shortfall and shortages:
                # Only add if we have actual shortage data
                blockers_list.append(f"Inventory shortfall: {total_shortage_units} units across {len(shortages)} SKU(s)")
            elif agent_type == 'logistics' and logistics_constraint and logistics_metrics.get('ordersNeedingRoutes'):
                # Only add if we have actual order data
                blockers_list.append(f"{logistics_metrics.get('ordersNeedingRoutes')} orders require route assignment")
            elif agent_type == 'demand' and demand_structured.get('status') == 'data_gap':
                # Only add if status indicates actual data gap
                blockers_list.append("Incomplete order data impacts demand analysis accuracy")
        if blockers_list:
            detailed_insights['blockers'] = blockers_list[:5]  # Limit to 5 blockers
        
        # Add recommendations section - only from actual agent responses, no static/mocked data
        recommendations_list = structured.get('recommendations', [])
        # Only infer recommendations if we have actual data to support it
        if not recommendations_list:
            if agent_type == 'inventory' and has_inventory_shortfall and shortages:
                # Only add if we have actual shortage data
                shortage_skus = ', '.join(item.get('productId') for item in shortages[:3] if item.get('productId'))
                if shortage_skus:
                    recommendations_list.append(f"Initiate replenishment for shortage SKUs: {shortage_skus}")
            elif agent_type == 'logistics' and logistics_constraint and logistics_metrics.get('ordersNeedingRoutes'):
                # Only add if we have actual constraint data
                recommendations_list.append(f"Assign routes to {logistics_metrics.get('ordersNeedingRoutes')} unassigned orders")
            elif agent_type == 'demand' and high_demand_products and len(high_demand_products) > 0:
                # Only add if we have actual high-demand product data
                top_products = ', '.join(item.get('productId') for item in high_demand_products[:3] if item.get('productId'))
                if top_products:
                    recommendations_list.append(f"Align supply with high-velocity SKUs: {top_products}")
        if recommendations_list:
            detailed_insights['recommendations'] = recommendations_list[:5]  # Limit to 5 recommendations
        
        # Only show metrics if we have actual data - no static/mocked responses
        # If no metrics were extracted, don't show anything (UI will handle empty state)
        
        # Log for debugging (can be removed later)
        logger.info(
            "Agent %s insights populated: metrics=%s items, blockers=%s items, recommendations=%s items, summary='%s'",
            agent_type,
            len(detailed_insights.get('metrics', [])),
            len(detailed_insights.get('blockers', [])),
            len(detailed_insights.get('recommendations', [])),
            summary_text[:50] if summary_text else 'None'
        )

        agent_findings.append({
            'agent': agent_type,
            'status': status_value,
            'summary': summary_text,  # For Agent Highlights
            'blockers': blockers_list,
            'recommendations': recommendations_list,
            'insights': detailed_insights,  # Detailed info for Agent Insights
        })

    # Generate context-aware next steps
    next_steps: List[str] = []
    
    if 'fulfillment' in query_type or query_type == 'general_query':
        if approvals:
            next_steps.append('Review and approve pending mitigation actions.')
        if not can_fulfill:
            next_steps.append('Align procurement and logistics on mitigation timelines.')
        if logistics_constraint:
            next_steps.append('Activate overflow carriers or expedite routing for constrained shipments.')
        if can_fulfill:
            next_steps.append('Communicate fulfillment plan to customer service.')
    elif 'replenishment' in query_type:
        next_steps.append('Review and execute replenishment plan based on demand trends.')
        if has_inventory_shortfall:
            next_steps.append('Prioritize replenishment for shortage SKUs.')
    elif 'expedite' in query_type:
        if logistics_constraint or has_inventory_shortfall:
            next_steps.append('Initiate expedited shipment process.')
        else:
            next_steps.append('Continue monitoring; expedite not required at this time.')
    elif 'production' in query_type or 'schedule' in query_type:
        next_steps.append('Review and implement cost-optimized production schedule.')
        next_steps.append('Coordinate with production team on schedule execution.')
    elif 'priorit' in query_type or 'priority' in query_type:
        next_steps.append('Review order prioritization recommendations.')
        next_steps.append('Update order management system with priority assignments.')
    elif 'carrier' in query_type or 'logistics' in query_type:
        next_steps.append('Review carrier comparison and logistics recommendations.')
        if logistics_constraint:
            next_steps.append('Activate recommended carriers to address constraints.')
    elif 'revenue' in query_type or 'impact' in query_type:
        next_steps.append('Review revenue impact assessment and mitigation options.')
        if risk_level_label != 'Not assessed':
            next_steps.append(f'Implement risk mitigation strategies for {risk_level_label.lower()} risk level.')
    elif 'stockout' in query_type or 'stock_out' in query_type:
        if shortage_phrases:
            next_steps.append('Initiate preventive replenishment for at-risk SKUs.')
        next_steps.append('Monitor stock levels and adjust forecasts.')
    elif 'safety_stock' in query_type or 'safety' in query_type:
        next_steps.append('Review safety stock optimization recommendations.')
        next_steps.append('Update safety stock levels in inventory management system.')
    elif 'forecast' in query_type:
        next_steps.append('Review forecast analysis and adjust planning parameters.')
        if demand_structured.get('status') == 'data_gap':
            next_steps.append('Provide updated inventory snapshot to the demand planning team.')
    elif 'briefing' in query_type or 'executive' in query_type:
        next_steps.append('Review executive briefing with leadership team.')
        next_steps.append('Prioritize action items based on briefing insights.')
    else:
        # Generic next steps for other query types
        if approvals:
            next_steps.append('Review and approve pending actions.')
        if risk_level_label != 'Not assessed':
            next_steps.append(f'Monitor {risk_level_label.lower()} risk indicators.')
    
    # Always add generic monitoring step if not already present
    if not any('monitor' in step.lower() for step in next_steps):
        next_steps.append('Monitor progress and update stakeholders as needed.')

    # Use LLM to synthesize a direct answer to the user's question
    if user_query and agent_findings:
        llm_summary = _synthesize_summary_with_llm(user_query, agent_findings, risk_level_label)
        if llm_summary:
            summary = llm_summary
            logger.info("Using LLM-synthesized summary: %s", summary[:100])

    return {
        'summary': summary,
        'decision': decision,
        'confidence': overall_confidence,
        'riskSignals': risk_signals,
        'riskScore': risk_overall_score if isinstance(risk_overall_score, (int, float)) else None,
        'agents': [result.get('agentType') for result in agent_results],
        'agentFindings': agent_findings,
        'actions': actions,
        'approvals': approvals,
        'nextSteps': next_steps,
        'analysis': analysis,
        'sessionId': session_id,
        'timestamp': datetime.now(timezone.utc).isoformat() + 'Z',
    }


def _unwrap_agent_message(raw: Any) -> str:
    if isinstance(raw, dict):
        candidate = raw.get('message') or raw.get('summary') or raw
        if isinstance(candidate, str):
            return _unwrap_agent_message(candidate)
        return str(candidate)
    if not isinstance(raw, str):
        return str(raw)
    text = raw.strip()
    parsed = _safe_json_loads(text)
    if isinstance(parsed, dict):
        return _unwrap_agent_message(parsed)
    text = text.replace('\\n', '\n')
    text = re.sub(r'\*\*(.*?)\*\*', r'\1', text)
    text = re.sub(r'__([^_]+)__', r'\1', text)
    return text.strip()


def _sanitize_product_id(value: str) -> str:
    return re.sub(r'[\*\s]+$', '', value.strip())


def _strip_code_fences(text: str) -> str:
    """Remove markdown code fences and optional language hints."""
    if not isinstance(text, str):
        return text
    stripped = text.strip()
    if stripped.startswith('```'):
        lines = stripped.splitlines()
        # Drop opening fence
        lines = lines[1:]
        # Drop closing fence if present
        if lines and lines[-1].strip().startswith('```'):
            lines = lines[:-1]
        stripped = '\n'.join(lines).strip()
        # Remove leading language designator like "json"
        if stripped.lower().startswith('json'):
            stripped = stripped[4:].lstrip()
    return stripped


def _extract_highlight_and_detailed(text: str | None) -> tuple[str | None, str | None]:
    """Extract highlight and detailed summaries from JSON-like text."""
    if not text:
        return None, None
    candidate = _strip_code_fences(text)
    parsed = _safe_json_loads(candidate)
    if not isinstance(parsed, dict):
        return None, None
    highlight = parsed.get('highlightSummary') or parsed.get('summary')
    if isinstance(highlight, dict):
        highlight = highlight.get('highlightSummary') or highlight.get('summary')
    detailed = parsed.get('detailedSummary') or parsed.get('analysis')
    if isinstance(detailed, dict):
        detailed = detailed.get('detailedSummary') or detailed.get('analysis')
    highlight = highlight if isinstance(highlight, str) else None
    detailed = detailed if isinstance(detailed, str) else None
    return highlight, detailed


def _structure_inventory_message(message: str) -> Dict[str, Any]:
    # Updated 2024-11-19: Fixed JSON parsing to extract highlightSummary and detailedSummary as strings
    parsed_payload = None
    if isinstance(message, str):
        sanitized = _strip_code_fences(message)
        parsed_payload = _safe_json_loads(sanitized)
        if not isinstance(parsed_payload, dict) and '{' in sanitized and '}' in sanitized:
            # Attempt to parse substring that looks like JSON if the whole string failed
            json_like = sanitized[sanitized.find('{'): sanitized.rfind('}') + 1]
            parsed_payload = _safe_json_loads(json_like)
    elif isinstance(message, dict):
        parsed_payload = message
    
    # CRITICAL FIX: If we got a dict with a 'message' field, parse that too (double-encoded JSON)
    if isinstance(parsed_payload, dict) and 'message' in parsed_payload:
        inner_message = parsed_payload.get('message')
        if isinstance(inner_message, str):
            logger.info("Inventory response has nested JSON in 'message' field, parsing again")
            inner_parsed = _safe_json_loads(inner_message)
            if isinstance(inner_parsed, dict):
                parsed_payload = inner_parsed
                logger.info(f"Successfully parsed inner JSON with keys: {list(inner_parsed.keys())}")
    
    # Check if we successfully parsed JSON with the expected structure
    if isinstance(parsed_payload, dict):
        logger.info(f"Parsed inventory payload keys: {list(parsed_payload.keys())}")
        
        # Extract highlight and detailed summaries - ensure they're strings, not dicts
        highlight_summary = parsed_payload.get('highlightSummary')
        if not highlight_summary:
            # Fallback to 'summary' field, but make sure it's a string
            summary_field = parsed_payload.get('summary')
            if isinstance(summary_field, str):
                # Check if summary_field is itself a JSON string that needs parsing
                if summary_field.strip().startswith('{'):
                    nested_parsed = _safe_json_loads(summary_field)
                    if isinstance(nested_parsed, dict):
                        highlight_summary = nested_parsed.get('highlightSummary', summary_field)
                    else:
                        highlight_summary = summary_field
                else:
                    highlight_summary = summary_field
            elif isinstance(summary_field, dict):
                # If summary is a dict, it might contain highlightSummary
                logger.warning(f"summary field is a dict: {summary_field}")
                highlight_summary = summary_field.get('highlightSummary', str(summary_field))
            else:
                highlight_summary = parsed_payload.get('message', '')
        
        detailed_summary = parsed_payload.get('detailedSummary')
        if not detailed_summary:
            # Fallback to 'analysis' field
            analysis_field = parsed_payload.get('analysis')
            if isinstance(analysis_field, str):
                # Check if analysis_field is itself a JSON string that needs parsing
                if analysis_field.strip().startswith('{'):
                    nested_parsed = _safe_json_loads(analysis_field)
                    if isinstance(nested_parsed, dict):
                        detailed_summary = nested_parsed.get('detailedSummary', analysis_field)
                    else:
                        detailed_summary = analysis_field
                else:
                    detailed_summary = analysis_field
            elif isinstance(analysis_field, dict):
                # If analysis is a dict, it might contain detailedSummary
                logger.warning(f"analysis field is a dict: {analysis_field}")
                detailed_summary = analysis_field.get('detailedSummary', str(analysis_field))
            else:
                detailed_summary = ''
        
        # Ensure they're strings - if they're still dicts or other types, convert
        if not isinstance(highlight_summary, str):
            logger.error(f"CRITICAL: highlight_summary is {type(highlight_summary)}, converting to string")
            highlight_summary = str(highlight_summary) if highlight_summary else ''
        if not isinstance(detailed_summary, str):
            logger.error(f"CRITICAL: detailed_summary is {type(detailed_summary)}, converting to string")
            detailed_summary = str(detailed_summary) if detailed_summary else ''
        
        # CRITICAL FIX: If highlight_summary still looks like JSON (starts with '{'), try to extract text
        if isinstance(highlight_summary, str) and highlight_summary.strip().startswith('{'):
            logger.warning("highlight_summary appears to be JSON string, attempting to parse")
            nested_parsed = _safe_json_loads(highlight_summary)
            if isinstance(nested_parsed, dict):
                highlight_summary = nested_parsed.get('highlightSummary', nested_parsed.get('summary', highlight_summary))
        
        # CRITICAL FIX: If detailed_summary still looks like JSON (starts with '{'), try to extract text
        if isinstance(detailed_summary, str) and detailed_summary.strip().startswith('{'):
            logger.warning("detailed_summary appears to be JSON string, attempting to parse")
            nested_parsed = _safe_json_loads(detailed_summary)
            if isinstance(nested_parsed, dict):
                detailed_summary = nested_parsed.get('detailedSummary', nested_parsed.get('analysis', detailed_summary))
        
        data: Dict[str, Any] = {
            'status': parsed_payload.get('status', 'unknown'),
            'summary': highlight_summary,  # Use highlightSummary for the summary field
            'detailedSummary': detailed_summary,  # Add detailedSummary field
            'blockers': parsed_payload.get('blockers', []),
            'metrics': parsed_payload.get('metrics', {}),
            'recommendations': parsed_payload.get('recommendations', []),
        }
        if parsed_payload.get('shortages'):
            data['metrics']['shortages'] = parsed_payload.get('shortages')
            if not data['blockers']:
                data['blockers'] = [
                    f"{item.get('productId')} shortage ({item.get('shortage')} units)"
                    for item in parsed_payload.get('shortages', [])
                    if isinstance(item, dict) and item.get('productId')
                ]
        if parsed_payload.get('confidence') is not None:
            data['confidence'] = parsed_payload.get('confidence')
        
        logger.info(f"Structured inventory response - summary: '{data['summary'][:100]}...', detailedSummary: '{data['detailedSummary'][:100] if data['detailedSummary'] else 'None'}...'")
        return data

    # Fallback: If JSON parsing failed, try to extract text from the message
    clean_text = _unwrap_agent_message(_strip_code_fences(message) if isinstance(message, str) else message)
    
    # CRITICAL FIX: If clean_text looks like JSON, try to parse it one more time
    if isinstance(clean_text, str) and clean_text.strip().startswith('{'):
        logger.warning("Fallback: clean_text appears to be JSON, attempting final parse")
        final_parsed = _safe_json_loads(clean_text)
        if isinstance(final_parsed, dict):
            # Extract highlightSummary and detailedSummary from the parsed JSON
            highlight_summary = final_parsed.get('highlightSummary') or final_parsed.get('summary', '')
            detailed_summary = final_parsed.get('detailedSummary') or final_parsed.get('analysis', '')
            
            # Ensure they're strings
            if not isinstance(highlight_summary, str):
                highlight_summary = str(highlight_summary) if highlight_summary else ''
            if not isinstance(detailed_summary, str):
                detailed_summary = str(detailed_summary) if detailed_summary else ''
            
            data: Dict[str, Any] = {
                'status': final_parsed.get('status', 'unknown'),
                'summary': highlight_summary,  # Use extracted highlightSummary
                'detailedSummary': detailed_summary,  # Use extracted detailedSummary
                'blockers': final_parsed.get('blockers', []),
                'metrics': final_parsed.get('metrics', {}),
                'recommendations': final_parsed.get('recommendations', []),
            }
            if final_parsed.get('shortages'):
                data['metrics']['shortages'] = final_parsed.get('shortages')
                if not data['blockers']:
                    data['blockers'] = [
                        f"{item.get('productId')} shortage ({item.get('shortage')} units)"
                        for item in final_parsed.get('shortages', [])
                        if isinstance(item, dict) and item.get('productId')
                    ]
            if final_parsed.get('confidence') is not None:
                data['confidence'] = final_parsed.get('confidence')
            logger.info(f"Fallback parse successful - summary: '{data['summary'][:100]}...'")
            return data
    
    # Last resort: use clean_text as-is (but log a warning)
    logger.warning(f"Could not parse inventory message as JSON, using raw text (length: {len(clean_text)})")
    data: Dict[str, Any] = {
        'status': 'unknown',
        'summary': clean_text,
        'blockers': [],
        'metrics': {},
        'recommendations': [],
    }
    shortages: List[Dict[str, Any]] = []
    surplus: List[Dict[str, Any]] = []
    legacy_pattern = re.compile(
        r'Product ID:\s*(?P<product>[A-Za-z0-9\-\_]+).*?Required:\s*(?P<required>\d+).*?Available:\s*(?P<available>\d+).*?(Shortage|Surplus):\s*(?P<delta>\d+)',
        re.IGNORECASE | re.DOTALL,
    )
    bullet_patterns = [
        re.compile(
            r'^(?:-|\*)\s*Product ID:\s*(?P<product>[A-Za-z0-9\-\_]+).*?Required\s*(?P<required>\d+).*?available\s*(?P<available>\d+).*?(shortage|surplus)(?:\s+of)?\s*(?P<delta>\d+)',
            re.IGNORECASE,
        ),
        re.compile(
            r'^(?:-|\*)\s*Product ID:\s*(?P<product>[A-Za-z0-9\-\_]+).*?(shortage|surplus)\s*[:\-]?\s*(?P<delta>\d+)',
            re.IGNORECASE,
        ),
    ]

    for match in legacy_pattern.finditer(clean_text):
        product = _sanitize_product_id(match.group('product'))
        required = int(match.group('required'))
        available = int(match.group('available'))
        delta = int(match.group('delta'))
        label = match.group(4).lower()
        if 'shortage' in label:
            shortages.append({'productId': product, 'required': required, 'available': available, 'shortage': delta})
        else:
            surplus.append({'productId': product, 'required': required, 'available': available, 'surplus': delta})

    for line in clean_text.splitlines():
        line = line.strip()
        if not line or line[0] not in {'-', '*'}:
            continue
        for pattern in bullet_patterns:
            bullet_match = pattern.search(line)
            if not bullet_match:
                continue
            product = _sanitize_product_id(bullet_match.group('product'))
            label = bullet_match.group(2).lower() if bullet_match.lastindex and bullet_match.lastindex >= 2 else ''
            required = (
                int(bullet_match.group('required'))
                if 'required' in bullet_match.groupdict() and bullet_match.group('required')
                else None
            )
            available = (
                int(bullet_match.group('available'))
                if 'available' in bullet_match.groupdict() and bullet_match.group('available')
                else None
            )
            delta = int(bullet_match.group('delta'))
            entry = {'productId': product}
            if required is not None:
                entry['required'] = required
            if available is not None:
                entry['available'] = available
            if 'shortage' in label:
                entry['shortage'] = delta
                if not any(s.get('productId') == product for s in shortages):
                    shortages.append(entry)
            else:
                entry['surplus'] = delta
                if not any(s.get('productId') == product for s in surplus):
                    surplus.append(entry)
            break
    if shortages:
        data['status'] = 'shortfall'
        data['blockers'] = [
            f"{item['productId']} shortage ({item.get('shortage', 0)} units)" for item in shortages
        ]
        data['metrics']['shortages'] = shortages
        data['recommendations'].append('Initiate replenishment for shortage SKUs')
    elif 'not possible' in clean_text.lower() or 'cannot fulfill' in clean_text.lower():
        data['status'] = 'shortfall'
        data['blockers'].append('Inventory levels insufficient for all orders')
        data['recommendations'].append('Investigate emergency procurement options')
    elif 'sufficient' in clean_text.lower() or 'can fulfill' in clean_text.lower():
        data['status'] = 'sufficient'
        if surplus:
            data['metrics']['surplus'] = surplus
            data['recommendations'].append('Continue monitoring surplus SKUs for redeployment')
    return data


def _structure_demand_message(message: str) -> Dict[str, Any]:
    parsed: Any = None
    if isinstance(message, str):
        parsed = _safe_json_loads(message)
    elif isinstance(message, dict):
        parsed = message
    
    # CRITICAL FIX: Handle double-encoded JSON
    if isinstance(parsed, dict) and 'message' in parsed:
        inner_message = parsed.get('message')
        if isinstance(inner_message, str):
            logger.info("Demand response has nested JSON in 'message' field, parsing again")
            inner_parsed = _safe_json_loads(inner_message)
            if isinstance(inner_parsed, dict):
                parsed = inner_parsed
                logger.info(f"Successfully parsed inner JSON with keys: {list(inner_parsed.keys())}")
    
    if isinstance(parsed, dict) and any(key in parsed for key in ('summary', 'highlightSummary', 'totalPendingOrders', 'highDemandProducts', 'metrics')):
        # Extract highlight and detailed summaries
        highlight_summary = parsed.get('highlightSummary') or parsed.get('summary') or parsed.get('message') or ''
        detailed_summary = parsed.get('detailedSummary') or parsed.get('analysis') or ''
        
        metrics = parsed.get('metrics') or {}
        if not metrics:
            metrics = {
                'totalPendingOrders': parsed.get('totalPendingOrders'),
                'ordersWithLineItems': parsed.get('ordersWithLineItems'),
                'revenueAtRisk': parsed.get('revenueAtRisk') or parsed.get('totalOrderValue'),
                'marginAtRisk': parsed.get('marginAtRisk'),
                'averageOrderSize': parsed.get('averageOrderSize'),
                'demandVelocity': parsed.get('demandVelocity'),
            }
        return {
            'status': parsed.get('status', 'insight'),
            'summary': highlight_summary,  # For Agent Highlights
            'detailedSummary': detailed_summary,  # For Agent Insights
            'blockers': parsed.get('riskSignals', []),
            'metrics': metrics,
            'recommendations': parsed.get('recommendations', []),
            'highDemandProducts': parsed.get('highDemandProducts', []),
            'confidence': parsed.get('confidence'),
        }

    clean_text = _unwrap_agent_message(message)
    parsed = _safe_json_loads(clean_text)
    data = {
        'status': 'unknown',
        'summary': clean_text,
        'blockers': [],
        'metrics': {},
        'recommendations': [],
    }
    if isinstance(parsed, dict):
        total_orders = parsed.get('totalPendingOrders') or parsed.get('totalOrders')
        high_demand = parsed.get('highDemandProducts') or []
        total_value = parsed.get('totalOrderValue')
        demand_trend = parsed.get('demandTrend') or parsed.get('recommendation')
        avg_size = parsed.get('averageOrderSize')
        summary_lines = []
        if total_orders is not None:
            summary_lines.append(f"Pending orders: {total_orders}")
        if total_value:
            summary_lines.append(f"Open-order value: ${float(total_value):,.2f}")
        if avg_size:
            summary_lines.append(f"Average lines per order: {avg_size}")
        if high_demand:
            top_products = ", ".join(f"{item.get('productId')} ({item.get('orderedQuantity', item.get('orderCount', 0))} units)" for item in high_demand[:3])
            summary_lines.append(f"Top demand drivers: {top_products}")
        if demand_trend:
            summary_lines.append(f"Demand outlook: {demand_trend}")
        data['summary'] = '\n'.join(summary_lines) if summary_lines else parsed.get('summary') or clean_text
        data['metrics'] = {
            'totalPendingOrders': total_orders,
            'totalOrderValue': total_value,
            'averageOrderSize': avg_size,
            'highDemandProducts': high_demand,
            'demandTrend': demand_trend,
        }
        if parsed.get('surgeDetected'):
            data['blockers'].append('Demand surge detected in recent orders')
        data['status'] = 'insight'
        if parsed.get('message') == 'No pending orders to analyze':
            data['status'] = 'neutral'
            data['recommendations'].append('Monitor incoming demand for changes in order volume')
        elif high_demand:
            data['recommendations'].append('Align supply for high-velocity SKUs to avoid revenue risk')
        return data

    lower = clean_text.lower()
    if 'need to know' in lower or 'do you have' in lower or 'please provide' in lower:
        data['status'] = 'data_gap'
        data['recommendations'].append('Share latest inventory snapshot with demand analyst')
    elif 'demand' in lower or 'forecast' in lower:
        data['status'] = 'insight'
    return data


def _structure_logistics_message(message: str) -> Dict[str, Any]:
    parsed: Any = None
    if isinstance(message, str):
        parsed = _safe_json_loads(message)
    elif isinstance(message, dict):
        parsed = message
    
    # CRITICAL FIX: If we got a dict with a 'message' field, parse that too (double-encoded JSON)
    if isinstance(parsed, dict) and 'message' in parsed:
        inner_message = parsed.get('message')
        if isinstance(inner_message, str):
            logger.info("Logistics response has nested JSON in 'message' field, parsing again")
            inner_parsed = _safe_json_loads(inner_message)
            if isinstance(inner_parsed, dict):
                parsed = inner_parsed
                logger.info(f"Successfully parsed inner JSON with keys: {list(inner_parsed.keys())}")
    
    if isinstance(parsed, dict) and any(key in parsed for key in ('summary', 'highlightSummary', 'metrics', 'ordersNeedingRoutes', 'capacityUtilization')):
        # Extract highlight and detailed summaries
        highlight_summary = parsed.get('highlightSummary') or parsed.get('summary') or parsed.get('message') or ''
        detailed_summary = parsed.get('detailedSummary') or parsed.get('analysis') or ''
        
        metrics = parsed.get('metrics') or {
            'totalPendingOrders': parsed.get('totalPendingOrders'),
            'ordersWithRoutes': parsed.get('ordersWithRoutes'),
            'ordersNeedingRoutes': parsed.get('ordersNeedingRoutes'),
            'maxDailyCapacity': parsed.get('maxDailyCapacity'),
            'capacityUtilization': parsed.get('capacityUtilization'),
        }
        return {
            'status': parsed.get('status', 'unknown'),
            'summary': highlight_summary,  # For Agent Highlights
            'detailedSummary': detailed_summary,  # For Agent Insights
            'blockers': parsed.get('blockers', []),
            'metrics': metrics,
            'recommendations': parsed.get('recommendations', []),
            'confidence': parsed.get('confidence'),
        }

    clean_text = _unwrap_agent_message(message)
    data = {
        'status': 'unknown',
        'summary': clean_text,
        'blockers': [],
        'metrics': {},
        'recommendations': [],
    }
    parsed = _safe_json_loads(clean_text)
    if isinstance(parsed, dict):
        capacity_utilization = parsed.get('capacityUtilization')
        can_fulfill_all = parsed.get('canFulfillAll')
        orders_needing_routes = parsed.get('ordersNeedingRoutes')
        total_orders = parsed.get('totalPendingOrders')
        data['metrics'] = {
            'totalPendingOrders': total_orders,
            'ordersNeedingRoutes': orders_needing_routes,
            'ordersWithRoutes': parsed.get('ordersWithRoutes'),
            'capacityUtilization': capacity_utilization,
            'maxDailyCapacity': parsed.get('maxDailyCapacity'),
        }
        summary_bits = []
        if total_orders is not None and capacity_utilization:
            summary_bits.append(f"Pending orders: {total_orders} | Utilization: {capacity_utilization}")
        if orders_needing_routes:
            summary_bits.append(f"Orders lacking routes: {orders_needing_routes}")
        if parsed.get('recommendation'):
            summary_bits.append(parsed['recommendation'])
        data['summary'] = '\n'.join(summary_bits) if summary_bits else parsed.get('summary') or clean_text
        if can_fulfill_all is True:
            data['status'] = 'clear'
            data['recommendations'].append('Proceed with planned carrier assignments; monitor utilization.')
        else:
            data['status'] = 'constraint'
            data['blockers'].append('Logistics capacity below order volume')
            if orders_needing_routes:
                data['blockers'].append(f"{orders_needing_routes} orders lack assigned routes")
            data['recommendations'].append('Activate overflow carriers or expedite routing for backlogged orders')
        return data

    lower = clean_text.lower()
    if 'confidently fulfill' in lower or ('capacity' in lower and 'constraint' not in lower):
        data['status'] = 'clear'
    elif 'constraint' in lower or 'bottleneck' in lower or 'delay' in lower:
        data['status'] = 'constraint'
        data['recommendations'].append('Review logistics capacity and potential carrier options')
    return data


def _structure_risk_message(message: str) -> Dict[str, Any]:
    parsed: Any = None
    if isinstance(message, str):
        parsed = _safe_json_loads(message)
    elif isinstance(message, dict):
        parsed = message
    if isinstance(parsed, dict) and any(key in parsed for key in ('overallRiskScore', 'riskLevel', 'riskCategories', 'topRisks')):
        metrics = parsed.get('metrics') or {
            'overallRiskScore': parsed.get('overallRiskScore'),
            'riskLevel': parsed.get('riskLevel'),
            'riskCategories': parsed.get('riskCategories'),
            'exposureSummary': parsed.get('exposureSummary'),
        }
        return {
            'status': (parsed.get('riskLevel') or parsed.get('status') or '').lower() or 'medium',
            'summary': parsed.get('summary') or parsed.get('message') or '',
            'blockers': parsed.get('riskFactors') or [
                f"{item.get('category', 'risk').title()}: {item.get('risk')}"
                for item in parsed.get('topRisks', []) if isinstance(item, dict)
            ],
            'metrics': metrics,
            'recommendations': parsed.get('mitigationStrategies') or parsed.get('recommendations', []),
            'confidence': parsed.get('confidence'),
        }

    clean_text = _unwrap_agent_message(message)
    data = {
        'status': 'unknown',
        'summary': clean_text,
        'blockers': [],
        'metrics': {},
        'recommendations': [],
    }
    parsed = _safe_json_loads(clean_text)
    if isinstance(parsed, dict):
        overall_score = parsed.get('overallRiskScore')
        risk_level = parsed.get('riskLevel')
        top_risks = parsed.get('topRisks') or []
        mitigation = parsed.get('mitigationStrategies') or []
        categories = parsed.get('riskCategories') or {}
        data['metrics'] = {
            'overallRiskScore': overall_score,
            'riskLevel': risk_level,
            'riskCategories': categories,
        }
        summary_lines = []
        if risk_level:
            summary_lines.append(f"Overall risk level: {risk_level}")
        if overall_score is not None:
            summary_lines.append(f"Risk score: {overall_score:.2f}")
        if top_risks:
            summary_lines.append("Top risks: " + ", ".join(risk.get('risk') for risk in top_risks[:3]))
        data['summary'] = '\n'.join(summary_lines) if summary_lines else parsed.get('summary') or clean_text
        data['status'] = (risk_level or 'medium').lower()
        for item in top_risks[:3]:
            risk_desc = item.get('risk')
            if risk_desc:
                data['blockers'].append(f"{item.get('category', 'risk').title()}: {risk_desc}")
        if mitigation:
            data['recommendations'].extend(mitigation[:4])
        return data

    lower = clean_text.lower()
    if 'high' in lower:
        data['status'] = 'high'
        data['blockers'].append('Risk profile elevated')
    elif 'medium' in lower:
        data['status'] = 'medium'
    elif 'low' in lower:
        data['status'] = 'low'
    mitigation: List[str] = []
    for line in message.splitlines():
        if line.strip().startswith(('-', '*')):
            mitigation.append(line.strip('-* ').strip())
    if mitigation:
        data['recommendations'].extend(mitigation)
    return data


def structure_agent_response(agent_type: str, response_text: str) -> Dict[str, Any]:
    logger.info("=" * 80)
    logger.info(f"ORCHESTRATOR - Structuring {agent_type} response")
    logger.info(f"Response length: {len(response_text) if response_text else 0}")
    logger.info(f"Response preview: {response_text[:500] if response_text else 'None'}...")
    logger.info("=" * 80)
    
    if not response_text:
        return {
            'status': 'unknown',
            'summary': 'No response received from agent',
            'blockers': [],
            'metrics': {},
            'recommendations': [],
        }
    if agent_type == 'inventory':
        structured = _structure_inventory_message(response_text)
        structured['raw'] = response_text
        logger.info(f"ORCHESTRATOR - Structured inventory keys: {list(structured.keys())}")
        logger.info(f"ORCHESTRATOR - Summary type: {type(structured.get('summary'))}, value: {str(structured.get('summary'))[:200]}")
        logger.info(f"ORCHESTRATOR - DetailedSummary type: {type(structured.get('detailedSummary'))}, value: {str(structured.get('detailedSummary'))[:200] if structured.get('detailedSummary') else 'None'}")
        return structured
    if agent_type == 'demand':
        structured = _structure_demand_message(response_text)
        structured['raw'] = response_text
        return structured
    if agent_type == 'logistics':
        structured = _structure_logistics_message(response_text)
        structured['raw'] = response_text
        return structured
    if agent_type == 'risk':
        structured = _structure_risk_message(response_text)
        structured['raw'] = response_text
        return structured
    return {
        'status': 'info',
        'summary': _unwrap_agent_message(response_text),
        'blockers': [],
        'metrics': {},
        'recommendations': [],
        'raw': response_text,
    }


def _get_runtime_arn(agent_type: str) -> Optional[str]:
    if agent_type in _runtime_cache:
        return _runtime_cache[agent_type]
    param_name = f'/supplysense/agents/{agent_type}/invoke-arn'
    try:
        response = ssm.get_parameter(Name=param_name)
        value = response['Parameter']['Value']
        runtime_arn = value.split('/runtime-endpoint/')[0] if '/runtime-endpoint/' in value else value
        _runtime_cache[agent_type] = runtime_arn
        return runtime_arn
    except Exception as exc:
        logger.warning("Unable to resolve runtime ARN for %s: %s", agent_type, exc)
        return None


def _invoke_specialist(
    agent_type: str,
    query: str,
    session_id: str,
    context: Dict[str, Any],
    bearer_token: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    runtime_arn = _get_runtime_arn(agent_type)
    if not runtime_arn:
        return None
    guidance = {
        'inventory': (
            "Focus on current stock positions versus pending order demand. Quantify shortages or surplus by SKU, "
            "and recommend procurement actions."
        ),
        'demand': (
            "Analyze order velocity, revenue at risk, and demand trends. Highlight top products driving demand, "
            "and note forecast or margin impacts. Avoid repeating raw inventory shortages unless demand is the driver."
        ),
        'logistics': (
            "Assess fulfillment capacity, carrier constraints, and routing risks. Provide utilization metrics, impacted shipments, "
            "and concrete mitigation options (overflow carriers, expedited lanes)."
        ),
        'risk': (
            "Quantify overall risk (0-1), assign a risk level, and list top risk drivers with mitigation actions. "
            "Incorporate dependencies between inventory, demand, and logistics."
        ),
    }
    payload_text = (
        "You are the {agent} specialist collaborating within SupplySense.\n"
        "Primary task: {guidance}\n"
        "User query: \"{query}\"\n"
        "Context so far: {context}\n"
        "Respond with specialist insights, including blockers, quantitative metrics, recommendations, and an explicit confidence indicator."
    ).format(
        agent=agent_type.capitalize(),
        guidance=guidance.get(agent_type, "Add unique specialist insights."),
        query=query,
        context=json.dumps(context),
    )
    if not bearer_token:
        logger.error("Missing bearer token when invoking %s agent; cannot call runtime", agent_type)
        return {
            'agentType': agent_type,
            'response': 'Error invoking agent: missing bearer token',
            'confidence': 0,
            'timestamp': datetime.now(timezone.utc).isoformat() + 'Z',
            'structured': {
                'status': 'error',
                'summary': 'Missing bearer token for specialist invocation',
                'blockers': ['Unable to authenticate to specialist runtime without bearer token'],
                'metrics': {},
                'recommendations': [],
            }
        }
    try:
        result = http_client.invoke_endpoint(
            runtime_arn,
            {'prompt': payload_text},
            session_id,
            bearer_token,
            'DEFAULT'
        )
    except Exception as exc:
        logger.error("Specialist invocation failed for %s: %s", agent_type, exc, exc_info=True)
        return {
            'agentType': agent_type,
            'response': f'Error invoking {agent_type}: {exc}',
            'confidence': 0,
            'timestamp': datetime.now(timezone.utc).isoformat() + 'Z',
            'structured': {
                'status': 'error',
                'summary': str(exc),
                'blockers': [str(exc)],
                'metrics': {},
                'recommendations': [],
            }
        }

    response_text = result.get('message') or result.get('response') or result.get('completion') or str(result)
    structured = structure_agent_response(agent_type, response_text)
    confidence_value = _infer_confidence(agent_type, structured)
    structured['confidence'] = confidence_value
    return {
        'agentType': agent_type,
        'response': response_text,
        'confidence': confidence_value,
        'timestamp': datetime.now(timezone.utc).isoformat() + 'Z',
        'structured': structured,
    }


def _generate_plan(query: str, context: Optional[Dict[str, Any]] = None) -> Tuple[List[str], str]:
    default_plan = ['inventory', 'demand', 'logistics', 'risk']
    allowed_agents = {
        'inventory': (
            'Analyze stock positions, shortages, replenishment needs, and SKU-level inventory status. '
            'Use when questions involve: stock levels, shortages, stockouts, replenishment, inventory positions, '
            'warehouse stock, available inventory, or product availability.'
        ),
        'demand': (
            'Forecast demand trends, analyze order velocity, identify high-demand products, and assess revenue/margin at risk. '
            'Use when questions involve: demand forecasting, demand trends, order patterns, demand surges, '
            'revenue impact, demand-driven planning, or forecasting.'
        ),
        'logistics': (
            'Assess fulfillment capacity, routing constraints, carrier performance, delivery optimization, and shipping constraints. '
            'Use when questions involve: logistics, carriers, shipping, delivery, routing, fulfillment capacity, '
            'transportation, expedited shipments, or delivery optimization.'
        ),
        'risk': (
            'Quantify enterprise risk posture, assess cross-domain exposure, identify risk factors, and recommend mitigation strategies. '
            'Use when questions involve: risk assessment, risk exposure, disruptions, delays, SLA compliance, '
            'risk mitigation, supplier reliability, or impact analysis.'
        ),
    }

    context_snippet = ''
    if context:
        try:
            context_snippet = json.dumps(context)[:1000]
        except Exception:
            context_snippet = str(context)[:1000]

    planner_prompt = (
        "You are the SupplySense Orchestrator. Analyze the user query and determine which specialist agents are "
        "REQUIRED to provide a complete answer. Only include agents whose expertise is directly relevant to the question.\n\n"
        "Available specialists:\n"
        + "\n".join(f"- {name}: {desc}" for name, desc in allowed_agents.items())
        + "\n\n"
        "Guidelines for agent selection:\n"
        "- Include ONLY agents whose domain expertise is needed to answer the question.\n"
        "- For questions about logistics/carriers/shipping, include 'logistics'.\n"
        "- For questions about stock levels/shortages/replenishment, include 'inventory'.\n"
        "- For questions about demand trends/forecasting/order patterns, include 'demand'.\n"
        "- For questions about risk/disruptions/impact/SLA, include 'risk'.\n"
        "- For fulfillment questions, typically include 'inventory' and 'logistics' (and 'risk' if assessing exposure).\n"
        "- For demand planning questions, typically include 'demand' and 'inventory'.\n"
        "- For carrier comparison questions, include 'logistics' only.\n"
        "- For revenue impact questions, include 'demand' and 'risk'.\n"
        "- For executive briefings, include all relevant agents based on the briefing scope.\n"
        "- DO NOT include agents just because they might be useful—only if they're necessary for the answer.\n\n"
        "Return ONLY a JSON object with this exact shape:\n"
        '{"plan": ["agent1", "agent2"], "queryType": "descriptive_snake_case"}\n'
        "Rules:\n"
        "- plan: array of agent identifiers (lowercase) in execution order. Must include at least one agent.\n"
        "- queryType: short machine-friendly string (snake_case) describing the query category.\n"
        "- Do not add commentary, markdown, or code fences—only valid JSON.\n"
    )

    planner_prompt += f"\nUser query: \"{query.strip()}\"\n"
    if context_snippet:
        planner_prompt += f"Recent context (JSON snippet): {context_snippet}\n"

    try:
        response = _agent_planner(planner_prompt)
        text = response.message["content"][0]["text"].strip()
        if text.startswith("```"):
            lines = [line for line in text.splitlines() if not line.strip().startswith("```")]
            text = "\n".join(lines).strip()
        parsed = _safe_json_loads(text)
        if not isinstance(parsed, dict):
            raise ValueError("Planner response not JSON object")

        raw_plan = parsed.get('plan') or parsed.get('agents') or []
        plan: List[str] = []
        for item in raw_plan:
            agent = str(item).strip().lower()
            if agent in allowed_agents and agent not in plan:
                plan.append(agent)
        
        # Only fallback to default if plan is completely empty (parsing failure)
        if not plan:
            logger.warning("LLM returned empty plan; falling back to default plan")
            plan = default_plan.copy()
        else:
            # Optional guardrails: log warnings if obvious agents are missing (for debugging)
            query_lower = query.lower()
            if 'inventory' not in plan and any(word in query_lower for word in ['stock', 'inventory', 'shortage', 'replenish', 'sku']):
                logger.debug("Query mentions inventory-related terms but 'inventory' not in plan: %s", plan)
            if 'logistics' not in plan and any(word in query_lower for word in ['carrier', 'shipping', 'delivery', 'route', 'logistics', 'fulfill']):
                logger.debug("Query mentions logistics-related terms but 'logistics' not in plan: %s", plan)
            if 'demand' not in plan and any(word in query_lower for word in ['demand', 'forecast', 'trend', 'order pattern']):
                logger.debug("Query mentions demand-related terms but 'demand' not in plan: %s", plan)
            if 'risk' not in plan and any(word in query_lower for word in ['risk', 'disruption', 'delay', 'sla', 'impact']):
                logger.debug("Query mentions risk-related terms but 'risk' not in plan: %s", plan)
        
        query_type = parsed.get('queryType') or parsed.get('query_type') or 'general_query'
        query_type = str(query_type).strip() or 'general_query'
        return plan, query_type
    except Exception as exc:
        logger.warning("Planner generation failed (%s); using default plan.", exc, exc_info=True)
        return default_plan.copy(), 'general_query'


def _run_orchestrated_flow(query: str, session_id: str, bearer_token: Optional[str] = None) -> Dict[str, Any]:
    plan, query_type = _generate_plan(query)
    logger.info("LLM plan: %s (query_type=%s)", plan, query_type)
    events: List[Dict[str, Any]] = [{
        'type': 'analysis',
        'message': f"Orchestrator plan: executing {len(plan)} agent(s) -> {', '.join(plan)}",
        'agents': plan,
        'queryType': query_type,
        'timestamp': datetime.now(timezone.utc).isoformat() + 'Z',
    }]

    agent_results: List[Dict[str, Any]] = []
    context = {'completedAgents': []}

    for agent_type in plan:
        events.append({
            'type': 'agent_start',
            'agent': agent_type,
            'message': f'{agent_type.capitalize()} agent analyzing...',
            'timestamp': datetime.now(timezone.utc).isoformat() + 'Z',
        })
        logger.info(
            "Invoking specialist %s (bearer token provided=%s)",
            agent_type,
            bool(bearer_token)
        )
        if bearer_token:
            logger.debug("Bearer token prefix for %s: %s...", agent_type, bearer_token[:12])
        result = _invoke_specialist(agent_type, query, session_id, context, bearer_token=bearer_token)
        if not result:
            events.append({
                'type': 'agent_result',
                'agent': agent_type,
                'status': 'skipped',
                'message': f'{agent_type} agent unavailable.',
                'timestamp': datetime.now(timezone.utc).isoformat() + 'Z',
            })
            continue
        agent_results.append(result)
        context['completedAgents'].append({
            'agentType': agent_type,
            'summary': result['structured'].get('summary'),
            'status': result['structured'].get('status'),
        })
        events.append({
            'type': 'agent_result',
            'agent': agent_type,
            'message': result['structured'].get('summary'),
            'status': result['structured'].get('status'),
            'timestamp': datetime.now(timezone.utc).isoformat() + 'Z',
        })

    fused = _build_fused_response({
        'agentResults': agent_results,
        'analysis': {'type': query_type},
        'sessionId': session_id,
        'userQuery': query,  # Pass original query for LLM synthesis
    })
    fused['events'] = events
    fused['agentResults'] = agent_results
    fused['queryType'] = query_type
    return fused


@tool
def orchestrate_fulfillment(
    timeframe: str = "weekly",
    order_ids: list[str] | None = None,
    constraints: dict[str, Any] | None = None,
) -> str:
    """Orchestrate multi-agent analysis to determine fulfillment capability for orders."""
    try:
        logger.info(f"Starting fulfillment orchestration for timeframe: {timeframe}")
        constraints = constraints or {}
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
        
        # Step 2: Call real Inventory Agent
        inventory_result = _invoke_specialist('inventory', f"Analyze fulfillment capacity for {len(orders)} orders in {timeframe}", "", {}, bearer_token=None)
        inventory_analysis = inventory_result.get('structured', {}) if inventory_result else {}
        
        # Step 3: Call real Demand Agent
        demand_result = _invoke_specialist('demand', f"Analyze demand patterns for {len(orders)} orders in {timeframe}", "", {}, bearer_token=None)
        demand_analysis = demand_result.get('structured', {}) if demand_result else {}
        
        # Step 4: Call real Logistics Agent
        logistics_result = _invoke_specialist('logistics', f"Assess logistics capability for {len(orders)} orders in {timeframe}", "", {}, bearer_token=None)
        logistics_analysis = logistics_result.get('structured', {}) if logistics_result else {}
        
        # Step 5: Call real Risk Agent
        risk_result = _invoke_specialist('risk', f"Assess supply chain risks for {len(orders)} orders in {timeframe}", "", {}, bearer_token=None)
        risk_analysis = risk_result.get('structured', {}) if risk_result else {}
        
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
def create_action_plan(
    scenario: str,
    priority: str = "high",
    constraints: dict[str, Any] | None = None,
) -> str:
    """Create comprehensive action plans for supply chain scenarios."""
    try:
        logger.info(f"Creating action plan for scenario: {scenario}")
        constraints = constraints or {}
        
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
def synthesize_multi_agent_response(
    agent_responses: list[dict[str, Any]] | None,
    original_query: str,
    context: dict[str, Any] | None = None,
) -> str:
    """Synthesize responses from multiple agents into a comprehensive answer."""
    try:
        logger.info(f"Synthesizing responses from {len(agent_responses or [])} agents")
        agent_responses = agent_responses or []
        context = context or {}
        # Extract key insights from each agent
        inventory_insights = []
        demand_insights = []
        logistics_insights = []
        risk_insights = []
        
        for response in agent_responses or []:
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
                "agentsInvolved": len(agent_responses) if agent_responses else 0,
                "coordinationPattern": "parallel_analysis_with_synthesis",
                "executionTime": f"{len(agent_responses) * 3}s (estimated)" if agent_responses else "N/A"
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
            "agentResponseCount": len(agent_responses) if agent_responses else 0
        })

# Helper functions for orchestration
# Note: orchestrate_fulfillment tool now calls real agents via _invoke_specialist

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
            "Proceed with fulfillment as planned" if can_fulfill else "Address critical issues before proceeding",
            "Monitor key metrics during execution",
            "Review and adjust plan based on real-time data"
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
        recommendations.append("Address inventory optimization opportunities")
    if demand:
        recommendations.append("Implement demand-driven planning")
    if logistics:
        recommendations.append("Optimize logistics and delivery processes")
    if risk:
        recommendations.append("Implement risk mitigation strategies")
    
    recommendations.append("Establish continuous monitoring and adjustment processes")
    
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

def _generate_notification_draft(action_or_approval: Dict[str, Any], notification_type: str) -> Optional[Dict[str, str]]:
    """
    Generate notification draft using LLM for actions/approvals.
    This is called by the orchestrator to pre-draft notifications.
    """
    try:
        description = action_or_approval.get('description') or action_or_approval.get('title', '')
        owner = action_or_approval.get('owner') or action_or_approval.get('requires', 'Team')
        data = action_or_approval.get('data') or action_or_approval.get('details') or {}
        
        # Build context
        context_parts = [f"Action: {description}", f"Owner: {owner}"]
        
        # Add shortage details
        shortages = data.get('shortages', [])
        if shortages:
            context_parts.append(f"\nShortage Details:")
            for item in shortages[:5]:
                if isinstance(item, dict):
                    product_id = item.get('productId')
                    shortage_qty = item.get('shortage') or item.get('delta') or 0
                    if product_id:
                        context_parts.append(f"  - {product_id}: {shortage_qty} units short")
        
        # Add high-demand products
        high_demand = data.get('highDemandProducts', [])
        if high_demand:
            products = ', '.join(p.get('productId', '') for p in high_demand[:3] if isinstance(p, dict))
            if products:
                context_parts.append(f"\nHigh-Demand Products: {products}")
        
        # Add financial impact
        revenue_at_risk = data.get('revenueAtRisk')
        if revenue_at_risk:
            context_parts.append(f"\nRevenue at Risk: ${revenue_at_risk:,.2f}")
        
        demand_trend = data.get('demandTrend')
        if demand_trend:
            context_parts.append(f"\nDemand Trend: {demand_trend}")
        
        context_str = '\n'.join(context_parts)
        
        # Create prompt for notification
        prompt = f"""Generate a professional email notification for this supply chain action.

{context_str}

Create a professional email with:
1. Clear subject line (max 80 characters)
2. Professional greeting to {owner}
3. Specific details (SKU IDs, quantities, timelines)
4. Clear next steps
5. Professional closing

Respond ONLY with JSON:
{{"subject": "...", "body": "..."}}

Be specific and include actual SKU IDs and quantities."""

        # Use the narrative agent to generate
        response = _agent_narrative(prompt)
        text = response.message["content"][0]["text"]
        
        # Clean and parse
        clean_text = re.sub(r'<(thinking|analysis|response)>.*?</\1>', '', text, flags=re.DOTALL | re.IGNORECASE).strip()
        clean_text = re.sub(r'</?(thinking|analysis|response)>', '', clean_text, flags=re.IGNORECASE).strip()
        
        try:
            notification = json.loads(clean_text)
            if isinstance(notification, dict) and 'subject' in notification and 'body' in notification:
                logger.info(f"Generated notification: {notification['subject']}")
                return notification
        except json.JSONDecodeError:
            logger.warning("Failed to parse notification JSON")
        
    except Exception as e:
        logger.error(f"Error generating notification: {e}", exc_info=True)
    
    return None


def _build_agent(*, with_tools: bool = True) -> Agent:
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
    
    tools = [orchestrate_fulfillment, create_action_plan, synthesize_multi_agent_response] if with_tools else []
    return Agent(model=model, tools=tools, system_prompt=system_prompt)

_agent_planner = _build_agent(with_tools=False)
_agent_narrative = _build_agent(with_tools=False)

def _normalize_bearer_token(token: Optional[str]) -> Optional[str]:
    if not token:
        return None
    token = token.strip()
    if token.lower().startswith('bearer '):
        return token[7:].strip()
    return token or None


@app.entrypoint
def orchestrator_agent(request: RequestContext) -> Dict[str, Any]:
    """AgentCore entrypoint for orchestrator agent."""
    prompt = (request.get("prompt") or request.get("input") or "").strip()
    logger.info("Runtime received prompt: %s", prompt)
    if not prompt:
        return {
            "brand": "SupplySense",
            "message": "No prompt provided.",
        }

    structured_payload = _safe_json_loads(prompt)
    bearer_token = _normalize_bearer_token(request.get("bearer_token"))
    if not bearer_token and isinstance(structured_payload, dict):
        bearer_token = _normalize_bearer_token(
            structured_payload.get('bearerToken')
            or structured_payload.get('bearer_token')
        )
    if not bearer_token:
        headers = request.get("headers") or {}
        auth_header = headers.get("Authorization") or headers.get("authorization")
        if isinstance(auth_header, str) and auth_header.lower().startswith("bearer "):
            bearer_token = _normalize_bearer_token(auth_header)
    if not bearer_token:
        metadata = request.get("metadata") or {}
        maybe_token = metadata.get("bearer_token") or metadata.get("token")
        if isinstance(maybe_token, str):
            bearer_token = _normalize_bearer_token(maybe_token)
    try:
        logger.debug("Request context keys: %s", list(request.keys()))
    except Exception:  # pragma: no cover
        logger.debug("Unable to introspect request context keys")
    if isinstance(structured_payload, dict) and structured_payload.get('mode') == 'multi_agent_synthesis':
        fused = _build_fused_response(structured_payload)
        fused['mode'] = 'multi_agent_synthesis'

        narrative_prompt = (
            "You are the SupplySense Orchestrator Agent. Using the structured decision data below, "
            "craft a concise executive briefing that includes a leading statement, bullet summaries for each agent, "
            "and a short next-steps section. Stay factual and action-oriented. "
            f"\n\nStructured data:\n{json.dumps(fused, indent=2)}"
        )
        response = _agent_narrative(narrative_prompt)
        text = response.message["content"][0]["text"]
        logger.info("Runtime synthesis narrative generated successfully")

        clean_text = re.sub(r'<(thinking|analysis|response)>.*?</\1>', '', text, flags=re.DOTALL | re.IGNORECASE).strip()
        clean_text = re.sub(r'</?(thinking|analysis|response)>', '', clean_text, flags=re.IGNORECASE).strip()

        fused['narrative'] = clean_text
        return {
            "brand": "SupplySense",
            "message": json.dumps(fused),
        }
    if isinstance(structured_payload, dict) and structured_payload.get('mode') == 'orchestrator_conversation':
        query = structured_payload.get('query') or prompt
        session_id = structured_payload.get('sessionId') or f"session-{datetime.now(timezone.utc).timestamp()}"
        fused = _run_orchestrated_flow(query, session_id, bearer_token=bearer_token)
        narrative_prompt = (
            "You are the SupplySense Orchestrator Agent. Using the structured decision data below, "
            "craft a concise executive briefing with a leading statement, bullet summaries per agent, "
            "and clear next steps.\n\nStructured data:\n"
            f"{json.dumps(fused, indent=2)}"
        )
        response = _agent_narrative(narrative_prompt)
        text = response.message["content"][0]["text"]
        clean_text = re.sub(r'<(thinking|analysis|response)>.*?</\1>', '', text, flags=re.DOTALL | re.IGNORECASE).strip()
        clean_text = re.sub(r'</?(thinking|analysis|response)>', '', clean_text, flags=re.IGNORECASE).strip()
        fused['narrative'] = clean_text
        fused['mode'] = 'orchestrator_conversation'
        return {
            "brand": "SupplySense",
            "message": json.dumps(fused),
        }

    session_id = request.get("sessionId") or f"session-{datetime.now(timezone.utc).timestamp()}"
    fused = _run_orchestrated_flow(prompt, session_id, bearer_token=bearer_token)
    narrative_prompt = (
        "You are the SupplySense Orchestrator Agent. Using the structured decision data below, "
        "craft a concise executive briefing with a leading statement, bullet summaries per agent, "
        "and clear next steps.\n\nStructured data:\n"
        f"{json.dumps(fused, indent=2)}"
    )
    response = _agent_narrative(narrative_prompt)
    text = response.message["content"][0]["text"]
    clean_text = re.sub(r'<(thinking|analysis|response)>.*?</\1>', '', text, flags=re.DOTALL | re.IGNORECASE).strip()
    clean_text = re.sub(r'</?(thinking|analysis|response)>', '', clean_text, flags=re.IGNORECASE).strip()
    fused['narrative'] = clean_text
    fused['mode'] = 'orchestrator_conversation'

    return {
        "brand": "SupplySense",
        "message": json.dumps(fused),
    }

if __name__ == "__main__":
    app.run()