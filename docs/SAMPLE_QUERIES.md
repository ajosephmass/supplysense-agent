# SupplySense Sample Queries

This document provides sample queries you can use to test the SupplySense multi-agent system.

## Fulfillment Analysis

### Basic Fulfillment Check
```
Can I fulfill all customer orders this week given current inventory?
```
**What it does**: Analyzes inventory levels against pending orders, identifies shortages, and provides fulfillment recommendations.

### Inventory Status
```
What is the current inventory status across all warehouses?
```
**What it does**: Provides a comprehensive view of inventory levels, identifies low-stock items, and highlights reorder needs.

## Risk Assessment

### Stockout Risk
```
Which SKUs are at risk of stockout in the next 7 days?
```
**What it does**: Analyzes demand patterns against current inventory to identify products at risk of running out.

### Supply Chain Risk
```
What is the overall risk posture for our supply chain?
```
**What it does**: Assesses risks across suppliers, logistics, and inventory to provide a holistic risk view.

### Revenue Impact
```
What is the revenue impact if we have supply delays?
```
**What it does**: Calculates potential revenue loss from supply chain disruptions.

## Logistics Analysis

### Logistics Constraints
```
Are there any logistics constraints for pending orders?
```
**What it does**: Analyzes logistics capacity, route assignments, and identifies bottlenecks.

### Expedite Recommendations
```
Do I need to expedite any inbound shipments?
```
**What it does**: Evaluates current shipment status and recommends expediting where needed.

## Demand Analysis

### Demand Forecast
```
What is the demand forecast for the next 30 days?
```
**What it does**: Provides demand projections based on historical patterns and current trends.

### High-Demand Products
```
Which products have the highest demand this week?
```
**What it does**: Identifies top-selling products and their demand patterns.

## Tips for Effective Queries

1. **Be specific about timeframes**: "this week", "next 7 days", "Q4"
2. **Ask analytical questions**: The system excels at analysis and recommendations
3. **Focus on current state**: Queries about current inventory, orders, and logistics work best
4. **Combine concerns**: "Can I fulfill orders given inventory and logistics constraints?"

## Queries That Work Best

The system is optimized for:
- ✅ Status checks ("What is the current...")
- ✅ Risk assessment ("What are the risks...")
- ✅ Fulfillment analysis ("Can I fulfill...")
- ✅ Impact analysis ("What is the impact...")
- ✅ Constraint identification ("Are there any constraints...")

## Queries to Avoid

The system is not designed for:
- ❌ Creating detailed plans ("Create a replenishment plan...")
- ❌ Comparing external options ("Compare logistics carriers...")
- ❌ Generating schedules ("Generate a production schedule...")
- ❌ Historical analysis ("What happened last quarter...")

For these use cases, extend the system with additional tools and data sources.

