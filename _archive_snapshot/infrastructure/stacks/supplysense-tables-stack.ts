import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export class SupplySenseTablesStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Inventory Table
    const inventoryTable = new dynamodb.Table(this, 'InventoryTable', {
      tableName: 'supplysense-inventory',
      partitionKey: { name: 'productId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'locationId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Orders Table
    const ordersTable = new dynamodb.Table(this, 'OrdersTable', {
      tableName: 'supplysense-orders',
      partitionKey: { name: 'orderId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Suppliers Table
    const suppliersTable = new dynamodb.Table(this, 'SuppliersTable', {
      tableName: 'supplysense-suppliers',
      partitionKey: { name: 'supplierId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Logistics Table
    const logisticsTable = new dynamodb.Table(this, 'LogisticsTable', {
      tableName: 'supplysense-logistics',
      partitionKey: { name: 'shipmentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Demand Forecast Table
    const demandForecastTable = new dynamodb.Table(this, 'DemandForecastTable', {
      tableName: 'supplysense-demand-forecast',
      partitionKey: { name: 'productId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'forecastDate', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Chat Sessions Table
    const chatSessionsTable = new dynamodb.Table(this, 'ChatSessionsTable', {
      tableName: 'chat-sessions',
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Outputs
    new CfnOutput(this, 'InventoryTableName', {
      value: inventoryTable.tableName,
      description: 'Inventory DynamoDB Table Name',
    });

    new CfnOutput(this, 'OrdersTableName', {
      value: ordersTable.tableName,
      description: 'Orders DynamoDB Table Name',
    });

    new CfnOutput(this, 'SuppliersTableName', {
      value: suppliersTable.tableName,
      description: 'Suppliers DynamoDB Table Name',
    });

    new CfnOutput(this, 'LogisticsTableName', {
      value: logisticsTable.tableName,
      description: 'Logistics DynamoDB Table Name',
    });

    new CfnOutput(this, 'DemandForecastTableName', {
      value: demandForecastTable.tableName,
      description: 'Demand Forecast DynamoDB Table Name',
    });

    new CfnOutput(this, 'ChatSessionsTableName', {
      value: chatSessionsTable.tableName,
      description: 'Chat Sessions DynamoDB Table Name',
    });
  }
}