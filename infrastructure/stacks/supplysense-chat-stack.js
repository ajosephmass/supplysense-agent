"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SupplySenseChatStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const cdk = __importStar(require("aws-cdk-lib"));
const ecs = __importStar(require("aws-cdk-lib/aws-ecs"));
const ec2 = __importStar(require("aws-cdk-lib/aws-ec2"));
const ecr = __importStar(require("aws-cdk-lib/aws-ecr"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const elbv2 = __importStar(require("aws-cdk-lib/aws-elasticloadbalancingv2"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const codebuild = __importStar(require("aws-cdk-lib/aws-codebuild"));
const s3assets = __importStar(require("aws-cdk-lib/aws-s3-assets"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const cr = __importStar(require("aws-cdk-lib/custom-resources"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const cloudfront = __importStar(require("aws-cdk-lib/aws-cloudfront"));
const origins = __importStar(require("aws-cdk-lib/aws-cloudfront-origins"));
const sns = __importStar(require("aws-cdk-lib/aws-sns"));
const path = __importStar(require("path"));
class SupplySenseChatStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, props) {
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
        // Custom resource to set SNS delivery status logging attributes
        const setSNSLoggingLambda = new lambda.Function(this, 'SetSNSLoggingFunction', {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            timeout: aws_cdk_lib_1.Duration.seconds(30),
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
        new aws_cdk_lib_1.CustomResource(this, 'ActionTopicLogging', {
            serviceToken: setSNSLoggingProvider.serviceToken,
            properties: {
                TopicArn: actionEventsTopic.topicArn,
                RoleArn: snsDeliveryRole.roleArn,
            },
        });
        new aws_cdk_lib_1.CustomResource(this, 'ApprovalTopicLogging', {
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
            timeout: aws_cdk_lib_1.Duration.minutes(15),
        });
        buildTrigger.addToRolePolicy(new iam.PolicyStatement({
            actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
            resources: [chatBuildProject.projectArn],
        }));
        const buildProvider = new cr.Provider(this, 'ChatBuildProvider', {
            onEventHandler: buildTrigger,
        });
        const buildResource = new aws_cdk_lib_1.CustomResource(this, 'ChatBuildResource', {
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
        const albCfn = alb.node.defaultChild;
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
            scaleInCooldown: aws_cdk_lib_1.Duration.minutes(2),
            scaleOutCooldown: aws_cdk_lib_1.Duration.minutes(1),
        });
        new aws_cdk_lib_1.CfnOutput(this, 'ActionEventsTopicArn', {
            value: actionEventsTopic.topicArn,
            description: 'SNS topic for action events',
        });
        new aws_cdk_lib_1.CfnOutput(this, 'ApprovalEventsTopicArn', {
            value: approvalEventsTopic.topicArn,
            description: 'SNS topic for approval events',
        });
        new aws_cdk_lib_1.CfnOutput(this, 'SNSDeliveryLogGroupName', {
            value: snsDeliveryLogGroup.logGroupName,
            description: 'CloudWatch log group for SNS delivery status logs',
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
                        connectionTimeout: aws_cdk_lib_1.Duration.seconds(10),
                        connectionAttempts: 3,
                        readTimeout: aws_cdk_lib_1.Duration.seconds(60), // Max allowed by CloudFront
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
            timeout: aws_cdk_lib_1.Duration.minutes(15),
        });
        uiBuildTrigger.addToRolePolicy(new iam.PolicyStatement({
            actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
            resources: [uiBuildProject.projectArn],
        }));
        const uiBuildProvider = new cr.Provider(this, 'UIBuildProvider', {
            onEventHandler: uiBuildTrigger,
        });
        const uiBuildResource = new aws_cdk_lib_1.CustomResource(this, 'UIBuildResource', {
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
        new aws_cdk_lib_1.CfnOutput(this, 'ChatServiceUrl', {
            value: this.chatServiceUrl,
            description: 'SupplySense Chat Orchestration Service URL'
        });
        new aws_cdk_lib_1.CfnOutput(this, 'ChatServiceALBDns', {
            value: alb.loadBalancerDnsName,
            description: 'Application Load Balancer DNS Name'
        });
        new aws_cdk_lib_1.CfnOutput(this, 'ChatUIUrl', {
            value: `https://${distribution.distributionDomainName}`,
            description: 'SupplySense UI URL'
        });
        new aws_cdk_lib_1.CfnOutput(this, 'ChatServiceBuildProject', {
            value: chatBuildProject.projectName,
            description: 'CodeBuild project for Chat Service (Flask passthrough to AgentCore)'
        });
    }
}
exports.SupplySenseChatStack = SupplySenseChatStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3VwcGx5c2Vuc2UtY2hhdC1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInN1cHBseXNlbnNlLWNoYXQtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQXFGO0FBQ3JGLGlEQUFtQztBQUVuQyx5REFBMkM7QUFDM0MseURBQTJDO0FBQzNDLHlEQUEyQztBQUMzQyx5REFBMkM7QUFDM0MsOEVBQWdFO0FBQ2hFLDJEQUE2QztBQUM3QyxxRUFBdUQ7QUFDdkQsb0VBQXNEO0FBQ3RELCtEQUFpRDtBQUNqRCxpRUFBbUQ7QUFDbkQsdURBQXlDO0FBQ3pDLHVFQUF5RDtBQUN6RCw0RUFBOEQ7QUFDOUQseURBQTJDO0FBQzNDLDJDQUE2QjtBQU83QixNQUFhLG9CQUFxQixTQUFRLG1CQUFLO0lBRzdDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBMkI7UUFDbkUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsY0FBYztRQUNkLE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLEVBQUU7WUFDOUMsTUFBTSxFQUFFLENBQUM7WUFDVCxXQUFXLEVBQUUsQ0FBQyxFQUFFLG9CQUFvQjtTQUNyQyxDQUFDLENBQUM7UUFFSCxjQUFjO1FBQ2QsTUFBTSxPQUFPLEdBQUcsSUFBSSxHQUFHLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSx3QkFBd0IsRUFBRTtZQUM5RCxHQUFHO1lBQ0gsV0FBVyxFQUFFLDBCQUEwQjtTQUN4QyxDQUFDLENBQUM7UUFFSCxnREFBZ0Q7UUFDaEQsTUFBTSxRQUFRLEdBQUcsSUFBSSxHQUFHLENBQUMsVUFBVSxDQUFDLElBQUksRUFBRSx1QkFBdUIsRUFBRTtZQUNqRSxjQUFjLEVBQUUsa0NBQWtDLElBQUksQ0FBQyxPQUFPLElBQUksSUFB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QUFDO1FBQ0gsSUFBSSx1QkFBUyxDQUFDLElBQUksRUFBRSx5QkFBeUIsRUFBRTtZQUM3QyxLQUFLLEVBQUUsZ0JBQWdCLENBQUMsV0FBVztZQUNuQyxXQUFXLEVBQUUscUVBQXFFO1NBQ25GLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQWxvQkQsb0RBa29CQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFN0YWNrLCBTdGFja1Byb3BzLCBDZm5PdXRwdXQsIER1cmF0aW9uLCBDdXN0b21SZXNvdXJjZSB9IGZyb20gJ2F3cy1jZGstbGliJztcclxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcclxuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XHJcbmltcG9ydCAqIGFzIGVjcyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNzJztcclxuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xyXG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XHJcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcclxuaW1wb3J0ICogYXMgZWxidjIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVsYXN0aWNsb2FkYmFsYW5jaW5ndjInO1xyXG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcclxuaW1wb3J0ICogYXMgY29kZWJ1aWxkIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jb2RlYnVpbGQnO1xyXG5pbXBvcnQgKiBhcyBzM2Fzc2V0cyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMtYXNzZXRzJztcclxuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xyXG5pbXBvcnQgKiBhcyBjciBmcm9tICdhd3MtY2RrLWxpYi9jdXN0b20tcmVzb3VyY2VzJztcclxuaW1wb3J0ICogYXMgczMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzJztcclxuaW1wb3J0ICogYXMgY2xvdWRmcm9udCBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udCc7XHJcbmltcG9ydCAqIGFzIG9yaWdpbnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQtb3JpZ2lucyc7XHJcbmltcG9ydCAqIGFzIHNucyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc25zJztcclxuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgU3VwcGx5U2Vuc2VDaGF0UHJvcHMgZXh0ZW5kcyBTdGFja1Byb3BzIHtcclxuICBjb2duaXRvVXNlclBvb2xJZDogc3RyaW5nO1xyXG4gIGNvZ25pdG9Vc2VyUG9vbENsaWVudElkOiBzdHJpbmc7XHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBTdXBwbHlTZW5zZUNoYXRTdGFjayBleHRlbmRzIFN0YWNrIHtcclxuICBwdWJsaWMgcmVhZG9ubHkgY2hhdFNlcnZpY2VVcmw6IHN0cmluZztcclxuXHJcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IFN1cHBseVNlbnNlQ2hhdFByb3BzKSB7XHJcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcclxuXHJcbiAgICAvLyBWUEMgZm9yIEVDU1xyXG4gICAgY29uc3QgdnBjID0gbmV3IGVjMi5WcGModGhpcywgJ1N1cHBseVNlbnNlVlBDJywge1xyXG4gICAgICBtYXhBenM6IDIsXHJcbiAgICAgIG5hdEdhdGV3YXlzOiAxLCAvLyBDb3N0IG9wdGltaXphdGlvblxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gRUNTIENsdXN0ZXJcclxuICAgIGNvbnN0IGNsdXN0ZXIgPSBuZXcgZWNzLkNsdXN0ZXIodGhpcywgJ1N1cHBseVNlbnNlQ2hhdENsdXN0ZXInLCB7XHJcbiAgICAgIHZwYyxcclxuICAgICAgY2x1c3Rlck5hbWU6ICdzdXBwbHlzZW5zZS1jaGF0LWNsdXN0ZXInLFxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gRUNSIFJlcG9zaXRvcnkgZm9yIENoYXQgT3JjaGVzdHJhdGlvbiBTZXJ2aWNlXHJcbiAgICBjb25zdCBjaGF0UmVwbyA9IG5ldyBlY3IuUmVwb3NpdG9yeSh0aGlzLCAnQ2hhdE9yY2hlc3RyYXRpb25SZXBvJywge1xyXG4gICAgICByZXBvc2l0b3J5TmFtZTogYHN1cHBseXNlbnNlLWNoYXQtb3JjaGVzdHJhdGlvbi0ke3RoaXMuYWNjb3VudH0tJHt0aGlzLnJlZ2lvbn1gLFxyXG4gICAgICBpbWFnZVNjYW5PblB1c2g6IHRydWUsXHJcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksIC8vIEFsbG93IGNsZWFudXAgb24gc3RhY2sgZGVsZXRpb25cclxuICAgIH0pO1xyXG5cclxuICAgIC8vIFRhc2sgUm9sZSBmb3IgQ2hhdCBPcmNoZXN0cmF0aW9uIFNlcnZpY2VcclxuICAgIGNvbnN0IHRhc2tSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdDaGF0T3JjaGVzdHJhdGlvblRhc2tSb2xlJywge1xyXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnZWNzLXRhc2tzLmFtYXpvbmF3cy5jb20nKSxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIENsb3VkV2F0Y2ggTG9nIEdyb3VwcyBmb3IgU05TIGRlbGl2ZXJ5IHN0YXR1c1xyXG4gICAgY29uc3Qgc25zRGVsaXZlcnlMb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsICdTTlNEZWxpdmVyeUxvZ0dyb3VwJywge1xyXG4gICAgICBsb2dHcm91cE5hbWU6IGAvc25zL2RlbGl2ZXJ5LXN0YXR1cy9zdXBwbHlzZW5zZS0ke3RoaXMuYWNjb3VudH0tJHt0aGlzLnJlZ2lvbn1gLFxyXG4gICAgICByZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFSyxcclxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIElBTSBSb2xlIGZvciBTTlMgdG8gd3JpdGUgZGVsaXZlcnkgc3RhdHVzIHRvIENsb3VkV2F0Y2hcclxuICAgIGNvbnN0IHNuc0RlbGl2ZXJ5Um9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnU05TRGVsaXZlcnlSb2xlJywge1xyXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnc25zLmFtYXpvbmF3cy5jb20nKSxcclxuICAgICAgZGVzY3JpcHRpb246ICdBbGxvd3MgU05TIHRvIHdyaXRlIGRlbGl2ZXJ5IHN0YXR1cyBsb2dzIHRvIENsb3VkV2F0Y2gnLFxyXG4gICAgfSk7XHJcblxyXG4gICAgc25zRGVsaXZlcnlSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICdsb2dzOkNyZWF0ZUxvZ0dyb3VwJyxcclxuICAgICAgICAnbG9nczpDcmVhdGVMb2dTdHJlYW0nLFxyXG4gICAgICAgICdsb2dzOlB1dExvZ0V2ZW50cycsXHJcbiAgICAgIF0sXHJcbiAgICAgIHJlc291cmNlczogW3Nuc0RlbGl2ZXJ5TG9nR3JvdXAubG9nR3JvdXBBcm5dLFxyXG4gICAgfSkpO1xyXG5cclxuICAgIC8vIFNOUyBUb3BpY3MgZm9yIGFjdGlvbiBhbmQgYXBwcm92YWwgZXZlbnRzXHJcbiAgICBjb25zdCBhY3Rpb25FdmVudHNUb3BpYyA9IG5ldyBzbnMuVG9waWModGhpcywgJ0FjdGlvbkV2ZW50c1RvcGljJywge1xyXG4gICAgICB0b3BpY05hbWU6IGBzdXBwbHlzZW5zZS1hY3Rpb24tZXZlbnRzLSR7dGhpcy5hY2NvdW50fS0ke3RoaXMucmVnaW9ufWAsXHJcbiAgICAgIGRpc3BsYXlOYW1lOiAnU3VwcGx5U2Vuc2UgQWN0aW9uIEV2ZW50cycsXHJcbiAgICB9KTtcclxuXHJcbiAgICBjb25zdCBhcHByb3ZhbEV2ZW50c1RvcGljID0gbmV3IHNucy5Ub3BpYyh0aGlzLCAnQXBwcm92YWxFdmVudHNUb3BpYycsIHtcclxuICAgICAgdG9waWNOYW1lOiBgc3VwcGx5c2Vuc2UtYXBwcm92YWwtZXZlbnRzLSR7dGhpcy5hY2NvdW50fS0ke3RoaXMucmVnaW9ufWAsXHJcbiAgICAgIGRpc3BsYXlOYW1lOiAnU3VwcGx5U2Vuc2UgQXBwcm92YWwgRXZlbnRzJyxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIEN1c3RvbSByZXNvdXJjZSB0byBzZXQgU05TIGRlbGl2ZXJ5IHN0YXR1cyBsb2dnaW5nIGF0dHJpYnV0ZXNcclxuICAgIGNvbnN0IHNldFNOU0xvZ2dpbmdMYW1iZGEgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdTZXRTTlNMb2dnaW5nRnVuY3Rpb24nLCB7XHJcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzEyLFxyXG4gICAgICBoYW5kbGVyOiAnaW5kZXguaGFuZGxlcicsXHJcbiAgICAgIHRpbWVvdXQ6IER1cmF0aW9uLnNlY29uZHMoMzApLFxyXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKGBcclxuaW1wb3J0IGJvdG8zXHJcbmltcG9ydCBqc29uXHJcblxyXG5zbnMgPSBib3RvMy5jbGllbnQoJ3NucycpXHJcblxyXG5kZWYgaGFuZGxlcihldmVudCwgY29udGV4dCk6XHJcbiAgICBwcmludChmXCJFdmVudDoge2pzb24uZHVtcHMoZXZlbnQpfVwiKVxyXG4gICAgXHJcbiAgICByZXF1ZXN0X3R5cGUgPSBldmVudFsnUmVxdWVzdFR5cGUnXVxyXG4gICAgaWYgcmVxdWVzdF90eXBlID09ICdEZWxldGUnOlxyXG4gICAgICAgIHJldHVybiB7J1BoeXNpY2FsUmVzb3VyY2VJZCc6ICdTTlNMb2dnaW5nQ29uZmlnJ31cclxuICAgIFxyXG4gICAgdHJ5OlxyXG4gICAgICAgIHRvcGljX2FybiA9IGV2ZW50WydSZXNvdXJjZVByb3BlcnRpZXMnXVsnVG9waWNBcm4nXVxyXG4gICAgICAgIHJvbGVfYXJuID0gZXZlbnRbJ1Jlc291cmNlUHJvcGVydGllcyddWydSb2xlQXJuJ11cclxuICAgICAgICBcclxuICAgICAgICAjIFNldCBkZWxpdmVyeSBzdGF0dXMgbG9nZ2luZyBhdHRyaWJ1dGVzIGZvciBhcHBsaWNhdGlvbi9wbGF0Zm9ybSBlbmRwb2ludFxyXG4gICAgICAgICMgTm90ZTogVGhlc2Ugb25seSB3b3JrIHdoZW4geW91IGhhdmUgYWN0dWFsIHN1YnNjcmlwdGlvbnNcclxuICAgICAgICBzbnMuc2V0X3RvcGljX2F0dHJpYnV0ZXMoXHJcbiAgICAgICAgICAgIFRvcGljQXJuPXRvcGljX2FybixcclxuICAgICAgICAgICAgQXR0cmlidXRlTmFtZT0nQXBwbGljYXRpb25TdWNjZXNzRmVlZGJhY2tSb2xlQXJuJyxcclxuICAgICAgICAgICAgQXR0cmlidXRlVmFsdWU9cm9sZV9hcm5cclxuICAgICAgICApXHJcbiAgICAgICAgc25zLnNldF90b3BpY19hdHRyaWJ1dGVzKFxyXG4gICAgICAgICAgICBUb3BpY0Fybj10b3BpY19hcm4sXHJcbiAgICAgICAgICAgIEF0dHJpYnV0ZU5hbWU9J0FwcGxpY2F0aW9uRmFpbHVyZUZlZWRiYWNrUm9sZUFybicsXHJcbiAgICAgICAgICAgIEF0dHJpYnV0ZVZhbHVlPXJvbGVfYXJuXHJcbiAgICAgICAgKVxyXG4gICAgICAgIHNucy5zZXRfdG9waWNfYXR0cmlidXRlcyhcclxuICAgICAgICAgICAgVG9waWNBcm49dG9waWNfYXJuLFxyXG4gICAgICAgICAgICBBdHRyaWJ1dGVOYW1lPSdBcHBsaWNhdGlvblN1Y2Nlc3NGZWVkYmFja1NhbXBsZVJhdGUnLFxyXG4gICAgICAgICAgICBBdHRyaWJ1dGVWYWx1ZT0nMTAwJ1xyXG4gICAgICAgIClcclxuICAgICAgICBcclxuICAgICAgICBwcmludChmXCJTdWNjZXNzZnVsbHkgY29uZmlndXJlZCBkZWxpdmVyeSBsb2dnaW5nIGZvciB7dG9waWNfYXJufVwiKVxyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICdQaHlzaWNhbFJlc291cmNlSWQnOiBmJ1NOU0xvZ2dpbmcte3RvcGljX2Fybi5zcGxpdChcIjpcIilbLTFdfScsXHJcbiAgICAgICAgICAgICdEYXRhJzogeydTdGF0dXMnOiAnU1VDQ0VTUyd9XHJcbiAgICAgICAgfVxyXG4gICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOlxyXG4gICAgICAgIHByaW50KGZcIkVycm9yOiB7c3RyKGUpfVwiKVxyXG4gICAgICAgIHJhaXNlIGVcclxuICAgICAgYCksXHJcbiAgICB9KTtcclxuXHJcbiAgICBzZXRTTlNMb2dnaW5nTGFtYmRhLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgIGFjdGlvbnM6IFsnc25zOlNldFRvcGljQXR0cmlidXRlcycsICdzbnM6R2V0VG9waWNBdHRyaWJ1dGVzJ10sXHJcbiAgICAgIHJlc291cmNlczogW2FjdGlvbkV2ZW50c1RvcGljLnRvcGljQXJuLCBhcHByb3ZhbEV2ZW50c1RvcGljLnRvcGljQXJuXSxcclxuICAgIH0pKTtcclxuXHJcbiAgICAvLyBBbGxvdyBMYW1iZGEgdG8gcGFzcyB0aGUgU05TIGRlbGl2ZXJ5IHJvbGUgdG8gU05TIHNlcnZpY2VcclxuICAgIHNldFNOU0xvZ2dpbmdMYW1iZGEuYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgYWN0aW9uczogWydpYW06UGFzc1JvbGUnXSxcclxuICAgICAgcmVzb3VyY2VzOiBbc25zRGVsaXZlcnlSb2xlLnJvbGVBcm5dLFxyXG4gICAgfSkpO1xyXG5cclxuICAgIGNvbnN0IHNldFNOU0xvZ2dpbmdQcm92aWRlciA9IG5ldyBjci5Qcm92aWRlcih0aGlzLCAnU2V0U05TTG9nZ2luZ1Byb3ZpZGVyJywge1xyXG4gICAgICBvbkV2ZW50SGFuZGxlcjogc2V0U05TTG9nZ2luZ0xhbWJkYSxcclxuICAgIH0pO1xyXG5cclxuICAgIG5ldyBDdXN0b21SZXNvdXJjZSh0aGlzLCAnQWN0aW9uVG9waWNMb2dnaW5nJywge1xyXG4gICAgICBzZXJ2aWNlVG9rZW46IHNldFNOU0xvZ2dpbmdQcm92aWRlci5zZXJ2aWNlVG9rZW4sXHJcbiAgICAgIHByb3BlcnRpZXM6IHtcclxuICAgICAgICBUb3BpY0FybjogYWN0aW9uRXZlbnRzVG9waWMudG9waWNBcm4sXHJcbiAgICAgICAgUm9sZUFybjogc25zRGVsaXZlcnlSb2xlLnJvbGVBcm4sXHJcbiAgICAgIH0sXHJcbiAgICB9KTtcclxuXHJcbiAgICBuZXcgQ3VzdG9tUmVzb3VyY2UodGhpcywgJ0FwcHJvdmFsVG9waWNMb2dnaW5nJywge1xyXG4gICAgICBzZXJ2aWNlVG9rZW46IHNldFNOU0xvZ2dpbmdQcm92aWRlci5zZXJ2aWNlVG9rZW4sXHJcbiAgICAgIHByb3BlcnRpZXM6IHtcclxuICAgICAgICBUb3BpY0FybjogYXBwcm92YWxFdmVudHNUb3BpYy50b3BpY0FybixcclxuICAgICAgICBSb2xlQXJuOiBzbnNEZWxpdmVyeVJvbGUucm9sZUFybixcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIEdyYW50IHBlcm1pc3Npb25zIHRvIGludm9rZSBBZ2VudENvcmUgcnVudGltZXNcclxuICAgIHRhc2tSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpJbnZva2VBZ2VudFJ1bnRpbWUnLFxyXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRBZ2VudFJ1bnRpbWUnLFxyXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpMaXN0QWdlbnRSdW50aW1lcycsXHJcbiAgICAgIF0sXHJcbiAgICAgIHJlc291cmNlczogWycqJ10sXHJcbiAgICB9KSk7XHJcblxyXG4gICAgLy8gR3JhbnQgU1NNIHBlcm1pc3Npb25zIHRvIHJlYWQgYWdlbnQgY29uZmlndXJhdGlvblxyXG4gICAgdGFza1JvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgJ3NzbTpHZXRQYXJhbWV0ZXInLFxyXG4gICAgICAgICdzc206R2V0UGFyYW1ldGVycycsXHJcbiAgICAgICAgJ3NzbTpHZXRQYXJhbWV0ZXJzQnlQYXRoJyxcclxuICAgICAgXSxcclxuICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6c3NtOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpwYXJhbWV0ZXIvc3VwcGx5c2Vuc2UvYWdlbnRzLypgXSxcclxuICAgIH0pKTtcclxuXHJcbiAgICAvLyBHcmFudCBEeW5hbW9EQiBwZXJtaXNzaW9ucyBmb3Igc2Vzc2lvbiBtYW5hZ2VtZW50IGFuZCBkYXRhIGFjY2Vzc1xyXG4gICAgdGFza1JvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgJ2R5bmFtb2RiOkdldEl0ZW0nLFxyXG4gICAgICAgICdkeW5hbW9kYjpQdXRJdGVtJyxcclxuICAgICAgICAnZHluYW1vZGI6VXBkYXRlSXRlbScsXHJcbiAgICAgICAgJ2R5bmFtb2RiOlF1ZXJ5JyxcclxuICAgICAgICAnZHluYW1vZGI6U2NhbicsXHJcbiAgICAgIF0sXHJcbiAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgIGBhcm46YXdzOmR5bmFtb2RiOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTp0YWJsZS9zdXBwbHlzZW5zZS0qYCxcclxuICAgICAgICBgYXJuOmF3czpkeW5hbW9kYjoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06dGFibGUvY2hhdC1zZXNzaW9uc2AsXHJcbiAgICAgIF0sXHJcbiAgICB9KSk7XHJcblxyXG4gICAgLy8gR3JhbnQgQ2xvdWRGb3JtYXRpb24gcGVybWlzc2lvbnMgdG8gcmVhZCBzdGFjayBvdXRwdXRzXHJcbiAgICB0YXNrUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAnY2xvdWRmb3JtYXRpb246RGVzY3JpYmVTdGFja3MnLFxyXG4gICAgICAgICdjbG91ZGZvcm1hdGlvbjpMaXN0U3RhY2tSZXNvdXJjZXMnLFxyXG4gICAgICBdLFxyXG4gICAgICByZXNvdXJjZXM6IFtcclxuICAgICAgICBgYXJuOmF3czpjbG91ZGZvcm1hdGlvbjoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06c3RhY2svU3VwcGx5U2Vuc2VBZ2VudENvcmVTdGFjay8qYCxcclxuICAgICAgXSxcclxuICAgIH0pKTtcclxuXHJcbiAgICAvLyBHcmFudCBDb2duaXRvIHBlcm1pc3Npb25zIGZvciBKV1QgdmFsaWRhdGlvblxyXG4gICAgdGFza1JvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgJ2NvZ25pdG8taWRwOkdldFVzZXInLFxyXG4gICAgICAgICdjb2duaXRvLWlkcDpBZG1pbkdldFVzZXInLFxyXG4gICAgICBdLFxyXG4gICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpjb2duaXRvLWlkcDoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06dXNlcnBvb2wvJHtwcm9wcy5jb2duaXRvVXNlclBvb2xJZH1gXSxcclxuICAgIH0pKTtcclxuXHJcbiAgICB0YXNrUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgIGFjdGlvbnM6IFsnc25zOlB1Ymxpc2gnXSxcclxuICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgYWN0aW9uRXZlbnRzVG9waWMudG9waWNBcm4sXHJcbiAgICAgICAgYXBwcm92YWxFdmVudHNUb3BpYy50b3BpY0FybixcclxuICAgICAgXSxcclxuICAgIH0pKTtcclxuXHJcbiAgICAvLyBFeGVjdXRpb24gUm9sZVxyXG4gICAgY29uc3QgZXhlY3V0aW9uUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnQ2hhdE9yY2hlc3RyYXRpb25FeGVjdXRpb25Sb2xlJywge1xyXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnZWNzLXRhc2tzLmFtYXpvbmF3cy5jb20nKSxcclxuICAgICAgbWFuYWdlZFBvbGljaWVzOiBbXHJcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdzZXJ2aWNlLXJvbGUvQW1hem9uRUNTVGFza0V4ZWN1dGlvblJvbGVQb2xpY3knKSxcclxuICAgICAgXSxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIEdyYW50IEVDUiBwZXJtaXNzaW9uc1xyXG4gICAgY2hhdFJlcG8uZ3JhbnRQdWxsKGV4ZWN1dGlvblJvbGUpO1xyXG5cclxuICAgIC8vIENsb3VkV2F0Y2ggTG9nIEdyb3VwIC0gTWFrZSBpdCB1bmlxdWUgdG8gYXZvaWQgY29uZmxpY3RzXHJcbiAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsICdDaGF0T3JjaGVzdHJhdGlvbkxvZ0dyb3VwJywge1xyXG4gICAgICBsb2dHcm91cE5hbWU6IGAvZWNzL3N1cHBseXNlbnNlLWNoYXQtb3JjaGVzdHJhdGlvbi0ke3RoaXMuYWNjb3VudH0tJHt0aGlzLnJlZ2lvbn1gLFxyXG4gICAgICByZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFSyxcclxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSwgLy8gQWxsb3cgY2xlYW51cCBvbiBzdGFjayBkZWxldGlvblxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gVGFzayBEZWZpbml0aW9uXHJcbiAgICBjb25zdCB0YXNrRGVmaW5pdGlvbiA9IG5ldyBlY3MuRmFyZ2F0ZVRhc2tEZWZpbml0aW9uKHRoaXMsICdDaGF0T3JjaGVzdHJhdGlvblRhc2tEZWYnLCB7XHJcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiAyMDQ4LFxyXG4gICAgICBjcHU6IDEwMjQsXHJcbiAgICAgIHRhc2tSb2xlLFxyXG4gICAgICBleGVjdXRpb25Sb2xlLFxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gQ29kZUJ1aWxkIHByb2plY3QgZm9yIENoYXQgU2VydmljZSBpbWFnZSAoUHl0aG9uIEZsYXNrIHBhc3N0aHJvdWdoIHRvIEFnZW50Q29yZSlcclxuICAgIGNvbnN0IGNoYXRTcmMgPSBuZXcgczNhc3NldHMuQXNzZXQodGhpcywgJ0NoYXRTZXJ2aWNlU3JjJywge1xyXG4gICAgICBwYXRoOiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vLi4vY2hhdC1zZXJ2aWNlJyksXHJcbiAgICB9KTtcclxuXHJcbiAgICBjb25zdCBjaGF0QnVpbGRQcm9qZWN0ID0gbmV3IGNvZGVidWlsZC5Qcm9qZWN0KHRoaXMsICdDaGF0T3JjaGVzdHJhdGlvbkJ1aWxkJywge1xyXG4gICAgICBlbnZpcm9ubWVudDoge1xyXG4gICAgICAgIGJ1aWxkSW1hZ2U6IGNvZGVidWlsZC5MaW51eEJ1aWxkSW1hZ2UuQU1BWk9OX0xJTlVYXzJfNSxcclxuICAgICAgICBwcml2aWxlZ2VkOiB0cnVlXHJcbiAgICAgIH0sXHJcbiAgICAgIGVudmlyb25tZW50VmFyaWFibGVzOiB7XHJcbiAgICAgICAgUkVQT19VUkk6IHsgdmFsdWU6IGNoYXRSZXBvLnJlcG9zaXRvcnlVcmkgfSxcclxuICAgICAgICBJTUFHRV9UQUc6IHsgdmFsdWU6IGNoYXRTcmMuYXNzZXRIYXNoIH0sXHJcbiAgICAgICAgU1JDX0JVQ0tFVDogeyB2YWx1ZTogY2hhdFNyYy5zM0J1Y2tldE5hbWUgfSxcclxuICAgICAgICBTUkNfS0VZOiB7IHZhbHVlOiBjaGF0U3JjLnMzT2JqZWN0S2V5IH0sXHJcbiAgICAgICAgQVdTX1JFR0lPTjogeyB2YWx1ZTogdGhpcy5yZWdpb24gfSxcclxuICAgICAgfSxcclxuICAgICAgYnVpbGRTcGVjOiBjb2RlYnVpbGQuQnVpbGRTcGVjLmZyb21PYmplY3Qoe1xyXG4gICAgICAgIHZlcnNpb246ICcwLjInLFxyXG4gICAgICAgIHBoYXNlczoge1xyXG4gICAgICAgICAgcHJlX2J1aWxkOiB7XHJcbiAgICAgICAgICAgIGNvbW1hbmRzOiBbXHJcbiAgICAgICAgICAgICAgJ2VjaG8gTG9nZ2luZyBpbnRvIEVDUicsXHJcbiAgICAgICAgICAgICAgJ2F3cyBlY3IgZ2V0LWxvZ2luLXBhc3N3b3JkIC0tcmVnaW9uICRBV1NfUkVHSU9OIHwgZG9ja2VyIGxvZ2luIC0tdXNlcm5hbWUgQVdTIC0tcGFzc3dvcmQtc3RkaW4gJFJFUE9fVVJJJyxcclxuICAgICAgICAgICAgICAnYXdzIHMzIGNwIHMzOi8vJFNSQ19CVUNLRVQvJFNSQ19LRVkgc3JjLnppcCcsXHJcbiAgICAgICAgICAgICAgJ21rZGlyIC1wIHNyYyAmJiB1bnppcCAtcSBzcmMuemlwIC1kIHNyYyAmJiBjZCBzcmMnLFxyXG4gICAgICAgICAgICBdLFxyXG4gICAgICAgICAgfSxcclxuICAgICAgICAgIGJ1aWxkOiB7XHJcbiAgICAgICAgICAgIGNvbW1hbmRzOiBbXHJcbiAgICAgICAgICAgICAgJ2VjaG8gXCJCdWlsZGluZyBEb2NrZXIgaW1hZ2Ugd2l0aCByZXRyeSBsb2dpY1wiJyxcclxuICAgICAgICAgICAgICAnZm9yIGkgaW4gMSAyIDM7IGRvIGRvY2tlciBidWlsZCAtdCAkUkVQT19VUkk6JElNQUdFX1RBRyAuICYmIGJyZWFrIHx8IHNsZWVwIDMwOyBkb25lJyxcclxuICAgICAgICAgICAgICAnZG9ja2VyIHB1c2ggJFJFUE9fVVJJOiRJTUFHRV9UQUcnLFxyXG4gICAgICAgICAgICBdLFxyXG4gICAgICAgICAgfSxcclxuICAgICAgICB9LFxyXG4gICAgICB9KSxcclxuICAgIH0pO1xyXG5cclxuICAgIGNoYXRTcmMuZ3JhbnRSZWFkKGNoYXRCdWlsZFByb2plY3QpO1xyXG4gICAgY2hhdFJlcG8uZ3JhbnRQdWxsUHVzaChjaGF0QnVpbGRQcm9qZWN0KTtcclxuXHJcbiAgICAvLyBObyBhZGRpdGlvbmFsIHBlcm1pc3Npb25zIG5lZWRlZCBmb3IgRG9ja2VyIEh1YlxyXG5cclxuICAgIC8vIEN1c3RvbSByZXNvdXJjZSB0byB0cmlnZ2VyIHRoZSBidWlsZCBiZWZvcmUgRUNTIHNlcnZpY2UgY3JlYXRpb25cclxuICAgIGNvbnN0IGJ1aWxkVHJpZ2dlciA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ0NoYXRCdWlsZFRyaWdnZXJGbicsIHtcclxuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUlubGluZShgXHJcbmltcG9ydCBqc29uXHJcbmltcG9ydCBib3RvM1xyXG5pbXBvcnQgdGltZVxyXG5cclxuZGVmIGhhbmRsZXIoZXZlbnQsIGNvbnRleHQpOlxyXG4gICAgcHJpbnQoZlwiUmVjZWl2ZWQgZXZlbnQ6IHtqc29uLmR1bXBzKGV2ZW50KX1cIilcclxuICAgIFxyXG4gICAgaWYgZXZlbnRbJ1JlcXVlc3RUeXBlJ10gPT0gJ0RlbGV0ZSc6XHJcbiAgICAgICAgcmV0dXJuIHsnUGh5c2ljYWxSZXNvdXJjZUlkJzogJ0NoYXRCdWlsZFRyaWdnZXInfVxyXG4gICAgXHJcbiAgICB0cnk6XHJcbiAgICAgICAgY29kZWJ1aWxkID0gYm90bzMuY2xpZW50KCdjb2RlYnVpbGQnKVxyXG4gICAgICAgIFxyXG4gICAgICAgICMgU3RhcnQgdGhlIGJ1aWxkXHJcbiAgICAgICAgcmVzcG9uc2UgPSBjb2RlYnVpbGQuc3RhcnRfYnVpbGQoXHJcbiAgICAgICAgICAgIHByb2plY3ROYW1lPWV2ZW50WydSZXNvdXJjZVByb3BlcnRpZXMnXVsnUHJvamVjdE5hbWUnXVxyXG4gICAgICAgIClcclxuICAgICAgICBcclxuICAgICAgICBidWlsZF9pZCA9IHJlc3BvbnNlWydidWlsZCddWydpZCddXHJcbiAgICAgICAgcHJpbnQoZlwiU3RhcnRlZCBidWlsZDoge2J1aWxkX2lkfVwiKVxyXG4gICAgICAgIFxyXG4gICAgICAgICMgV2FpdCBmb3IgYnVpbGQgdG8gY29tcGxldGVcclxuICAgICAgICB3aGlsZSBUcnVlOlxyXG4gICAgICAgICAgICB0aW1lLnNsZWVwKDEwKVxyXG4gICAgICAgICAgICBidWlsZF9zdGF0dXMgPSBjb2RlYnVpbGQuYmF0Y2hfZ2V0X2J1aWxkcyhpZHM9W2J1aWxkX2lkXSlcclxuICAgICAgICAgICAgc3RhdHVzID0gYnVpbGRfc3RhdHVzWydidWlsZHMnXVswXVsnYnVpbGRTdGF0dXMnXVxyXG4gICAgICAgICAgICBwcmludChmXCJCdWlsZCBzdGF0dXM6IHtzdGF0dXN9XCIpXHJcbiAgICAgICAgICAgIFxyXG4gICAgICAgICAgICBpZiBzdGF0dXMgaW4gWydTVUNDRUVERUQnLCAnRkFJTEVEJywgJ0ZBVUxUJywgJ1NUT1BQRUQnLCAnVElNRURfT1VUJ106XHJcbiAgICAgICAgICAgICAgICBpZiBzdGF0dXMgIT0gJ1NVQ0NFRURFRCc6XHJcbiAgICAgICAgICAgICAgICAgICAgcmFpc2UgRXhjZXB0aW9uKGZcIkJ1aWxkIGZhaWxlZCB3aXRoIHN0YXR1czoge3N0YXR1c31cIilcclxuICAgICAgICAgICAgICAgIGJyZWFrXHJcbiAgICAgICAgXHJcbiAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgJ1BoeXNpY2FsUmVzb3VyY2VJZCc6ICdDaGF0QnVpbGRUcmlnZ2VyJyxcclxuICAgICAgICAgICAgJ0RhdGEnOiB7J0J1aWxkSWQnOiBidWlsZF9pZCwgJ1N0YXR1cyc6ICdTVUNDRVNTJ31cclxuICAgICAgICB9XHJcbiAgICAgICAgXHJcbiAgICBleGNlcHQgRXhjZXB0aW9uIGFzIGU6XHJcbiAgICAgICAgcHJpbnQoZlwiRXJyb3I6IHtzdHIoZSl9XCIpXHJcbiAgICAgICAgcmFpc2UgZVxyXG4gICAgICBgKSxcclxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxyXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMixcclxuICAgICAgdGltZW91dDogRHVyYXRpb24ubWludXRlcygxNSksXHJcbiAgICB9KTtcclxuXHJcbiAgICBidWlsZFRyaWdnZXIuYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgYWN0aW9uczogWydjb2RlYnVpbGQ6U3RhcnRCdWlsZCcsICdjb2RlYnVpbGQ6QmF0Y2hHZXRCdWlsZHMnXSxcclxuICAgICAgcmVzb3VyY2VzOiBbY2hhdEJ1aWxkUHJvamVjdC5wcm9qZWN0QXJuXSxcclxuICAgIH0pKTtcclxuXHJcbiAgICBjb25zdCBidWlsZFByb3ZpZGVyID0gbmV3IGNyLlByb3ZpZGVyKHRoaXMsICdDaGF0QnVpbGRQcm92aWRlcicsIHtcclxuICAgICAgb25FdmVudEhhbmRsZXI6IGJ1aWxkVHJpZ2dlcixcclxuICAgIH0pO1xyXG5cclxuICAgIGNvbnN0IGJ1aWxkUmVzb3VyY2UgPSBuZXcgQ3VzdG9tUmVzb3VyY2UodGhpcywgJ0NoYXRCdWlsZFJlc291cmNlJywge1xyXG4gICAgICBzZXJ2aWNlVG9rZW46IGJ1aWxkUHJvdmlkZXIuc2VydmljZVRva2VuLFxyXG4gICAgICBwcm9wZXJ0aWVzOiB7XHJcbiAgICAgICAgUHJvamVjdE5hbWU6IGNoYXRCdWlsZFByb2plY3QucHJvamVjdE5hbWUsXHJcbiAgICAgICAgSW1hZ2VUYWc6IGNoYXRTcmMuYXNzZXRIYXNoLFxyXG4gICAgICB9LFxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gQ29udGFpbmVyIERlZmluaXRpb24gLSBDaGF0IFNlcnZpY2UgKEZsYXNrIHBhc3N0aHJvdWdoIHRvIEFnZW50Q29yZSlcclxuICAgIGNvbnN0IGNvbnRhaW5lciA9IHRhc2tEZWZpbml0aW9uLmFkZENvbnRhaW5lcignQ2hhdFNlcnZpY2VDb250YWluZXInLCB7XHJcbiAgICAgIGltYWdlOiBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbUVjclJlcG9zaXRvcnkoY2hhdFJlcG8sIGNoYXRTcmMuYXNzZXRIYXNoKSxcclxuICAgICAgbWVtb3J5TGltaXRNaUI6IDE1MzYsIC8vIFJlc2VydmUgbW9zdCBvZiB0aGUgdGFzayBtZW1vcnkgZm9yIHRoZSBjb250YWluZXJcclxuICAgICAgY3B1OiA3NjgsIC8vIFJlc2VydmUgbW9zdCBvZiB0aGUgdGFzayBDUFUgZm9yIHRoZSBjb250YWluZXJcclxuICAgICAgZW52aXJvbm1lbnQ6IHtcclxuICAgICAgICBBV1NfUkVHSU9OOiB0aGlzLnJlZ2lvbixcclxuICAgICAgICBDT0dOSVRPX1VTRVJfUE9PTF9JRDogcHJvcHMuY29nbml0b1VzZXJQb29sSWQsXHJcbiAgICAgICAgQ09HTklUT19VU0VSX1BPT0xfQ0xJRU5UX0lEOiBwcm9wcy5jb2duaXRvVXNlclBvb2xDbGllbnRJZCxcclxuICAgICAgICBOT0RFX0VOVjogJ3Byb2R1Y3Rpb24nLFxyXG4gICAgICAgIEFDVElPTlNfVEFCTEVfTkFNRTogJ3N1cHBseXNlbnNlLWFjdGlvbnMnLFxyXG4gICAgICAgIEFQUFJPVkFMU19UQUJMRV9OQU1FOiAnc3VwcGx5c2Vuc2UtYXBwcm92YWxzJyxcclxuICAgICAgICBBQ1RJT05fRVZFTlRTX1RPUElDX0FSTjogYWN0aW9uRXZlbnRzVG9waWMudG9waWNBcm4sXHJcbiAgICAgICAgQVBQUk9WQUxfRVZFTlRTX1RPUElDX0FSTjogYXBwcm92YWxFdmVudHNUb3BpYy50b3BpY0FybixcclxuICAgICAgfSxcclxuICAgICAgbG9nZ2luZzogZWNzLkxvZ0RyaXZlcnMuYXdzTG9ncyh7XHJcbiAgICAgICAgc3RyZWFtUHJlZml4OiAnY2hhdC1vcmNoZXN0cmF0aW9uJyxcclxuICAgICAgICBsb2dHcm91cCxcclxuICAgICAgfSksXHJcbiAgICAgIGhlYWx0aENoZWNrOiB7XHJcbiAgICAgICAgY29tbWFuZDogWydDTUQtU0hFTEwnLCAnY3VybCAtZiBodHRwOi8vbG9jYWxob3N0OjMwMDAvaGVhbHRoIHx8IGV4aXQgMSddLFxyXG4gICAgICAgIGludGVydmFsOiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXHJcbiAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMTApLFxyXG4gICAgICAgIHJldHJpZXM6IDMsXHJcbiAgICAgICAgc3RhcnRQZXJpb2Q6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDYwKSwgLy8gR2l2ZSB0aGUgYXBwIHRpbWUgdG8gc3RhcnRcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG5cclxuICAgIGNvbnRhaW5lci5hZGRQb3J0TWFwcGluZ3Moe1xyXG4gICAgICBjb250YWluZXJQb3J0OiAzMDAwLFxyXG4gICAgICBwcm90b2NvbDogZWNzLlByb3RvY29sLlRDUCxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIEFwcGxpY2F0aW9uIExvYWQgQmFsYW5jZXJcclxuICAgIGNvbnN0IGFsYiA9IG5ldyBlbGJ2Mi5BcHBsaWNhdGlvbkxvYWRCYWxhbmNlcih0aGlzLCAnQ2hhdE9yY2hlc3RyYXRpb25BTEInLCB7XHJcbiAgICAgIHZwYyxcclxuICAgICAgaW50ZXJuZXRGYWNpbmc6IHRydWUsXHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyBTZXQgQUxCIGlkbGUgdGltZW91dCB0byAxODAgc2Vjb25kcyBmb3IgbG9uZy1ydW5uaW5nIFNTRSBzdHJlYW1zXHJcbiAgICBjb25zdCBhbGJDZm4gPSBhbGIubm9kZS5kZWZhdWx0Q2hpbGQgYXMgZWxidjIuQ2ZuTG9hZEJhbGFuY2VyO1xyXG4gICAgYWxiQ2ZuLmxvYWRCYWxhbmNlckF0dHJpYnV0ZXMgPSBbXHJcbiAgICAgIHsga2V5OiAnaWRsZV90aW1lb3V0LnRpbWVvdXRfc2Vjb25kcycsIHZhbHVlOiAnMTgwJyB9LFxyXG4gICAgXTtcclxuXHJcbiAgICBjb25zdCBsaXN0ZW5lciA9IGFsYi5hZGRMaXN0ZW5lcignQ2hhdE9yY2hlc3RyYXRpb25MaXN0ZW5lcicsIHtcclxuICAgICAgcG9ydDogODAsXHJcbiAgICAgIHByb3RvY29sOiBlbGJ2Mi5BcHBsaWNhdGlvblByb3RvY29sLkhUVFAsXHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyBFQ1MgU2VydmljZVxyXG4gICAgY29uc3Qgc2VydmljZSA9IG5ldyBlY3MuRmFyZ2F0ZVNlcnZpY2UodGhpcywgJ0NoYXRPcmNoZXN0cmF0aW9uU2VydmljZScsIHtcclxuICAgICAgY2x1c3RlcixcclxuICAgICAgdGFza0RlZmluaXRpb24sXHJcbiAgICAgIGRlc2lyZWRDb3VudDogMixcclxuICAgICAgYXNzaWduUHVibGljSXA6IGZhbHNlLCAvLyBVc2UgcHJpdmF0ZSBzdWJuZXRzIHdpdGggTkFUXHJcbiAgICAgIHNlcnZpY2VOYW1lOiAnc3VwcGx5c2Vuc2UtY2hhdC1vcmNoZXN0cmF0aW9uJyxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIEVDUyBTZXJ2aWNlIC0gTWFrZSBzdXJlIGl0IGRlcGVuZHMgb24gdGhlIGJ1aWxkIGNvbXBsZXRpbmdcclxuICAgIHNlcnZpY2Uubm9kZS5hZGREZXBlbmRlbmN5KGJ1aWxkUmVzb3VyY2UpO1xyXG5cclxuICAgIC8vIFRhcmdldCBHcm91cFxyXG4gICAgbGlzdGVuZXIuYWRkVGFyZ2V0cygnQ2hhdE9yY2hlc3RyYXRpb25UYXJnZXRzJywge1xyXG4gICAgICBwb3J0OiAzMDAwLFxyXG4gICAgICBwcm90b2NvbDogZWxidjIuQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxyXG4gICAgICB0YXJnZXRzOiBbc2VydmljZV0sXHJcbiAgICAgIGhlYWx0aENoZWNrOiB7XHJcbiAgICAgICAgcGF0aDogJy9oZWFsdGgnLFxyXG4gICAgICAgIGludGVydmFsOiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksXHJcbiAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNSksXHJcbiAgICAgICAgaGVhbHRoeVRocmVzaG9sZENvdW50OiAyLFxyXG4gICAgICAgIHVuaGVhbHRoeVRocmVzaG9sZENvdW50OiAzLFxyXG4gICAgICB9LFxyXG4gICAgfSk7XHJcblxyXG4gICAgY29uc3Qgc2NhbGFibGVUYXNrQ291bnQgPSBzZXJ2aWNlLmF1dG9TY2FsZVRhc2tDb3VudCh7XHJcbiAgICAgIG1pbkNhcGFjaXR5OiAyLFxyXG4gICAgICBtYXhDYXBhY2l0eTogNCxcclxuICAgIH0pO1xyXG5cclxuICAgIHNjYWxhYmxlVGFza0NvdW50LnNjYWxlT25DcHVVdGlsaXphdGlvbignQ2hhdENwdVNjYWxpbmcnLCB7XHJcbiAgICAgIHRhcmdldFV0aWxpemF0aW9uUGVyY2VudDogNTUsXHJcbiAgICAgIHNjYWxlSW5Db29sZG93bjogRHVyYXRpb24ubWludXRlcygyKSxcclxuICAgICAgc2NhbGVPdXRDb29sZG93bjogRHVyYXRpb24ubWludXRlcygxKSxcclxuICAgIH0pO1xyXG5cclxuICAgIG5ldyBDZm5PdXRwdXQodGhpcywgJ0FjdGlvbkV2ZW50c1RvcGljQXJuJywge1xyXG4gICAgICB2YWx1ZTogYWN0aW9uRXZlbnRzVG9waWMudG9waWNBcm4sXHJcbiAgICAgIGRlc2NyaXB0aW9uOiAnU05TIHRvcGljIGZvciBhY3Rpb24gZXZlbnRzJyxcclxuICAgIH0pO1xyXG5cclxuICAgIG5ldyBDZm5PdXRwdXQodGhpcywgJ0FwcHJvdmFsRXZlbnRzVG9waWNBcm4nLCB7XHJcbiAgICAgIHZhbHVlOiBhcHByb3ZhbEV2ZW50c1RvcGljLnRvcGljQXJuLFxyXG4gICAgICBkZXNjcmlwdGlvbjogJ1NOUyB0b3BpYyBmb3IgYXBwcm92YWwgZXZlbnRzJyxcclxuICAgIH0pO1xyXG5cclxuICAgIG5ldyBDZm5PdXRwdXQodGhpcywgJ1NOU0RlbGl2ZXJ5TG9nR3JvdXBOYW1lJywge1xyXG4gICAgICB2YWx1ZTogc25zRGVsaXZlcnlMb2dHcm91cC5sb2dHcm91cE5hbWUsXHJcbiAgICAgIGRlc2NyaXB0aW9uOiAnQ2xvdWRXYXRjaCBsb2cgZ3JvdXAgZm9yIFNOUyBkZWxpdmVyeSBzdGF0dXMgbG9ncycsXHJcbiAgICB9KTtcclxuXHJcblxyXG5cclxuXHJcblxyXG4gICAgdGhpcy5jaGF0U2VydmljZVVybCA9IGBodHRwOi8vJHthbGIubG9hZEJhbGFuY2VyRG5zTmFtZX1gO1xyXG5cclxuICAgIC8vIFMzIEJ1Y2tldCBmb3IgVUkgaG9zdGluZ1xyXG4gICAgY29uc3QgdWlCdWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsICdVSUJ1Y2tldCcsIHtcclxuICAgICAgYnVja2V0TmFtZTogYHN1cHBseXNlbnNlLXVpLSR7dGhpcy5hY2NvdW50fS0ke3RoaXMucmVnaW9ufWAsXHJcbiAgICAgIHdlYnNpdGVJbmRleERvY3VtZW50OiAnaW5kZXguaHRtbCcsXHJcbiAgICAgIHdlYnNpdGVFcnJvckRvY3VtZW50OiAnaW5kZXguaHRtbCcsIC8vIEZvciBTUEEgcm91dGluZ1xyXG4gICAgICBwdWJsaWNSZWFkQWNjZXNzOiB0cnVlLFxyXG4gICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUNMUyxcclxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcclxuICAgICAgYXV0b0RlbGV0ZU9iamVjdHM6IHRydWUsXHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyBDbG91ZEZyb250IERpc3RyaWJ1dGlvbiBmb3IgVUkgYW5kIEFQSSBwcm94eVxyXG4gICAgY29uc3QgZGlzdHJpYnV0aW9uID0gbmV3IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uKHRoaXMsICdVSURpc3RyaWJ1dGlvbicsIHtcclxuICAgICAgZGVmYXVsdEJlaGF2aW9yOiB7XHJcbiAgICAgICAgb3JpZ2luOiBuZXcgb3JpZ2lucy5TM1N0YXRpY1dlYnNpdGVPcmlnaW4odWlCdWNrZXQpLFxyXG4gICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxyXG4gICAgICAgIGNhY2hlUG9saWN5OiBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfT1BUSU1JWkVELFxyXG4gICAgICB9LFxyXG4gICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzOiB7XHJcbiAgICAgICAgJy9hcGkvKic6IHtcclxuICAgICAgICAgIG9yaWdpbjogbmV3IG9yaWdpbnMuSHR0cE9yaWdpbihhbGIubG9hZEJhbGFuY2VyRG5zTmFtZSwge1xyXG4gICAgICAgICAgICBwcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5PcmlnaW5Qcm90b2NvbFBvbGljeS5IVFRQX09OTFksXHJcbiAgICAgICAgICAgIGNvbm5lY3Rpb25UaW1lb3V0OiBEdXJhdGlvbi5zZWNvbmRzKDEwKSxcclxuICAgICAgICAgICAgY29ubmVjdGlvbkF0dGVtcHRzOiAzLFxyXG4gICAgICAgICAgICByZWFkVGltZW91dDogRHVyYXRpb24uc2Vjb25kcyg2MCksIC8vIE1heCBhbGxvd2VkIGJ5IENsb3VkRnJvbnRcclxuICAgICAgICAgIH0pLFxyXG4gICAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXHJcbiAgICAgICAgICBjYWNoZVBvbGljeTogY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVELFxyXG4gICAgICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogY2xvdWRmcm9udC5PcmlnaW5SZXF1ZXN0UG9saWN5LkNPUlNfUzNfT1JJR0lOLFxyXG4gICAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMLFxyXG4gICAgICAgIH0sXHJcbiAgICAgIH0sXHJcbiAgICAgIGRlZmF1bHRSb290T2JqZWN0OiAnaW5kZXguaHRtbCcsXHJcbiAgICAgIGVycm9yUmVzcG9uc2VzOiBbXHJcbiAgICAgICAge1xyXG4gICAgICAgICAgaHR0cFN0YXR1czogNDA0LFxyXG4gICAgICAgICAgcmVzcG9uc2VIdHRwU3RhdHVzOiAyMDAsXHJcbiAgICAgICAgICByZXNwb25zZVBhZ2VQYXRoOiAnL2luZGV4Lmh0bWwnLCAvLyBGb3IgU1BBIHJvdXRpbmdcclxuICAgICAgICB9LFxyXG4gICAgICBdLFxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gVUkgYnVpbGQgcGlwZWxpbmUgZHJpdmVuIGJ5IENvZGVCdWlsZFxyXG4gICAgY29uc3QgdWlTcmMgPSBuZXcgczNhc3NldHMuQXNzZXQodGhpcywgJ1VJU291cmNlJywge1xyXG4gICAgICBwYXRoOiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vLi4vdWknKSxcclxuICAgICAgZXhjbHVkZTogW1xyXG4gICAgICAgICdub2RlX21vZHVsZXMnLFxyXG4gICAgICAgICcubmV4dCcsXHJcbiAgICAgICAgJ291dCcsXHJcbiAgICAgICAgJ2Rpc3QnLFxyXG4gICAgICAgICdidWlsZCcsXHJcbiAgICAgICAgJyoubG9nJyxcclxuICAgICAgICAnbnBtLWRlYnVnLmxvZycsXHJcbiAgICAgICAgJ3lhcm4tZXJyb3IubG9nJyxcclxuICAgICAgICAnLkRTX1N0b3JlJyxcclxuICAgICAgXSxcclxuICAgIH0pO1xyXG5cclxuICAgIGNvbnN0IHVpQnVpbGRQcm9qZWN0ID0gbmV3IGNvZGVidWlsZC5Qcm9qZWN0KHRoaXMsICdVSUJ1aWxkUHJvamVjdCcsIHtcclxuICAgICAgZW52aXJvbm1lbnQ6IHtcclxuICAgICAgICBidWlsZEltYWdlOiBjb2RlYnVpbGQuTGludXhCdWlsZEltYWdlLlNUQU5EQVJEXzdfMCxcclxuICAgICAgfSxcclxuICAgICAgZW52aXJvbm1lbnRWYXJpYWJsZXM6IHtcclxuICAgICAgICBTUkNfQlVDS0VUOiB7IHZhbHVlOiB1aVNyYy5zM0J1Y2tldE5hbWUgfSxcclxuICAgICAgICBTUkNfS0VZOiB7IHZhbHVlOiB1aVNyYy5zM09iamVjdEtleSB9LFxyXG4gICAgICAgIFRBUkdFVF9CVUNLRVQ6IHsgdmFsdWU6IHVpQnVja2V0LmJ1Y2tldE5hbWUgfSxcclxuICAgICAgICBORVhUX1BVQkxJQ19VU0VSX1BPT0xfSUQ6IHsgdmFsdWU6IHByb3BzLmNvZ25pdG9Vc2VyUG9vbElkIH0sXHJcbiAgICAgICAgTkVYVF9QVUJMSUNfVVNFUl9QT09MX0NMSUVOVF9JRDogeyB2YWx1ZTogcHJvcHMuY29nbml0b1VzZXJQb29sQ2xpZW50SWQgfSxcclxuICAgICAgICBORVhUX1BVQkxJQ19BUElfRU5EUE9JTlQ6IHsgdmFsdWU6ICcvYXBpJyB9LFxyXG4gICAgICAgIE5FWFRfUFVCTElDX0FXU19SRUdJT046IHsgdmFsdWU6IHRoaXMucmVnaW9uIH0sXHJcbiAgICAgICAgTkVYVF9QVUJMSUNfSURFTlRJVFlfUE9PTF9JRDogeyB2YWx1ZTogJycgfSxcclxuICAgICAgfSxcclxuICAgICAgYnVpbGRTcGVjOiBjb2RlYnVpbGQuQnVpbGRTcGVjLmZyb21PYmplY3Qoe1xyXG4gICAgICAgIHZlcnNpb246ICcwLjInLFxyXG4gICAgICAgIHBoYXNlczoge1xyXG4gICAgICAgICAgcHJlX2J1aWxkOiB7XHJcbiAgICAgICAgICAgIGNvbW1hbmRzOiBbXHJcbiAgICAgICAgICAgICAgJ2VjaG8gRG93bmxvYWRpbmcgVUkgc291cmNlIGJ1bmRsZScsXHJcbiAgICAgICAgICAgICAgJ2F3cyBzMyBjcCBzMzovLyRTUkNfQlVDS0VULyRTUkNfS0VZIHNyYy56aXAnLFxyXG4gICAgICAgICAgICAgICdybSAtcmYgc3JjJyxcclxuICAgICAgICAgICAgICAnbWtkaXIgLXAgc3JjJyxcclxuICAgICAgICAgICAgICAndW56aXAgLXEgc3JjLnppcCAtZCBzcmMnLFxyXG4gICAgICAgICAgICBdLFxyXG4gICAgICAgICAgfSxcclxuICAgICAgICAgIGJ1aWxkOiB7XHJcbiAgICAgICAgICAgIGNvbW1hbmRzOiBbXHJcbiAgICAgICAgICAgICAgJ2VjaG8gXCJCdWlsZGluZyBOZXh0LmpzIFVJXCInLFxyXG4gICAgICAgICAgICAgICcoY2Qgc3JjICYmIG5wbSBjaSknLFxyXG4gICAgICAgICAgICAgICcoY2Qgc3JjICYmIG5wbSBydW4gYnVpbGQpJyxcclxuICAgICAgICAgICAgICAnKGNkIHNyYyAmJiBucG0gcnVuIGV4cG9ydCknLFxyXG4gICAgICAgICAgICAgICcoY2Qgc3JjICYmIHB3ZCknLFxyXG4gICAgICAgICAgICAgICcoY2Qgc3JjICYmIGxzIC1SKScsXHJcbiAgICAgICAgICAgICAgJ2VjaG8gXCJCdWlsZCBjb21wbGV0ZVwiJyxcclxuICAgICAgICAgICAgXSxcclxuICAgICAgICAgIH0sXHJcbiAgICAgICAgICBwb3N0X2J1aWxkOiB7XHJcbiAgICAgICAgICAgIGNvbW1hbmRzOiBbXHJcbiAgICAgICAgICAgICAgJ0VYUE9SVF9ESVI9XCJcIicsXHJcbiAgICAgICAgICAgICAgJ2lmIFsgLWQgc3JjL291dCBdOyB0aGVuIEVYUE9SVF9ESVI9XCJzcmMvb3V0XCI7IGZpJyxcclxuICAgICAgICAgICAgICAnaWYgWyAteiBcIiRFWFBPUlRfRElSXCIgXSAmJiBbIC1kIHNyYy8ubmV4dC9leHBvcnQgXTsgdGhlbiBFWFBPUlRfRElSPVwic3JjLy5uZXh0L2V4cG9ydFwiOyBmaScsXHJcbiAgICAgICAgICAgICAgJ2lmIFsgLXogXCIkRVhQT1JUX0RJUlwiIF07IHRoZW4gZWNobyBcIlN0YXRpYyBleHBvcnQgZGlyZWN0b3J5IG5vdCBmb3VuZCAoZXhwZWN0ZWQgc3JjL291dCBvciBzcmMvLm5leHQvZXhwb3J0KVwiICYmIGV4aXQgMTsgZmknLFxyXG4gICAgICAgICAgICAgICdhd3MgczMgc3luYyBcIiRFWFBPUlRfRElSXCIvIHMzOi8vJFRBUkdFVF9CVUNLRVQgLS1kZWxldGUnLFxyXG4gICAgICAgICAgICBdLFxyXG4gICAgICAgICAgfSxcclxuICAgICAgICB9LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB9KSxcclxuICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgICAgICBcclxuICAgIHVpU3JjLmdyYW50UmVhZCh1aUJ1aWxkUHJvamVjdCk7XHJcbiAgICB1aUJ1Y2tldC5ncmFudFJlYWRXcml0ZSh1aUJ1aWxkUHJvamVjdCk7XHJcblxyXG4gICAgY29uc3QgdWlCdWlsZFRyaWdnZXIgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdVSUJ1aWxkVHJpZ2dlckZuJywge1xyXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKGBcclxuaW1wb3J0IGpzb25cclxuaW1wb3J0IGJvdG8zXHJcbmltcG9ydCB0aW1lXHJcblxyXG5kZWYgaGFuZGxlcihldmVudCwgX2NvbnRleHQpOlxyXG4gICAgcHJpbnQoZlwiUmVjZWl2ZWQgZXZlbnQ6IHtqc29uLmR1bXBzKGV2ZW50KX1cIilcclxuXHJcbiAgICBpZiBldmVudFsnUmVxdWVzdFR5cGUnXSA9PSAnRGVsZXRlJzpcclxuICAgICAgICByZXR1cm4geydQaHlzaWNhbFJlc291cmNlSWQnOiAnVUlCdWlsZFRyaWdnZXInfVxyXG5cclxuICAgIHByb2plY3RfbmFtZSA9IGV2ZW50WydSZXNvdXJjZVByb3BlcnRpZXMnXVsnUHJvamVjdE5hbWUnXVxyXG4gICAgY29kZWJ1aWxkID0gYm90bzMuY2xpZW50KCdjb2RlYnVpbGQnKVxyXG5cclxuICAgIHJlc3BvbnNlID0gY29kZWJ1aWxkLnN0YXJ0X2J1aWxkKHByb2plY3ROYW1lPXByb2plY3RfbmFtZSlcclxuICAgIGJ1aWxkX2lkID0gcmVzcG9uc2VbJ2J1aWxkJ11bJ2lkJ11cclxuICAgIHByaW50KGZcIlN0YXJ0ZWQgVUkgYnVpbGQ6IHtidWlsZF9pZH1cIilcclxuXHJcbiAgICB3aGlsZSBUcnVlOlxyXG4gICAgICAgIHRpbWUuc2xlZXAoMTApXHJcbiAgICAgICAgYnVpbGQgPSBjb2RlYnVpbGQuYmF0Y2hfZ2V0X2J1aWxkcyhpZHM9W2J1aWxkX2lkXSlbJ2J1aWxkcyddWzBdXHJcbiAgICAgICAgc3RhdHVzID0gYnVpbGRbJ2J1aWxkU3RhdHVzJ11cclxuICAgICAgICBwcmludChmXCJVSSBidWlsZCBzdGF0dXM6IHtzdGF0dXN9XCIpXHJcbiAgICAgICAgaWYgc3RhdHVzIGluIFsnU1VDQ0VFREVEJywgJ0ZBSUxFRCcsICdGQVVMVCcsICdTVE9QUEVEJywgJ1RJTUVEX09VVCddOlxyXG4gICAgICAgICAgICBpZiBzdGF0dXMgIT0gJ1NVQ0NFRURFRCc6XHJcbiAgICAgICAgICAgICAgICByYWlzZSBFeGNlcHRpb24oZlwiVUkgYnVpbGQgZmFpbGVkIHdpdGggc3RhdHVzOiB7c3RhdHVzfVwiKVxyXG4gICAgICAgICAgICBicmVha1xyXG5cclxuICAgIHJldHVybiB7XHJcbiAgICAgICAgJ1BoeXNpY2FsUmVzb3VyY2VJZCc6ICdVSUJ1aWxkVHJpZ2dlcicsXHJcbiAgICAgICAgJ0RhdGEnOiB7J0J1aWxkSWQnOiBidWlsZF9pZCwgJ1N0YXR1cyc6ICdTVUNDRVNTJ31cclxuICAgIH1cclxuICAgICAgYCksXHJcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcclxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTIsXHJcbiAgICAgIHRpbWVvdXQ6IER1cmF0aW9uLm1pbnV0ZXMoMTUpLFxyXG4gICAgfSk7XHJcblxyXG4gICAgdWlCdWlsZFRyaWdnZXIuYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgYWN0aW9uczogWydjb2RlYnVpbGQ6U3RhcnRCdWlsZCcsICdjb2RlYnVpbGQ6QmF0Y2hHZXRCdWlsZHMnXSxcclxuICAgICAgcmVzb3VyY2VzOiBbdWlCdWlsZFByb2plY3QucHJvamVjdEFybl0sXHJcbiAgICB9KSk7XHJcblxyXG4gICAgY29uc3QgdWlCdWlsZFByb3ZpZGVyID0gbmV3IGNyLlByb3ZpZGVyKHRoaXMsICdVSUJ1aWxkUHJvdmlkZXInLCB7XHJcbiAgICAgIG9uRXZlbnRIYW5kbGVyOiB1aUJ1aWxkVHJpZ2dlcixcclxuICAgIH0pO1xyXG5cclxuICAgIGNvbnN0IHVpQnVpbGRSZXNvdXJjZSA9IG5ldyBDdXN0b21SZXNvdXJjZSh0aGlzLCAnVUlCdWlsZFJlc291cmNlJywge1xyXG4gICAgICBzZXJ2aWNlVG9rZW46IHVpQnVpbGRQcm92aWRlci5zZXJ2aWNlVG9rZW4sXHJcbiAgICAgIHByb3BlcnRpZXM6IHtcclxuICAgICAgICBQcm9qZWN0TmFtZTogdWlCdWlsZFByb2plY3QucHJvamVjdE5hbWUsXHJcbiAgICAgIH0sXHJcbiAgICB9KTtcclxuXHJcbiAgICB1aUJ1aWxkUmVzb3VyY2Uubm9kZS5hZGREZXBlbmRlbmN5KHVpU3JjKTtcclxuICAgIHVpQnVpbGRSZXNvdXJjZS5ub2RlLmFkZERlcGVuZGVuY3kodWlCdWNrZXQpO1xyXG4gICAgdWlCdWlsZFJlc291cmNlLm5vZGUuYWRkRGVwZW5kZW5jeShkaXN0cmlidXRpb24pO1xyXG4gICAgdWlCdWlsZFJlc291cmNlLm5vZGUuYWRkRGVwZW5kZW5jeShhbGIpO1xyXG5cclxuICAgIC8vIE91dHB1dHNcclxuICAgIG5ldyBDZm5PdXRwdXQodGhpcywgJ0NoYXRTZXJ2aWNlVXJsJywge1xyXG4gICAgICB2YWx1ZTogdGhpcy5jaGF0U2VydmljZVVybCxcclxuICAgICAgZGVzY3JpcHRpb246ICdTdXBwbHlTZW5zZSBDaGF0IE9yY2hlc3RyYXRpb24gU2VydmljZSBVUkwnXHJcbiAgICB9KTtcclxuICAgIG5ldyBDZm5PdXRwdXQodGhpcywgJ0NoYXRTZXJ2aWNlQUxCRG5zJywge1xyXG4gICAgICB2YWx1ZTogYWxiLmxvYWRCYWxhbmNlckRuc05hbWUsXHJcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlciBETlMgTmFtZSdcclxuICAgIH0pO1xyXG4gICAgbmV3IENmbk91dHB1dCh0aGlzLCAnQ2hhdFVJVXJsJywge1xyXG4gICAgICB2YWx1ZTogYGh0dHBzOi8vJHtkaXN0cmlidXRpb24uZGlzdHJpYnV0aW9uRG9tYWluTmFtZX1gLFxyXG4gICAgICBkZXNjcmlwdGlvbjogJ1N1cHBseVNlbnNlIFVJIFVSTCdcclxuICAgIH0pO1xyXG4gICAgbmV3IENmbk91dHB1dCh0aGlzLCAnQ2hhdFNlcnZpY2VCdWlsZFByb2plY3QnLCB7XHJcbiAgICAgIHZhbHVlOiBjaGF0QnVpbGRQcm9qZWN0LnByb2plY3ROYW1lLFxyXG4gICAgICBkZXNjcmlwdGlvbjogJ0NvZGVCdWlsZCBwcm9qZWN0IGZvciBDaGF0IFNlcnZpY2UgKEZsYXNrIHBhc3N0aHJvdWdoIHRvIEFnZW50Q29yZSknXHJcbiAgICB9KTtcclxuICB9XHJcbn0iXX0=