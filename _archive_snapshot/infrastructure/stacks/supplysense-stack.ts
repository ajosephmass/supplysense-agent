import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';

export class SupplySenseStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Simple health check Lambda
    const healthCheckHandler = new lambda.Function(this, 'HealthCheckHandler', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({ statusCode: 200, body: JSON.stringify({ status: "healthy" }) });'),
    });

    // Cognito User Pool
    const userPool = new cognito.UserPool(this, 'SupplySenseUserPool', {
      userPoolName: 'SupplySense-UserPool',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'SupplySenseUserPoolClient', {
      userPool,
      userPoolClientName: 'SupplySense-WebClient',
      generateSecret: false,
    });

    // API Gateway
    const api = new apigateway.RestApi(this, 'SupplySenseAPI', {
      restApiName: 'SupplySense API',
      description: 'API for SupplySense multi-agent system',
    });

    // Health endpoint
    const healthResource = api.root.addResource('health');
    healthResource.addMethod('GET', new apigateway.LambdaIntegration(healthCheckHandler));

    // Store references
    this.userPool = userPool;
    this.userPoolClient = userPoolClient;
    this.api = api;

    // Outputs
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'APIEndpoint', { value: api.url });
  }
}
