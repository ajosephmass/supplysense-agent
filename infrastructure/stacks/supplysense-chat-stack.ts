import { Stack, StackProps, CfnOutput, Duration, CustomResource } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as path from 'path';

export interface SupplySenseChatProps extends StackProps {
  cognitoUserPoolId: string;
  cognitoUserPoolClientId: string;
}

export class SupplySenseChatStack extends Stack {
  public readonly chatServiceUrl: string;

  constructor(scope: Construct, id: string, props: SupplySenseChatProps) {
    super(scope, id, props);

    // VPC for ECS
    const vpc = new ec2.Vpc(this, 'SupplySenseVPC', {
      maxAzs: 2,
      natGateways: 1, // Cost optimization
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'SupplySenseChatCluster', {
      vpc,
      clusterName: 'supplysense-chat-cluster',
    });

    // ECR Repository for Chat Orchestration Service
    const chatRepo = new ecr.Repository(this, 'ChatOrchestrationRepo', {
      repositoryName: `supplysense-chat-orchestration-${this.account}-${this.region}`,
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Allow cleanup on stack deletion
    });

    // Task Role for Chat Orchestration Service
    const taskRole = new iam.Role(this, 'ChatOrchestrationTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // CloudWatch Log Groups for SNS delivery status
    const snsDeliveryLogGroup = new logs.LogGroup(this, 'SNSDeliveryLogGroup', {
      logGroupName: `/sns/delivery-status/supplysense-${this.account}-${this.region}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // IAM Role for SNS to write delivery status to CloudWatch
    const snsDeliveryRole = new iam.Role(this, 'SNSDeliveryRole', {
      assumedBy: new iam.ServicePrincipal('sns.amazonaws.com'),
      description: 'Allows SNS to write delivery status logs to CloudWatch',
    });

    snsDeliveryRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [snsDeliveryLogGroup.logGroupArn],
    }));

    // SNS Topics for action and approval events
    const actionEventsTopic = new sns.Topic(this, 'ActionEventsTopic', {
      topicName: `supplysense-action-events-${this.account}-${this.region}`,
      displayName: 'SupplySense Action Events',
    });

    const approvalEventsTopic = new sns.Topic(this, 'ApprovalEventsTopic', {
      topicName: `supplysense-approval-events-${this.account}-${this.region}`,
      displayName: 'SupplySense Approval Events',
    });

    // SQS Queue to capture all SNS messages for debugging/verification
    const notificationQueue = new sqs.Queue(this, 'NotificationQueue', {
      queueName: `supplysense-notifications-${this.account}-${this.region}`,
      retentionPeriod: Duration.days(7),
      visibilityTimeout: Duration.seconds(30),
    });

    // Subscribe the queue to both SNS topics
    actionEventsTopic.addSubscription(new subscriptions.SqsSubscription(notificationQueue));
    approvalEventsTopic.addSubscription(new subscriptions.SqsSubscription(notificationQueue));

    // Custom resource to set SNS delivery status logging attributes
    const setSNSLoggingLambda = new lambda.Function(this, 'SetSNSLoggingFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: Duration.seconds(30),
      code: lambda.Code.fromInline(`
import boto3
import json

sns = boto3.client('sns')

def handler(event, context):
    print(f"Event: {json.dumps(event)}")
    
    request_type = event['RequestType']
    if request_type == 'Delete':
        return {'PhysicalResourceId': 'SNSLoggingConfig'}
    
    try:
        topic_arn = event['ResourceProperties']['TopicArn']
        role_arn = event['ResourceProperties']['RoleArn']
        
        # Set delivery status logging attributes for application/platform endpoint
        # Note: These only work when you have actual subscriptions
        sns.set_topic_attributes(
            TopicArn=topic_arn,
            AttributeName='ApplicationSuccessFeedbackRoleArn',
            AttributeValue=role_arn
        )
        sns.set_topic_attributes(
            TopicArn=topic_arn,
            AttributeName='ApplicationFailureFeedbackRoleArn',
            AttributeValue=role_arn
        )
        sns.set_topic_attributes(
            TopicArn=topic_arn,
            AttributeName='ApplicationSuccessFeedbackSampleRate',
            AttributeValue='100'
        )
        
        print(f"Successfully configured delivery logging for {topic_arn}")
        return {
            'PhysicalResourceId': f'SNSLogging-{topic_arn.split(":")[-1]}',
            'Data': {'Status': 'SUCCESS'}
        }
    except Exception as e:
        print(f"Error: {str(e)}")
        raise e
      `),
    });

    setSNSLoggingLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sns:SetTopicAttributes', 'sns:GetTopicAttributes'],
      resources: [actionEventsTopic.topicArn, approvalEventsTopic.topicArn],
    }));

    // Allow Lambda to pass the SNS delivery role to SNS service
    setSNSLoggingLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [snsDeliveryRole.roleArn],
    }));

    const setSNSLoggingProvider = new cr.Provider(this, 'SetSNSLoggingProvider', {
      onEventHandler: setSNSLoggingLambda,
    });

    new CustomResource(this, 'ActionTopicLogging', {
      serviceToken: setSNSLoggingProvider.serviceToken,
      properties: {
        TopicArn: actionEventsTopic.topicArn,
        RoleArn: snsDeliveryRole.roleArn,
      },
    });

    new CustomResource(this, 'ApprovalTopicLogging', {
      serviceToken: setSNSLoggingProvider.serviceToken,
      properties: {
        TopicArn: approvalEventsTopic.topicArn,
        RoleArn: snsDeliveryRole.roleArn,
      },
    });

    // Grant permissions to invoke AgentCore runtimes
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:InvokeAgentRuntime',
        'bedrock-agentcore:GetAgentRuntime',
        'bedrock-agentcore:ListAgentRuntimes',
        'bedrock-agentcore:GetAgentRuntimeEndpoint',
      ],
      resources: ['*'],
    }));

    // Grant SSM permissions to read agent configuration
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssm:GetParameter',
        'ssm:GetParameters',
        'ssm:GetParametersByPath',
      ],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/supplysense/agents/*`],
    }));

    // Grant DynamoDB permissions for session management and data access
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:Query',
        'dynamodb:Scan',
      ],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/supplysense-*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/chat-sessions`,
      ],
    }));

    // Grant CloudFormation permissions to read stack outputs
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'cloudformation:DescribeStacks',
        'cloudformation:ListStackResources',
      ],
      resources: [
        `arn:aws:cloudformation:${this.region}:${this.account}:stack/SupplySenseAgentCoreStack/*`,
      ],
    }));

    // Grant Cognito permissions for JWT validation
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:GetUser',
        'cognito-idp:AdminGetUser',
      ],
      resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${props.cognitoUserPoolId}`],
    }));

    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sns:Publish'],
      resources: [
        actionEventsTopic.topicArn,
        approvalEventsTopic.topicArn,
      ],
    }));

    // Execution Role
    const executionRole = new iam.Role(this, 'ChatOrchestrationExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Grant ECR permissions
    chatRepo.grantPull(executionRole);

    // CloudWatch Log Group - Make it unique to avoid conflicts
    const logGroup = new logs.LogGroup(this, 'ChatOrchestrationLogGroup', {
      logGroupName: `/ecs/supplysense-chat-orchestration-${this.account}-${this.region}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Allow cleanup on stack deletion
    });

    // Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'ChatOrchestrationTaskDef', {
      memoryLimitMiB: 2048,
      cpu: 1024,
      taskRole,
      executionRole,
    });

    // CodeBuild project for Chat Service image (Python Flask passthrough to AgentCore)
    const chatSrc = new s3assets.Asset(this, 'ChatServiceSrc', {
      path: path.join(__dirname, '../../chat-service'),
    });

    const chatBuildProject = new codebuild.Project(this, 'ChatOrchestrationBuild', {
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
        privileged: true
      },
      environmentVariables: {
        REPO_URI: { value: chatRepo.repositoryUri },
        IMAGE_TAG: { value: chatSrc.assetHash },
        SRC_BUCKET: { value: chatSrc.s3BucketName },
        SRC_KEY: { value: chatSrc.s3ObjectKey },
        AWS_REGION: { value: this.region },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Logging into ECR',
              'aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $REPO_URI',
              'aws s3 cp s3://$SRC_BUCKET/$SRC_KEY src.zip',
              'mkdir -p src && unzip -q src.zip -d src && cd src',
            ],
          },
          build: {
            commands: [
              'echo "Building Docker image with retry logic"',
              'for i in 1 2 3; do docker build -t $REPO_URI:$IMAGE_TAG . && break || sleep 30; done',
              'docker push $REPO_URI:$IMAGE_TAG',
            ],
          },
        },
      }),
    });

    chatSrc.grantRead(chatBuildProject);
    chatRepo.grantPullPush(chatBuildProject);

    // No additional permissions needed for Docker Hub

    // Custom resource to trigger the build before ECS service creation
    const buildTrigger = new lambda.Function(this, 'ChatBuildTriggerFn', {
      code: lambda.Code.fromInline(`
import json
import boto3
import time

def handler(event, context):
    print(f"Received event: {json.dumps(event)}")
    
    if event['RequestType'] == 'Delete':
        return {'PhysicalResourceId': 'ChatBuildTrigger'}
    
    try:
        codebuild = boto3.client('codebuild')
        
        # Start the build
        response = codebuild.start_build(
            projectName=event['ResourceProperties']['ProjectName']
        )
        
        build_id = response['build']['id']
        print(f"Started build: {build_id}")
        
        # Wait for build to complete
        while True:
            time.sleep(10)
            build_status = codebuild.batch_get_builds(ids=[build_id])
            status = build_status['builds'][0]['buildStatus']
            print(f"Build status: {status}")
            
            if status in ['SUCCEEDED', 'FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT']:
                if status != 'SUCCEEDED':
                    raise Exception(f"Build failed with status: {status}")
                break
        
        return {
            'PhysicalResourceId': 'ChatBuildTrigger',
            'Data': {'BuildId': build_id, 'Status': 'SUCCESS'}
        }
        
    except Exception as e:
        print(f"Error: {str(e)}")
        raise e
      `),
      handler: 'index.handler',
      runtime: lambda.Runtime.PYTHON_3_12,
      timeout: Duration.minutes(15),
    });

    buildTrigger.addToRolePolicy(new iam.PolicyStatement({
      actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
      resources: [chatBuildProject.projectArn],
    }));

    const buildProvider = new cr.Provider(this, 'ChatBuildProvider', {
      onEventHandler: buildTrigger,
    });

    const buildResource = new CustomResource(this, 'ChatBuildResource', {
      serviceToken: buildProvider.serviceToken,
      properties: {
        ProjectName: chatBuildProject.projectName,
        ImageTag: chatSrc.assetHash,
      },
    });

    // Container Definition - Chat Service (Flask passthrough to AgentCore)
    const container = taskDefinition.addContainer('ChatServiceContainer', {
      image: ecs.ContainerImage.fromEcrRepository(chatRepo, chatSrc.assetHash),
      memoryLimitMiB: 1536, // Reserve most of the task memory for the container
      cpu: 768, // Reserve most of the task CPU for the container
      environment: {
        AWS_REGION: this.region,
        COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
        COGNITO_USER_POOL_CLIENT_ID: props.cognitoUserPoolClientId,
        NODE_ENV: 'production',
        ACTIONS_TABLE_NAME: 'supplysense-actions',
        APPROVALS_TABLE_NAME: 'supplysense-approvals',
        ACTION_EVENTS_TOPIC_ARN: actionEventsTopic.topicArn,
        APPROVAL_EVENTS_TOPIC_ARN: approvalEventsTopic.topicArn,
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'chat-orchestration',
        logGroup,
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60), // Give the app time to start
      },
    });

    container.addPortMappings({
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
    });

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ChatOrchestrationALB', {
      vpc,
      internetFacing: true,
    });

    // Set ALB idle timeout to 180 seconds for long-running SSE streams
    const albCfn = alb.node.defaultChild as elbv2.CfnLoadBalancer;
    albCfn.loadBalancerAttributes = [
      { key: 'idle_timeout.timeout_seconds', value: '180' },
    ];

    const listener = alb.addListener('ChatOrchestrationListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    // ECS Service
    const service = new ecs.FargateService(this, 'ChatOrchestrationService', {
      cluster,
      taskDefinition,
      desiredCount: 2,
      assignPublicIp: false, // Use private subnets with NAT
      serviceName: 'supplysense-chat-orchestration',
    });

    // ECS Service - Make sure it depends on the build completing
    service.node.addDependency(buildResource);

    // Target Group
    listener.addTargets('ChatOrchestrationTargets', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    const scalableTaskCount = service.autoScaleTaskCount({
      minCapacity: 2,
      maxCapacity: 4,
    });

    scalableTaskCount.scaleOnCpuUtilization('ChatCpuScaling', {
      targetUtilizationPercent: 55,
      scaleInCooldown: Duration.minutes(2),
      scaleOutCooldown: Duration.minutes(1),
    });

    new CfnOutput(this, 'ActionEventsTopicArn', {
      value: actionEventsTopic.topicArn,
      description: 'SNS topic for action events',
    });

    new CfnOutput(this, 'ApprovalEventsTopicArn', {
      value: approvalEventsTopic.topicArn,
      description: 'SNS topic for approval events',
    });

    new CfnOutput(this, 'SNSDeliveryLogGroupName', {
      value: snsDeliveryLogGroup.logGroupName,
      description: 'CloudWatch log group for SNS delivery status logs',
    });

    new CfnOutput(this, 'NotificationQueueUrl', {
      value: notificationQueue.queueUrl,
      description: 'SQS queue URL to view SNS notification messages',
    });





    this.chatServiceUrl = `http://${alb.loadBalancerDnsName}`;

    // S3 Bucket for UI hosting
    const uiBucket = new s3.Bucket(this, 'UIBucket', {
      bucketName: `supplysense-ui-${this.account}-${this.region}`,
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'index.html', // For SPA routing
      publicReadAccess: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront Distribution for UI and API proxy
    const distribution = new cloudfront.Distribution(this, 'UIDistribution', {
      defaultBehavior: {
        origin: new origins.S3StaticWebsiteOrigin(uiBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(alb.loadBalancerDnsName, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            connectionTimeout: Duration.seconds(10),
            connectionAttempts: 3,
            readTimeout: Duration.seconds(60), // Max allowed by CloudFront
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html', // For SPA routing
        },
      ],
    });

    // UI build pipeline driven by CodeBuild
    const uiSrc = new s3assets.Asset(this, 'UISource', {
      path: path.join(__dirname, '../../ui'),
      exclude: [
        'node_modules',
        '.next',
        'out',
        'dist',
        'build',
        '*.log',
        'npm-debug.log',
        'yarn-error.log',
        '.DS_Store',
      ],
    });

    const uiBuildProject = new codebuild.Project(this, 'UIBuildProject', {
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      },
      environmentVariables: {
        SRC_BUCKET: { value: uiSrc.s3BucketName },
        SRC_KEY: { value: uiSrc.s3ObjectKey },
        TARGET_BUCKET: { value: uiBucket.bucketName },
        NEXT_PUBLIC_USER_POOL_ID: { value: props.cognitoUserPoolId },
        NEXT_PUBLIC_USER_POOL_CLIENT_ID: { value: props.cognitoUserPoolClientId },
        NEXT_PUBLIC_API_ENDPOINT: { value: '/api' },
        NEXT_PUBLIC_AWS_REGION: { value: this.region },
        NEXT_PUBLIC_IDENTITY_POOL_ID: { value: '' },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Downloading UI source bundle',
              'aws s3 cp s3://$SRC_BUCKET/$SRC_KEY src.zip',
              'rm -rf src',
              'mkdir -p src',
              'unzip -q src.zip -d src',
            ],
          },
          build: {
            commands: [
              'echo "Building Next.js UI"',
              '(cd src && npm ci)',
              '(cd src && npm run build)',
              '(cd src && npm run export)',
              '(cd src && pwd)',
              '(cd src && ls -R)',
              'echo "Build complete"',
            ],
          },
          post_build: {
            commands: [
              'EXPORT_DIR=""',
              'if [ -d src/out ]; then EXPORT_DIR="src/out"; fi',
              'if [ -z "$EXPORT_DIR" ] && [ -d src/.next/export ]; then EXPORT_DIR="src/.next/export"; fi',
              'if [ -z "$EXPORT_DIR" ]; then echo "Static export directory not found (expected src/out or src/.next/export)" && exit 1; fi',
              'aws s3 sync "$EXPORT_DIR"/ s3://$TARGET_BUCKET --delete',
            ],
          },
        },
                        }),
                    });
                    
    uiSrc.grantRead(uiBuildProject);
    uiBucket.grantReadWrite(uiBuildProject);

    const uiBuildTrigger = new lambda.Function(this, 'UIBuildTriggerFn', {
      code: lambda.Code.fromInline(`
import json
import boto3
import time

def handler(event, _context):
    print(f"Received event: {json.dumps(event)}")

    if event['RequestType'] == 'Delete':
        return {'PhysicalResourceId': 'UIBuildTrigger'}

    project_name = event['ResourceProperties']['ProjectName']
    codebuild = boto3.client('codebuild')

    response = codebuild.start_build(projectName=project_name)
    build_id = response['build']['id']
    print(f"Started UI build: {build_id}")

    while True:
        time.sleep(10)
        build = codebuild.batch_get_builds(ids=[build_id])['builds'][0]
        status = build['buildStatus']
        print(f"UI build status: {status}")
        if status in ['SUCCEEDED', 'FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT']:
            if status != 'SUCCEEDED':
                raise Exception(f"UI build failed with status: {status}")
            break

    return {
        'PhysicalResourceId': 'UIBuildTrigger',
        'Data': {'BuildId': build_id, 'Status': 'SUCCESS'}
    }
      `),
      handler: 'index.handler',
      runtime: lambda.Runtime.PYTHON_3_12,
      timeout: Duration.minutes(15),
    });

    uiBuildTrigger.addToRolePolicy(new iam.PolicyStatement({
      actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
      resources: [uiBuildProject.projectArn],
    }));

    const uiBuildProvider = new cr.Provider(this, 'UIBuildProvider', {
      onEventHandler: uiBuildTrigger,
    });

    const uiBuildResource = new CustomResource(this, 'UIBuildResource', {
      serviceToken: uiBuildProvider.serviceToken,
      properties: {
        ProjectName: uiBuildProject.projectName,
      },
    });

    uiBuildResource.node.addDependency(uiSrc);
    uiBuildResource.node.addDependency(uiBucket);
    uiBuildResource.node.addDependency(distribution);
    uiBuildResource.node.addDependency(alb);

    // Outputs
    new CfnOutput(this, 'ChatServiceUrl', {
      value: this.chatServiceUrl,
      description: 'SupplySense Chat Orchestration Service URL'
    });
    new CfnOutput(this, 'ChatServiceALBDns', {
      value: alb.loadBalancerDnsName,
      description: 'Application Load Balancer DNS Name'
    });
    new CfnOutput(this, 'ChatUIUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'SupplySense UI URL'
    });
    new CfnOutput(this, 'ChatServiceBuildProject', {
      value: chatBuildProject.projectName,
      description: 'CodeBuild project for Chat Service (Flask passthrough to AgentCore)'
    });
  }
}