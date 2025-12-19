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
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
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

    // CodeBuild project for Chat Orchestration Service image (Python version)
    const chatSrc = new s3assets.Asset(this, 'ChatOrchestrationSrc', {
      path: path.join(__dirname, '../../orchestrator-python'),
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

    // Container Definition - Now use the built image
    const container = taskDefinition.addContainer('ChatOrchestrationContainer', {
      image: ecs.ContainerImage.fromEcrRepository(chatRepo, chatSrc.assetHash),
      memoryLimitMiB: 1536, // Reserve most of the task memory for the container
      cpu: 768, // Reserve most of the task CPU for the container
      environment: {
        AWS_REGION: this.region,
        COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
        COGNITO_USER_POOL_CLIENT_ID: props.cognitoUserPoolClientId,
        NODE_ENV: 'production',
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

    const listener = alb.addListener('ChatOrchestrationListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    // ECS Service
    const service = new ecs.FargateService(this, 'ChatOrchestrationService', {
      cluster,
      taskDefinition,
      desiredCount: 1, // Start with 1 for cost optimization
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

    // Create a full chat interface with authentication
    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SupplySense - AI Supply Chain Intelligence</title>
    <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <script src="https://unpkg.com/amazon-cognito-identity-js@6.3.12/dist/amazon-cognito-identity.min.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { 
            background: linear-gradient(135deg, #0f172a 0%, #1e3a8a 50%, #0f172a 100%);
            min-height: 100vh;
            margin: 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
    </style>
</head>
<body>
    <div id="root"></div>
    <script type="text/babel">
        const { useState, useEffect } = React;
        
        const config = {
            userPoolId: '${props.cognitoUserPoolId}',
            userPoolClientId: '${props.cognitoUserPoolClientId}',
            apiEndpoint: '/api',
            region: '${this.region}'
        };
        
        // Initialize Cognito
        const poolData = {
            UserPoolId: config.userPoolId,
            ClientId: config.userPoolClientId
        };
        const userPool = new AmazonCognitoIdentity.CognitoUserPool(poolData);
        
        function LoginForm({ onLogin }) {
            const [username, setUsername] = useState('test@supplysense.com');
            const [password, setPassword] = useState('');
            const [newPassword, setNewPassword] = useState('');
            const [isLoading, setIsLoading] = useState(false);
            const [needsNewPassword, setNeedsNewPassword] = useState(false);
            const [error, setError] = useState('');
            
            const handleLogin = () => {
                setIsLoading(true);
                setError('');
                
                const authenticationData = {
                    Username: username,
                    Password: password,
                };
                const authenticationDetails = new AmazonCognitoIdentity.AuthenticationDetails(authenticationData);
                
                const userData = {
                    Username: username,
                    Pool: userPool,
                };
                const cognitoUser = new AmazonCognitoIdentity.CognitoUser(userData);
                
                cognitoUser.authenticateUser(authenticationDetails, {
                    onSuccess: (result) => {
                        setIsLoading(false);
                        onLogin(result.getIdToken().getJwtToken(), username);
                    },
                    onFailure: (err) => {
                        setIsLoading(false);
                        setError(err.message);
                    },
                    newPasswordRequired: (userAttributes, requiredAttributes) => {
                        setIsLoading(false);
                        setNeedsNewPassword(true);
                        window.cognitoUser = cognitoUser; // Store for password change
                    }
                });
            };
            
            const handleNewPassword = () => {
                setIsLoading(true);
                setError('');
                
                window.cognitoUser.completeNewPasswordChallenge(newPassword, {}, {
                    onSuccess: (result) => {
                        setIsLoading(false);
                        onLogin(result.getIdToken().getJwtToken(), username);
                    },
                    onFailure: (err) => {
                        setIsLoading(false);
                        setError(err.message);
                    }
                });
            };
            
            if (needsNewPassword) {
                return (
                    <div className="space-y-4">
                        <h3 className="text-xl font-semibold text-white mb-4">Set New Password</h3>
                        <input
                            type="password"
                            placeholder="New Password"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            className="w-full p-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-blue-200"
                        />
                        <button
                            onClick={handleNewPassword}
                            disabled={isLoading || !newPassword}
                            className="w-full bg-gradient-to-r from-blue-500 to-purple-600 text-white py-3 rounded-lg hover:from-blue-600 hover:to-purple-700 disabled:opacity-50"
                        >
                            {isLoading ? 'Setting Password...' : 'Set Password'}
                        </button>
                        {error && <p className="text-red-300 text-sm">{error}</p>}
                    </div>
                );
            }
            
            return (
                <div className="space-y-4">
                    <h3 className="text-xl font-semibold text-white mb-4">Login to SupplySense</h3>
                    <input
                        type="email"
                        placeholder="Email"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        className="w-full p-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-blue-200"
                    />
                    <input
                        type="password"
                        placeholder="Password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && handleLogin()}
                        className="w-full p-3 bg-white/10 border border-white/20 rounded-lg text-white placeholder-blue-200"
                    />
                    <button
                        onClick={handleLogin}
                        disabled={isLoading || !username || !password}
                        className="w-full bg-gradient-to-r from-blue-500 to-purple-600 text-white py-3 rounded-lg hover:from-blue-600 hover:to-purple-700 disabled:opacity-50"
                    >
                        {isLoading ? 'Signing In...' : 'Sign In'}
                    </button>
                    {error && <p className="text-red-300 text-sm">{error}</p>}
                    <div className="text-center text-blue-200 text-sm">
                        <p>Test Account: test@supplysense.com</p>
                        <p>Use temporary password: TempPass123!</p>
                    </div>
                </div>
            );
        }
        
        function ChatInterface({ token, username, onLogout }) {
            const [messages, setMessages] = useState([
                {
                    id: '1',
                    type: 'agent',
                    content: 'Hello! I\\'m your SupplySense AI assistant. Ask me about inventory levels, fulfillment capacity, or supply chain optimization. For example: "Can I fulfill all customer orders this week given current inventory?"',
                    timestamp: new Date(),
                    agentType: 'orchestrator'
                }
            ]);
            const [inputMessage, setInputMessage] = useState('');
            const [isLoading, setIsLoading] = useState(false);
            
            const sendMessage = async () => {
                if (!inputMessage.trim()) return;
                
                const userMessage = {
                    id: Date.now().toString(),
                    type: 'user',
                    content: inputMessage,
                    timestamp: new Date(),
                };
                
                setMessages(prev => [...prev, userMessage]);
                const currentQuery = inputMessage;
                setInputMessage('');
                setIsLoading(true);
                
                try {
                    const response = await fetch(config.apiEndpoint + '/chat', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + token,
                        },
                        body: JSON.stringify({
                            query: currentQuery,
                            sessionId: 'session-' + username + '-' + Date.now(),
                        }),
                    });
                    
                    if (!response.ok) {
                        throw new Error('Failed to get response');
                    }
                    
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';
                    let currentAgentMessage = null;
                    
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\\n');
                        buffer = lines.pop() || '';
                        
                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                try {
                                    const data = JSON.parse(line.slice(6));
                                    
                                    if (data.type === 'status') {
                                        currentAgentMessage = {
                                            id: Date.now().toString(),
                                            type: 'agent',
                                            content: '🔄 ' + data.message,
                                            timestamp: new Date(),
                                            agentType: 'orchestrator',
                                        };
                                        setMessages(prev => [...prev, currentAgentMessage]);
                                    } else if (data.type === 'final_response') {
                                        const finalMessage = {
                                            id: Date.now().toString(),
                                            type: 'agent',
                                            content: typeof data.response === 'string' ? data.response : JSON.stringify(data.response, null, 2),
                                            timestamp: new Date(),
                                            agentType: 'orchestrator',
                                        };
                                        setMessages(prev => [...prev.slice(0, -1), finalMessage]);
                                    } else if (data.type === 'complete') {
                                        setIsLoading(false);
                                        break;
                                    }
                                } catch (e) {
                                    console.error('Error parsing SSE data:', e);
                                }
                            }
                        }
                    }
                } catch (error) {
                    console.error('Error:', error);
                    const errorMessage = {
                        id: Date.now().toString(),
                        type: 'agent',
                        content: '❌ Error: ' + error.message,
                        timestamp: new Date(),
                        agentType: 'orchestrator',
                    };
                    setMessages(prev => [...prev, errorMessage]);
                    setIsLoading(false);
                }
            };
            
            return (
                <div className="min-h-screen flex flex-col">
                    {/* Header */}
                    <div className="bg-white/10 backdrop-blur-md border-b border-white/20 p-4">
                        <div className="flex justify-between items-center">
                            <div className="flex items-center">
                                <div className="p-2 bg-gradient-to-r from-blue-500 to-purple-600 rounded-lg mr-3">
                                    <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 20 20">
                                        <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z"/>
                                    </svg>
                                </div>
                                <div>
                                    <h1 className="text-xl font-bold text-white">SupplySense</h1>
                                    <p className="text-sm text-blue-200">Welcome, {username}</p>
                                </div>
                            </div>
                            <button
                                onClick={onLogout}
                                className="bg-red-500/20 hover:bg-red-500/30 text-red-300 px-4 py-2 rounded-lg"
                            >
                                Logout
                            </button>
                        </div>
                    </div>
                    
                    {/* Chat Messages */}
                    <div className="flex-1 overflow-y-auto p-6 space-y-4">
                        {messages.map((message) => (
                            <div key={message.id} className={\`flex \${message.type === 'user' ? 'justify-end' : 'justify-start'}\`}>
                                <div className={\`max-w-2xl px-4 py-3 rounded-xl \${
                                    message.type === 'user' 
                                        ? 'bg-gradient-to-r from-blue-500 to-purple-600 text-white' 
                                        : 'bg-white/10 backdrop-blur-sm text-white border border-white/20'
                                }\`}>
                                    {message.type === 'agent' && message.agentType && (
                                        <div className="text-xs text-blue-200 mb-2 font-medium">
                                            🔄 Orchestrator Agent
                                        </div>
                                    )}
                                    <div className="whitespace-pre-line text-sm leading-relaxed">{message.content}</div>
                                </div>
                            </div>
                        ))}
                        
                        {isLoading && (
                            <div className="flex justify-start">
                                <div className="bg-white/10 backdrop-blur-sm text-white px-4 py-3 rounded-xl border border-white/20">
                                    <div className="flex items-center space-x-3">
                                        <div className="animate-spin rounded-full h-5 w-5 border-2 border-blue-400 border-t-transparent"></div>
                                        <span className="text-sm">AI agents analyzing...</span>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                    
                    {/* Input */}
                    <div className="p-6 border-t border-white/20">
                        <div className="flex space-x-3">
                            <input
                                type="text"
                                value={inputMessage}
                                onChange={(e) => setInputMessage(e.target.value)}
                                onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                                placeholder="Ask about inventory, orders, or supply chain optimization..."
                                className="flex-1 bg-white/10 backdrop-blur-sm border border-white/20 rounded-xl px-4 py-3 text-white placeholder-blue-200 focus:outline-none focus:ring-2 focus:ring-blue-400"
                            />
                            <button
                                onClick={sendMessage}
                                disabled={isLoading || !inputMessage.trim()}
                                className="bg-gradient-to-r from-blue-500 to-purple-600 text-white px-6 py-3 rounded-xl hover:from-blue-600 hover:to-purple-700 disabled:opacity-50"
                            >
                                Send
                            </button>
                        </div>
                    </div>
                </div>
            );
        }
        
        function App() {
            const [user, setUser] = useState(null);
            const [token, setToken] = useState(null);
            
            const handleLogin = (jwtToken, username) => {
                setToken(jwtToken);
                setUser({ username });
            };
            
            const handleLogout = () => {
                setToken(null);
                setUser(null);
                const cognitoUser = userPool.getCurrentUser();
                if (cognitoUser) {
                    cognitoUser.signOut();
                }
            };
            
            if (!user) {
                return (
                    <div className="min-h-screen flex items-center justify-center p-8">
                        <div className="bg-white/10 backdrop-blur-md rounded-2xl p-8 max-w-md w-full border border-white/20">
                            <div className="text-center mb-6">
                                <div className="inline-flex p-4 bg-gradient-to-r from-blue-500 to-purple-600 rounded-2xl mb-4">
                                    <svg className="w-12 h-12 text-white" fill="currentColor" viewBox="0 0 20 20">
                                        <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z"/>
                                    </svg>
                                </div>
                                <h1 className="text-3xl font-bold text-white mb-2">SupplySense</h1>
                                <p className="text-lg text-blue-200">AI Supply Chain Intelligence</p>
                            </div>
                            <LoginForm onLogin={handleLogin} />
                        </div>
                    </div>
                );
            }
            
            return <ChatInterface token={token} username={user.username} onLogout={handleLogout} />;
        }
        
        ReactDOM.render(<App />, document.getElementById('root'));
    </script>
</body>
</html>`;

    // Deploy simple HTML file to S3
    const uiBuild = new s3deploy.BucketDeployment(this, 'UIDeployment', {
      sources: [
        s3deploy.Source.data('index.html', htmlContent)
      ],
      destinationBucket: uiBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // Make sure UI deployment happens after the ALB is ready
    uiBuild.node.addDependency(alb);

    // Outputs
    new CfnOutput(this, 'ChatServiceUrl', {
      value: this.chatServiceUrl,
      description: 'SupplySense Chat Orchestration Service URL'
    });
    new CfnOutput(this, 'ChatServiceALB', {
      value: alb.loadBalancerDnsName,
      description: 'Application Load Balancer DNS Name'
    });
    new CfnOutput(this, 'UIUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'SupplySense UI URL'
    });
    new CfnOutput(this, 'ChatBuildProject', {
      value: chatBuildProject.projectName,
      description: 'CodeBuild project for Chat Orchestration Service'
    });
  }
}