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
const s3deploy = __importStar(require("aws-cdk-lib/aws-s3-deployment"));
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
        new aws_cdk_lib_1.CfnOutput(this, 'ChatServiceUrl', {
            value: this.chatServiceUrl,
            description: 'SupplySense Chat Orchestration Service URL'
        });
        new aws_cdk_lib_1.CfnOutput(this, 'ChatServiceALB', {
            value: alb.loadBalancerDnsName,
            description: 'Application Load Balancer DNS Name'
        });
        new aws_cdk_lib_1.CfnOutput(this, 'UIUrl', {
            value: `https://${distribution.distributionDomainName}`,
            description: 'SupplySense UI URL'
        });
        new aws_cdk_lib_1.CfnOutput(this, 'ChatBuildProject', {
            value: chatBuildProject.projectName,
            description: 'CodeBuild project for Chat Orchestration Service'
        });
    }
}
exports.SupplySenseChatStack = SupplySenseChatStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3VwcGx5c2Vuc2UtY2hhdC1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInN1cHBseXNlbnNlLWNoYXQtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQXFGO0FBQ3JGLGlEQUFtQztBQUVuQyx5REFBMkM7QUFDM0MseURBQTJDO0FBQzNDLHlEQUEyQztBQUMzQyx5REFBMkM7QUFDM0MsOEVBQWdFO0FBQ2hFLDJEQUE2QztBQUM3QyxxRUFBdUQ7QUFDdkQsb0VBQXNEO0FBQ3RELCtEQUFpRDtBQUNqRCxpRUFBbUQ7QUFDbkQsdURBQXlDO0FBQ3pDLHVFQUF5RDtBQUN6RCw0RUFBOEQ7QUFDOUQsd0VBQTBEO0FBQzFELDJDQUE2QjtBQU83QixNQUFhLG9CQUFxQixTQUFRLG1CQUFLO0lBRzdDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBMkI7UUFDbkUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsY0FBYztRQUNkLE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsZ0JBQWdCLEVBQUU7WUFDOUMsTUFBTSxFQUFFLENBQUM7WUFDVCxXQUFXLEVBQUUsQ0FBQyxFQUFFLG9CQUFvQjtTQUNyQyxDQUFDLENBQUM7UUFFSCxjQUFjO1FBQ2QsTUFBTSxPQUFPLEdBQUcsSUFBSSxHQUFHLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSx3QkFBd0IsRUFBRTtZQUM5RCxHQUFHO1lBQ0gsV0FBVyxFQUFFLDBCQUEwQjtTQUN4QyxDQUFDLENBQUM7UUFFSCxnREFBZ0Q7UUFDaEQsTUFBTSxRQUFRLEdBQUcsSUFBSSxHQUFHLENBQUMsVUFBVSxDQUFDLElBQUksRUFBRSx1QkFBdUIsRUFBRTtZQUNqRSxjQUFjLEVBQUUsa0NBQWtDLElBQUksQ0FBQyxPQUFPLElBQUksSUFB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UUFDaEMsTUFBTSxPQUFPLEdBQUcsSUFBSSxRQUFRLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRTtZQUNsRSxPQUFPLEVBQUU7Z0JBQ1AsUUFBUSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsWUFBWSxFQUFFLFdBQVcsQ0FBQzthQUNoRDtZQUNELGlCQUFpQixFQUFFLFFBQVE7WUFDM0IsWUFBWTtZQUNaLGlCQUFpQixFQUFFLENBQUMsSUFBSSxDQUFDO1NBQzFCLENBQUMsQ0FBQztRQUVILHlEQUF5RDtRQUN6RCxPQUFPLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUVoQyxVQUFVO1FBQ1YsSUFBSSx1QkFBUyxDQUFDLElBQUksRUFBRSxnQkFBZ0IsRUFBRTtZQUNwQyxLQUFLLEVBQUUsSUFBSSxDQUFDLGNBQWM7WUFDMUIsV0FBVyxFQUFFLDRDQUE0QztTQUMxRCxDQUFDLENBQUM7UUFDSCxJQUFJLHVCQUFTLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQ3BDLEtBQUssRUFBRSxHQUFHLENBQUMsbUJBQW1CO1lBQzlCLFdBQVcsRUFBRSxvQ0FBb0M7U0FDbEQsQ0FBQyxDQUFDO1FBQ0gsSUFBSSx1QkFBUyxDQUFDLElBQUksRUFBRSxPQUFPLEVBQUU7WUFDM0IsS0FBSyxFQUFFLFdBQVcsWUFBWSxDQUFDLHNCQUFzQixFQUFFO1lBQ3ZELFdBQVcsRUFBRSxvQkFBb0I7U0FDbEMsQ0FBQyxDQUFDO1FBQ0gsSUFBSSx1QkFBUyxDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRTtZQUN0QyxLQUFLLEVBQUUsZ0JBQWdCLENBQUMsV0FBVztZQUNuQyxXQUFXLEVBQUUsa0RBQWtEO1NBQ2hFLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQTF1QkQsb0RBMHVCQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFN0YWNrLCBTdGFja1Byb3BzLCBDZm5PdXRwdXQsIER1cmF0aW9uLCBDdXN0b21SZXNvdXJjZSB9IGZyb20gJ2F3cy1jZGstbGliJztcclxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcclxuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XHJcbmltcG9ydCAqIGFzIGVjcyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNzJztcclxuaW1wb3J0ICogYXMgZWMyIGZyb20gJ2F3cy1jZGstbGliL2F3cy1lYzInO1xyXG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XHJcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcclxuaW1wb3J0ICogYXMgZWxidjIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVsYXN0aWNsb2FkYmFsYW5jaW5ndjInO1xyXG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sb2dzJztcclxuaW1wb3J0ICogYXMgY29kZWJ1aWxkIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jb2RlYnVpbGQnO1xyXG5pbXBvcnQgKiBhcyBzM2Fzc2V0cyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMtYXNzZXRzJztcclxuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xyXG5pbXBvcnQgKiBhcyBjciBmcm9tICdhd3MtY2RrLWxpYi9jdXN0b20tcmVzb3VyY2VzJztcclxuaW1wb3J0ICogYXMgczMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzJztcclxuaW1wb3J0ICogYXMgY2xvdWRmcm9udCBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udCc7XHJcbmltcG9ydCAqIGFzIG9yaWdpbnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQtb3JpZ2lucyc7XHJcbmltcG9ydCAqIGFzIHMzZGVwbG95IGZyb20gJ2F3cy1jZGstbGliL2F3cy1zMy1kZXBsb3ltZW50JztcclxuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgU3VwcGx5U2Vuc2VDaGF0UHJvcHMgZXh0ZW5kcyBTdGFja1Byb3BzIHtcclxuICBjb2duaXRvVXNlclBvb2xJZDogc3RyaW5nO1xyXG4gIGNvZ25pdG9Vc2VyUG9vbENsaWVudElkOiBzdHJpbmc7XHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBTdXBwbHlTZW5zZUNoYXRTdGFjayBleHRlbmRzIFN0YWNrIHtcclxuICBwdWJsaWMgcmVhZG9ubHkgY2hhdFNlcnZpY2VVcmw6IHN0cmluZztcclxuXHJcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IFN1cHBseVNlbnNlQ2hhdFByb3BzKSB7XHJcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcclxuXHJcbiAgICAvLyBWUEMgZm9yIEVDU1xyXG4gICAgY29uc3QgdnBjID0gbmV3IGVjMi5WcGModGhpcywgJ1N1cHBseVNlbnNlVlBDJywge1xyXG4gICAgICBtYXhBenM6IDIsXHJcbiAgICAgIG5hdEdhdGV3YXlzOiAxLCAvLyBDb3N0IG9wdGltaXphdGlvblxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gRUNTIENsdXN0ZXJcclxuICAgIGNvbnN0IGNsdXN0ZXIgPSBuZXcgZWNzLkNsdXN0ZXIodGhpcywgJ1N1cHBseVNlbnNlQ2hhdENsdXN0ZXInLCB7XHJcbiAgICAgIHZwYyxcclxuICAgICAgY2x1c3Rlck5hbWU6ICdzdXBwbHlzZW5zZS1jaGF0LWNsdXN0ZXInLFxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gRUNSIFJlcG9zaXRvcnkgZm9yIENoYXQgT3JjaGVzdHJhdGlvbiBTZXJ2aWNlXHJcbiAgICBjb25zdCBjaGF0UmVwbyA9IG5ldyBlY3IuUmVwb3NpdG9yeSh0aGlzLCAnQ2hhdE9yY2hlc3RyYXRpb25SZXBvJywge1xyXG4gICAgICByZXBvc2l0b3J5TmFtZTogYHN1cHBseXNlbnNlLWNoYXQtb3JjaGVzdHJhdGlvbi0ke3RoaXMuYWNjb3VudH0tJHt0aGlzLnJlZ2lvbn1gLFxyXG4gICAgICBpbWFnZVNjYW5PblB1c2g6IHRydWUsXHJcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksIC8vIEFsbG93IGNsZWFudXAgb24gc3RhY2sgZGVsZXRpb25cclxuICAgIH0pO1xyXG5cclxuICAgIC8vIFRhc2sgUm9sZSBmb3IgQ2hhdCBPcmNoZXN0cmF0aW9uIFNlcnZpY2VcclxuICAgIGNvbnN0IHRhc2tSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdDaGF0T3JjaGVzdHJhdGlvblRhc2tSb2xlJywge1xyXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnZWNzLXRhc2tzLmFtYXpvbmF3cy5jb20nKSxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIEdyYW50IHBlcm1pc3Npb25zIHRvIGludm9rZSBBZ2VudENvcmUgcnVudGltZXNcclxuICAgIHRhc2tSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpJbnZva2VBZ2VudFJ1bnRpbWUnLFxyXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRBZ2VudFJ1bnRpbWUnLFxyXG4gICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpMaXN0QWdlbnRSdW50aW1lcycsXHJcbiAgICAgIF0sXHJcbiAgICAgIHJlc291cmNlczogWycqJ10sXHJcbiAgICB9KSk7XHJcblxyXG4gICAgLy8gR3JhbnQgU1NNIHBlcm1pc3Npb25zIHRvIHJlYWQgYWdlbnQgY29uZmlndXJhdGlvblxyXG4gICAgdGFza1JvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgJ3NzbTpHZXRQYXJhbWV0ZXInLFxyXG4gICAgICAgICdzc206R2V0UGFyYW1ldGVycycsXHJcbiAgICAgICAgJ3NzbTpHZXRQYXJhbWV0ZXJzQnlQYXRoJyxcclxuICAgICAgXSxcclxuICAgICAgcmVzb3VyY2VzOiBbYGFybjphd3M6c3NtOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpwYXJhbWV0ZXIvc3VwcGx5c2Vuc2UvYWdlbnRzLypgXSxcclxuICAgIH0pKTtcclxuXHJcbiAgICAvLyBHcmFudCBEeW5hbW9EQiBwZXJtaXNzaW9ucyBmb3Igc2Vzc2lvbiBtYW5hZ2VtZW50IGFuZCBkYXRhIGFjY2Vzc1xyXG4gICAgdGFza1JvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgJ2R5bmFtb2RiOkdldEl0ZW0nLFxyXG4gICAgICAgICdkeW5hbW9kYjpQdXRJdGVtJyxcclxuICAgICAgICAnZHluYW1vZGI6VXBkYXRlSXRlbScsXHJcbiAgICAgICAgJ2R5bmFtb2RiOlF1ZXJ5JyxcclxuICAgICAgICAnZHluYW1vZGI6U2NhbicsXHJcbiAgICAgIF0sXHJcbiAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgIGBhcm46YXdzOmR5bmFtb2RiOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTp0YWJsZS9zdXBwbHlzZW5zZS0qYCxcclxuICAgICAgICBgYXJuOmF3czpkeW5hbW9kYjoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06dGFibGUvY2hhdC1zZXNzaW9uc2AsXHJcbiAgICAgIF0sXHJcbiAgICB9KSk7XHJcblxyXG4gICAgLy8gR3JhbnQgQ2xvdWRGb3JtYXRpb24gcGVybWlzc2lvbnMgdG8gcmVhZCBzdGFjayBvdXRwdXRzXHJcbiAgICB0YXNrUm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAnY2xvdWRmb3JtYXRpb246RGVzY3JpYmVTdGFja3MnLFxyXG4gICAgICAgICdjbG91ZGZvcm1hdGlvbjpMaXN0U3RhY2tSZXNvdXJjZXMnLFxyXG4gICAgICBdLFxyXG4gICAgICByZXNvdXJjZXM6IFtcclxuICAgICAgICBgYXJuOmF3czpjbG91ZGZvcm1hdGlvbjoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06c3RhY2svU3VwcGx5U2Vuc2VBZ2VudENvcmVTdGFjay8qYCxcclxuICAgICAgXSxcclxuICAgIH0pKTtcclxuXHJcbiAgICAvLyBHcmFudCBDb2duaXRvIHBlcm1pc3Npb25zIGZvciBKV1QgdmFsaWRhdGlvblxyXG4gICAgdGFza1JvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgJ2NvZ25pdG8taWRwOkdldFVzZXInLFxyXG4gICAgICAgICdjb2duaXRvLWlkcDpBZG1pbkdldFVzZXInLFxyXG4gICAgICBdLFxyXG4gICAgICByZXNvdXJjZXM6IFtgYXJuOmF3czpjb2duaXRvLWlkcDoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06dXNlcnBvb2wvJHtwcm9wcy5jb2duaXRvVXNlclBvb2xJZH1gXSxcclxuICAgIH0pKTtcclxuXHJcbiAgICAvLyBFeGVjdXRpb24gUm9sZVxyXG4gICAgY29uc3QgZXhlY3V0aW9uUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnQ2hhdE9yY2hlc3RyYXRpb25FeGVjdXRpb25Sb2xlJywge1xyXG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnZWNzLXRhc2tzLmFtYXpvbmF3cy5jb20nKSxcclxuICAgICAgbWFuYWdlZFBvbGljaWVzOiBbXHJcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdzZXJ2aWNlLXJvbGUvQW1hem9uRUNTVGFza0V4ZWN1dGlvblJvbGVQb2xpY3knKSxcclxuICAgICAgXSxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIEdyYW50IEVDUiBwZXJtaXNzaW9uc1xyXG4gICAgY2hhdFJlcG8uZ3JhbnRQdWxsKGV4ZWN1dGlvblJvbGUpO1xyXG5cclxuICAgIC8vIENsb3VkV2F0Y2ggTG9nIEdyb3VwIC0gTWFrZSBpdCB1bmlxdWUgdG8gYXZvaWQgY29uZmxpY3RzXHJcbiAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsICdDaGF0T3JjaGVzdHJhdGlvbkxvZ0dyb3VwJywge1xyXG4gICAgICBsb2dHcm91cE5hbWU6IGAvZWNzL3N1cHBseXNlbnNlLWNoYXQtb3JjaGVzdHJhdGlvbi0ke3RoaXMuYWNjb3VudH0tJHt0aGlzLnJlZ2lvbn1gLFxyXG4gICAgICByZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFSyxcclxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSwgLy8gQWxsb3cgY2xlYW51cCBvbiBzdGFjayBkZWxldGlvblxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gVGFzayBEZWZpbml0aW9uXHJcbiAgICBjb25zdCB0YXNrRGVmaW5pdGlvbiA9IG5ldyBlY3MuRmFyZ2F0ZVRhc2tEZWZpbml0aW9uKHRoaXMsICdDaGF0T3JjaGVzdHJhdGlvblRhc2tEZWYnLCB7XHJcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiAyMDQ4LFxyXG4gICAgICBjcHU6IDEwMjQsXHJcbiAgICAgIHRhc2tSb2xlLFxyXG4gICAgICBleGVjdXRpb25Sb2xlLFxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gQ29kZUJ1aWxkIHByb2plY3QgZm9yIENoYXQgT3JjaGVzdHJhdGlvbiBTZXJ2aWNlIGltYWdlIChQeXRob24gdmVyc2lvbilcclxuICAgIGNvbnN0IGNoYXRTcmMgPSBuZXcgczNhc3NldHMuQXNzZXQodGhpcywgJ0NoYXRPcmNoZXN0cmF0aW9uU3JjJywge1xyXG4gICAgICBwYXRoOiBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4vLi4vb3JjaGVzdHJhdG9yLXB5dGhvbicpLFxyXG4gICAgfSk7XHJcblxyXG4gICAgY29uc3QgY2hhdEJ1aWxkUHJvamVjdCA9IG5ldyBjb2RlYnVpbGQuUHJvamVjdCh0aGlzLCAnQ2hhdE9yY2hlc3RyYXRpb25CdWlsZCcsIHtcclxuICAgICAgZW52aXJvbm1lbnQ6IHtcclxuICAgICAgICBidWlsZEltYWdlOiBjb2RlYnVpbGQuTGludXhCdWlsZEltYWdlLkFNQVpPTl9MSU5VWF8yXzUsXHJcbiAgICAgICAgcHJpdmlsZWdlZDogdHJ1ZVxyXG4gICAgICB9LFxyXG4gICAgICBlbnZpcm9ubWVudFZhcmlhYmxlczoge1xyXG4gICAgICAgIFJFUE9fVVJJOiB7IHZhbHVlOiBjaGF0UmVwby5yZXBvc2l0b3J5VXJpIH0sXHJcbiAgICAgICAgSU1BR0VfVEFHOiB7IHZhbHVlOiBjaGF0U3JjLmFzc2V0SGFzaCB9LFxyXG4gICAgICAgIFNSQ19CVUNLRVQ6IHsgdmFsdWU6IGNoYXRTcmMuczNCdWNrZXROYW1lIH0sXHJcbiAgICAgICAgU1JDX0tFWTogeyB2YWx1ZTogY2hhdFNyYy5zM09iamVjdEtleSB9LFxyXG4gICAgICAgIEFXU19SRUdJT046IHsgdmFsdWU6IHRoaXMucmVnaW9uIH0sXHJcbiAgICAgIH0sXHJcbiAgICAgIGJ1aWxkU3BlYzogY29kZWJ1aWxkLkJ1aWxkU3BlYy5mcm9tT2JqZWN0KHtcclxuICAgICAgICB2ZXJzaW9uOiAnMC4yJyxcclxuICAgICAgICBwaGFzZXM6IHtcclxuICAgICAgICAgIHByZV9idWlsZDoge1xyXG4gICAgICAgICAgICBjb21tYW5kczogW1xyXG4gICAgICAgICAgICAgICdlY2hvIExvZ2dpbmcgaW50byBFQ1InLFxyXG4gICAgICAgICAgICAgICdhd3MgZWNyIGdldC1sb2dpbi1wYXNzd29yZCAtLXJlZ2lvbiAkQVdTX1JFR0lPTiB8IGRvY2tlciBsb2dpbiAtLXVzZXJuYW1lIEFXUyAtLXBhc3N3b3JkLXN0ZGluICRSRVBPX1VSSScsXHJcbiAgICAgICAgICAgICAgJ2F3cyBzMyBjcCBzMzovLyRTUkNfQlVDS0VULyRTUkNfS0VZIHNyYy56aXAnLFxyXG4gICAgICAgICAgICAgICdta2RpciAtcCBzcmMgJiYgdW56aXAgLXEgc3JjLnppcCAtZCBzcmMgJiYgY2Qgc3JjJyxcclxuICAgICAgICAgICAgXSxcclxuICAgICAgICAgIH0sXHJcbiAgICAgICAgICBidWlsZDoge1xyXG4gICAgICAgICAgICBjb21tYW5kczogW1xyXG4gICAgICAgICAgICAgICdlY2hvIFwiQnVpbGRpbmcgRG9ja2VyIGltYWdlIHdpdGggcmV0cnkgbG9naWNcIicsXHJcbiAgICAgICAgICAgICAgJ2ZvciBpIGluIDEgMiAzOyBkbyBkb2NrZXIgYnVpbGQgLXQgJFJFUE9fVVJJOiRJTUFHRV9UQUcgLiAmJiBicmVhayB8fCBzbGVlcCAzMDsgZG9uZScsXHJcbiAgICAgICAgICAgICAgJ2RvY2tlciBwdXNoICRSRVBPX1VSSTokSU1BR0VfVEFHJyxcclxuICAgICAgICAgICAgXSxcclxuICAgICAgICAgIH0sXHJcbiAgICAgICAgfSxcclxuICAgICAgfSksXHJcbiAgICB9KTtcclxuXHJcbiAgICBjaGF0U3JjLmdyYW50UmVhZChjaGF0QnVpbGRQcm9qZWN0KTtcclxuICAgIGNoYXRSZXBvLmdyYW50UHVsbFB1c2goY2hhdEJ1aWxkUHJvamVjdCk7XHJcblxyXG4gICAgLy8gTm8gYWRkaXRpb25hbCBwZXJtaXNzaW9ucyBuZWVkZWQgZm9yIERvY2tlciBIdWJcclxuXHJcbiAgICAvLyBDdXN0b20gcmVzb3VyY2UgdG8gdHJpZ2dlciB0aGUgYnVpbGQgYmVmb3JlIEVDUyBzZXJ2aWNlIGNyZWF0aW9uXHJcbiAgICBjb25zdCBidWlsZFRyaWdnZXIgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdDaGF0QnVpbGRUcmlnZ2VyRm4nLCB7XHJcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21JbmxpbmUoYFxyXG5pbXBvcnQganNvblxyXG5pbXBvcnQgYm90bzNcclxuaW1wb3J0IHRpbWVcclxuXHJcbmRlZiBoYW5kbGVyKGV2ZW50LCBjb250ZXh0KTpcclxuICAgIHByaW50KGZcIlJlY2VpdmVkIGV2ZW50OiB7anNvbi5kdW1wcyhldmVudCl9XCIpXHJcbiAgICBcclxuICAgIGlmIGV2ZW50WydSZXF1ZXN0VHlwZSddID09ICdEZWxldGUnOlxyXG4gICAgICAgIHJldHVybiB7J1BoeXNpY2FsUmVzb3VyY2VJZCc6ICdDaGF0QnVpbGRUcmlnZ2VyJ31cclxuICAgIFxyXG4gICAgdHJ5OlxyXG4gICAgICAgIGNvZGVidWlsZCA9IGJvdG8zLmNsaWVudCgnY29kZWJ1aWxkJylcclxuICAgICAgICBcclxuICAgICAgICAjIFN0YXJ0IHRoZSBidWlsZFxyXG4gICAgICAgIHJlc3BvbnNlID0gY29kZWJ1aWxkLnN0YXJ0X2J1aWxkKFxyXG4gICAgICAgICAgICBwcm9qZWN0TmFtZT1ldmVudFsnUmVzb3VyY2VQcm9wZXJ0aWVzJ11bJ1Byb2plY3ROYW1lJ11cclxuICAgICAgICApXHJcbiAgICAgICAgXHJcbiAgICAgICAgYnVpbGRfaWQgPSByZXNwb25zZVsnYnVpbGQnXVsnaWQnXVxyXG4gICAgICAgIHByaW50KGZcIlN0YXJ0ZWQgYnVpbGQ6IHtidWlsZF9pZH1cIilcclxuICAgICAgICBcclxuICAgICAgICAjIFdhaXQgZm9yIGJ1aWxkIHRvIGNvbXBsZXRlXHJcbiAgICAgICAgd2hpbGUgVHJ1ZTpcclxuICAgICAgICAgICAgdGltZS5zbGVlcCgxMClcclxuICAgICAgICAgICAgYnVpbGRfc3RhdHVzID0gY29kZWJ1aWxkLmJhdGNoX2dldF9idWlsZHMoaWRzPVtidWlsZF9pZF0pXHJcbiAgICAgICAgICAgIHN0YXR1cyA9IGJ1aWxkX3N0YXR1c1snYnVpbGRzJ11bMF1bJ2J1aWxkU3RhdHVzJ11cclxuICAgICAgICAgICAgcHJpbnQoZlwiQnVpbGQgc3RhdHVzOiB7c3RhdHVzfVwiKVxyXG4gICAgICAgICAgICBcclxuICAgICAgICAgICAgaWYgc3RhdHVzIGluIFsnU1VDQ0VFREVEJywgJ0ZBSUxFRCcsICdGQVVMVCcsICdTVE9QUEVEJywgJ1RJTUVEX09VVCddOlxyXG4gICAgICAgICAgICAgICAgaWYgc3RhdHVzICE9ICdTVUNDRUVERUQnOlxyXG4gICAgICAgICAgICAgICAgICAgIHJhaXNlIEV4Y2VwdGlvbihmXCJCdWlsZCBmYWlsZWQgd2l0aCBzdGF0dXM6IHtzdGF0dXN9XCIpXHJcbiAgICAgICAgICAgICAgICBicmVha1xyXG4gICAgICAgIFxyXG4gICAgICAgIHJldHVybiB7XHJcbiAgICAgICAgICAgICdQaHlzaWNhbFJlc291cmNlSWQnOiAnQ2hhdEJ1aWxkVHJpZ2dlcicsXHJcbiAgICAgICAgICAgICdEYXRhJzogeydCdWlsZElkJzogYnVpbGRfaWQsICdTdGF0dXMnOiAnU1VDQ0VTUyd9XHJcbiAgICAgICAgfVxyXG4gICAgICAgIFxyXG4gICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOlxyXG4gICAgICAgIHByaW50KGZcIkVycm9yOiB7c3RyKGUpfVwiKVxyXG4gICAgICAgIHJhaXNlIGVcclxuICAgICAgYCksXHJcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcclxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTIsXHJcbiAgICAgIHRpbWVvdXQ6IER1cmF0aW9uLm1pbnV0ZXMoMTUpLFxyXG4gICAgfSk7XHJcblxyXG4gICAgYnVpbGRUcmlnZ2VyLmFkZFRvUm9sZVBvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgIGFjdGlvbnM6IFsnY29kZWJ1aWxkOlN0YXJ0QnVpbGQnLCAnY29kZWJ1aWxkOkJhdGNoR2V0QnVpbGRzJ10sXHJcbiAgICAgIHJlc291cmNlczogW2NoYXRCdWlsZFByb2plY3QucHJvamVjdEFybl0sXHJcbiAgICB9KSk7XHJcblxyXG4gICAgY29uc3QgYnVpbGRQcm92aWRlciA9IG5ldyBjci5Qcm92aWRlcih0aGlzLCAnQ2hhdEJ1aWxkUHJvdmlkZXInLCB7XHJcbiAgICAgIG9uRXZlbnRIYW5kbGVyOiBidWlsZFRyaWdnZXIsXHJcbiAgICB9KTtcclxuXHJcbiAgICBjb25zdCBidWlsZFJlc291cmNlID0gbmV3IEN1c3RvbVJlc291cmNlKHRoaXMsICdDaGF0QnVpbGRSZXNvdXJjZScsIHtcclxuICAgICAgc2VydmljZVRva2VuOiBidWlsZFByb3ZpZGVyLnNlcnZpY2VUb2tlbixcclxuICAgICAgcHJvcGVydGllczoge1xyXG4gICAgICAgIFByb2plY3ROYW1lOiBjaGF0QnVpbGRQcm9qZWN0LnByb2plY3ROYW1lLFxyXG4gICAgICAgIEltYWdlVGFnOiBjaGF0U3JjLmFzc2V0SGFzaCxcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIENvbnRhaW5lciBEZWZpbml0aW9uIC0gTm93IHVzZSB0aGUgYnVpbHQgaW1hZ2VcclxuICAgIGNvbnN0IGNvbnRhaW5lciA9IHRhc2tEZWZpbml0aW9uLmFkZENvbnRhaW5lcignQ2hhdE9yY2hlc3RyYXRpb25Db250YWluZXInLCB7XHJcbiAgICAgIGltYWdlOiBlY3MuQ29udGFpbmVySW1hZ2UuZnJvbUVjclJlcG9zaXRvcnkoY2hhdFJlcG8sIGNoYXRTcmMuYXNzZXRIYXNoKSxcclxuICAgICAgbWVtb3J5TGltaXRNaUI6IDE1MzYsIC8vIFJlc2VydmUgbW9zdCBvZiB0aGUgdGFzayBtZW1vcnkgZm9yIHRoZSBjb250YWluZXJcclxuICAgICAgY3B1OiA3NjgsIC8vIFJlc2VydmUgbW9zdCBvZiB0aGUgdGFzayBDUFUgZm9yIHRoZSBjb250YWluZXJcclxuICAgICAgZW52aXJvbm1lbnQ6IHtcclxuICAgICAgICBBV1NfUkVHSU9OOiB0aGlzLnJlZ2lvbixcclxuICAgICAgICBDT0dOSVRPX1VTRVJfUE9PTF9JRDogcHJvcHMuY29nbml0b1VzZXJQb29sSWQsXHJcbiAgICAgICAgQ09HTklUT19VU0VSX1BPT0xfQ0xJRU5UX0lEOiBwcm9wcy5jb2duaXRvVXNlclBvb2xDbGllbnRJZCxcclxuICAgICAgICBOT0RFX0VOVjogJ3Byb2R1Y3Rpb24nLFxyXG4gICAgICB9LFxyXG4gICAgICBsb2dnaW5nOiBlY3MuTG9nRHJpdmVycy5hd3NMb2dzKHtcclxuICAgICAgICBzdHJlYW1QcmVmaXg6ICdjaGF0LW9yY2hlc3RyYXRpb24nLFxyXG4gICAgICAgIGxvZ0dyb3VwLFxyXG4gICAgICB9KSxcclxuICAgICAgaGVhbHRoQ2hlY2s6IHtcclxuICAgICAgICBjb21tYW5kOiBbJ0NNRC1TSEVMTCcsICdjdXJsIC1mIGh0dHA6Ly9sb2NhbGhvc3Q6MzAwMC9oZWFsdGggfHwgZXhpdCAxJ10sXHJcbiAgICAgICAgaW50ZXJ2YWw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDMwKSxcclxuICAgICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygxMCksXHJcbiAgICAgICAgcmV0cmllczogMyxcclxuICAgICAgICBzdGFydFBlcmlvZDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApLCAvLyBHaXZlIHRoZSBhcHAgdGltZSB0byBzdGFydFxyXG4gICAgICB9LFxyXG4gICAgfSk7XHJcblxyXG4gICAgY29udGFpbmVyLmFkZFBvcnRNYXBwaW5ncyh7XHJcbiAgICAgIGNvbnRhaW5lclBvcnQ6IDMwMDAsXHJcbiAgICAgIHByb3RvY29sOiBlY3MuUHJvdG9jb2wuVENQLFxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlclxyXG4gICAgY29uc3QgYWxiID0gbmV3IGVsYnYyLkFwcGxpY2F0aW9uTG9hZEJhbGFuY2VyKHRoaXMsICdDaGF0T3JjaGVzdHJhdGlvbkFMQicsIHtcclxuICAgICAgdnBjLFxyXG4gICAgICBpbnRlcm5ldEZhY2luZzogdHJ1ZSxcclxuICAgIH0pO1xyXG5cclxuICAgIGNvbnN0IGxpc3RlbmVyID0gYWxiLmFkZExpc3RlbmVyKCdDaGF0T3JjaGVzdHJhdGlvbkxpc3RlbmVyJywge1xyXG4gICAgICBwb3J0OiA4MCxcclxuICAgICAgcHJvdG9jb2w6IGVsYnYyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIEVDUyBTZXJ2aWNlXHJcbiAgICBjb25zdCBzZXJ2aWNlID0gbmV3IGVjcy5GYXJnYXRlU2VydmljZSh0aGlzLCAnQ2hhdE9yY2hlc3RyYXRpb25TZXJ2aWNlJywge1xyXG4gICAgICBjbHVzdGVyLFxyXG4gICAgICB0YXNrRGVmaW5pdGlvbixcclxuICAgICAgZGVzaXJlZENvdW50OiAxLCAvLyBTdGFydCB3aXRoIDEgZm9yIGNvc3Qgb3B0aW1pemF0aW9uXHJcbiAgICAgIGFzc2lnblB1YmxpY0lwOiBmYWxzZSwgLy8gVXNlIHByaXZhdGUgc3VibmV0cyB3aXRoIE5BVFxyXG4gICAgICBzZXJ2aWNlTmFtZTogJ3N1cHBseXNlbnNlLWNoYXQtb3JjaGVzdHJhdGlvbicsXHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyBFQ1MgU2VydmljZSAtIE1ha2Ugc3VyZSBpdCBkZXBlbmRzIG9uIHRoZSBidWlsZCBjb21wbGV0aW5nXHJcbiAgICBzZXJ2aWNlLm5vZGUuYWRkRGVwZW5kZW5jeShidWlsZFJlc291cmNlKTtcclxuXHJcbiAgICAvLyBUYXJnZXQgR3JvdXBcclxuICAgIGxpc3RlbmVyLmFkZFRhcmdldHMoJ0NoYXRPcmNoZXN0cmF0aW9uVGFyZ2V0cycsIHtcclxuICAgICAgcG9ydDogMzAwMCxcclxuICAgICAgcHJvdG9jb2w6IGVsYnYyLkFwcGxpY2F0aW9uUHJvdG9jb2wuSFRUUCxcclxuICAgICAgdGFyZ2V0czogW3NlcnZpY2VdLFxyXG4gICAgICBoZWFsdGhDaGVjazoge1xyXG4gICAgICAgIHBhdGg6ICcvaGVhbHRoJyxcclxuICAgICAgICBpbnRlcnZhbDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxyXG4gICAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDUpLFxyXG4gICAgICAgIGhlYWx0aHlUaHJlc2hvbGRDb3VudDogMixcclxuICAgICAgICB1bmhlYWx0aHlUaHJlc2hvbGRDb3VudDogMyxcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG5cclxuXHJcblxyXG4gICAgdGhpcy5jaGF0U2VydmljZVVybCA9IGBodHRwOi8vJHthbGIubG9hZEJhbGFuY2VyRG5zTmFtZX1gO1xyXG5cclxuICAgIC8vIFMzIEJ1Y2tldCBmb3IgVUkgaG9zdGluZ1xyXG4gICAgY29uc3QgdWlCdWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsICdVSUJ1Y2tldCcsIHtcclxuICAgICAgYnVja2V0TmFtZTogYHN1cHBseXNlbnNlLXVpLSR7dGhpcy5hY2NvdW50fS0ke3RoaXMucmVnaW9ufWAsXHJcbiAgICAgIHdlYnNpdGVJbmRleERvY3VtZW50OiAnaW5kZXguaHRtbCcsXHJcbiAgICAgIHdlYnNpdGVFcnJvckRvY3VtZW50OiAnaW5kZXguaHRtbCcsIC8vIEZvciBTUEEgcm91dGluZ1xyXG4gICAgICBwdWJsaWNSZWFkQWNjZXNzOiB0cnVlLFxyXG4gICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUNMUyxcclxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcclxuICAgICAgYXV0b0RlbGV0ZU9iamVjdHM6IHRydWUsXHJcbiAgICB9KTtcclxuXHJcbiAgICAvLyBDbG91ZEZyb250IERpc3RyaWJ1dGlvbiBmb3IgVUkgYW5kIEFQSSBwcm94eVxyXG4gICAgY29uc3QgZGlzdHJpYnV0aW9uID0gbmV3IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uKHRoaXMsICdVSURpc3RyaWJ1dGlvbicsIHtcclxuICAgICAgZGVmYXVsdEJlaGF2aW9yOiB7XHJcbiAgICAgICAgb3JpZ2luOiBuZXcgb3JpZ2lucy5TM1N0YXRpY1dlYnNpdGVPcmlnaW4odWlCdWNrZXQpLFxyXG4gICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxyXG4gICAgICAgIGNhY2hlUG9saWN5OiBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfT1BUSU1JWkVELFxyXG4gICAgICB9LFxyXG4gICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzOiB7XHJcbiAgICAgICAgJy9hcGkvKic6IHtcclxuICAgICAgICAgIG9yaWdpbjogbmV3IG9yaWdpbnMuSHR0cE9yaWdpbihhbGIubG9hZEJhbGFuY2VyRG5zTmFtZSwge1xyXG4gICAgICAgICAgICBwcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5PcmlnaW5Qcm90b2NvbFBvbGljeS5IVFRQX09OTFksXHJcbiAgICAgICAgICB9KSxcclxuICAgICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxyXG4gICAgICAgICAgY2FjaGVQb2xpY3k6IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19ESVNBQkxFRCxcclxuICAgICAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6IGNsb3VkZnJvbnQuT3JpZ2luUmVxdWVzdFBvbGljeS5DT1JTX1MzX09SSUdJTixcclxuICAgICAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0FMTCxcclxuICAgICAgICB9LFxyXG4gICAgICB9LFxyXG4gICAgICBkZWZhdWx0Um9vdE9iamVjdDogJ2luZGV4Lmh0bWwnLFxyXG4gICAgICBlcnJvclJlc3BvbnNlczogW1xyXG4gICAgICAgIHtcclxuICAgICAgICAgIGh0dHBTdGF0dXM6IDQwNCxcclxuICAgICAgICAgIHJlc3BvbnNlSHR0cFN0YXR1czogMjAwLFxyXG4gICAgICAgICAgcmVzcG9uc2VQYWdlUGF0aDogJy9pbmRleC5odG1sJywgLy8gRm9yIFNQQSByb3V0aW5nXHJcbiAgICAgICAgfSxcclxuICAgICAgXSxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIENyZWF0ZSBhIGZ1bGwgY2hhdCBpbnRlcmZhY2Ugd2l0aCBhdXRoZW50aWNhdGlvblxyXG4gICAgY29uc3QgaHRtbENvbnRlbnQgPSBgPCFET0NUWVBFIGh0bWw+XHJcbjxodG1sIGxhbmc9XCJlblwiPlxyXG48aGVhZD5cclxuICAgIDxtZXRhIGNoYXJzZXQ9XCJVVEYtOFwiPlxyXG4gICAgPG1ldGEgbmFtZT1cInZpZXdwb3J0XCIgY29udGVudD1cIndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjBcIj5cclxuICAgIDx0aXRsZT5TdXBwbHlTZW5zZSAtIEFJIFN1cHBseSBDaGFpbiBJbnRlbGxpZ2VuY2U8L3RpdGxlPlxyXG4gICAgPHNjcmlwdCBzcmM9XCJodHRwczovL3VucGtnLmNvbS9yZWFjdEAxOC91bWQvcmVhY3QucHJvZHVjdGlvbi5taW4uanNcIj48L3NjcmlwdD5cclxuICAgIDxzY3JpcHQgc3JjPVwiaHR0cHM6Ly91bnBrZy5jb20vcmVhY3QtZG9tQDE4L3VtZC9yZWFjdC1kb20ucHJvZHVjdGlvbi5taW4uanNcIj48L3NjcmlwdD5cclxuICAgIDxzY3JpcHQgc3JjPVwiaHR0cHM6Ly91bnBrZy5jb20vQGJhYmVsL3N0YW5kYWxvbmUvYmFiZWwubWluLmpzXCI+PC9zY3JpcHQ+XHJcbiAgICA8c2NyaXB0IHNyYz1cImh0dHBzOi8vdW5wa2cuY29tL2FtYXpvbi1jb2duaXRvLWlkZW50aXR5LWpzQDYuMy4xMi9kaXN0L2FtYXpvbi1jb2duaXRvLWlkZW50aXR5Lm1pbi5qc1wiPjwvc2NyaXB0PlxyXG4gICAgPHNjcmlwdCBzcmM9XCJodHRwczovL2Nkbi50YWlsd2luZGNzcy5jb21cIj48L3NjcmlwdD5cclxuICAgIDxzdHlsZT5cclxuICAgICAgICBib2R5IHsgXHJcbiAgICAgICAgICAgIGJhY2tncm91bmQ6IGxpbmVhci1ncmFkaWVudCgxMzVkZWcsICMwZjE3MmEgMCUsICMxZTNhOGEgNTAlLCAjMGYxNzJhIDEwMCUpO1xyXG4gICAgICAgICAgICBtaW4taGVpZ2h0OiAxMDB2aDtcclxuICAgICAgICAgICAgbWFyZ2luOiAwO1xyXG4gICAgICAgICAgICBmb250LWZhbWlseTogLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCAnU2Vnb2UgVUknLCBSb2JvdG8sIHNhbnMtc2VyaWY7XHJcbiAgICAgICAgfVxyXG4gICAgPC9zdHlsZT5cclxuPC9oZWFkPlxyXG48Ym9keT5cclxuICAgIDxkaXYgaWQ9XCJyb290XCI+PC9kaXY+XHJcbiAgICA8c2NyaXB0IHR5cGU9XCJ0ZXh0L2JhYmVsXCI+XHJcbiAgICAgICAgY29uc3QgeyB1c2VTdGF0ZSwgdXNlRWZmZWN0IH0gPSBSZWFjdDtcclxuICAgICAgICBcclxuICAgICAgICBjb25zdCBjb25maWcgPSB7XHJcbiAgICAgICAgICAgIHVzZXJQb29sSWQ6ICcke3Byb3BzLmNvZ25pdG9Vc2VyUG9vbElkfScsXHJcbiAgICAgICAgICAgIHVzZXJQb29sQ2xpZW50SWQ6ICcke3Byb3BzLmNvZ25pdG9Vc2VyUG9vbENsaWVudElkfScsXHJcbiAgICAgICAgICAgIGFwaUVuZHBvaW50OiAnL2FwaScsXHJcbiAgICAgICAgICAgIHJlZ2lvbjogJyR7dGhpcy5yZWdpb259J1xyXG4gICAgICAgIH07XHJcbiAgICAgICAgXHJcbiAgICAgICAgLy8gSW5pdGlhbGl6ZSBDb2duaXRvXHJcbiAgICAgICAgY29uc3QgcG9vbERhdGEgPSB7XHJcbiAgICAgICAgICAgIFVzZXJQb29sSWQ6IGNvbmZpZy51c2VyUG9vbElkLFxyXG4gICAgICAgICAgICBDbGllbnRJZDogY29uZmlnLnVzZXJQb29sQ2xpZW50SWRcclxuICAgICAgICB9O1xyXG4gICAgICAgIGNvbnN0IHVzZXJQb29sID0gbmV3IEFtYXpvbkNvZ25pdG9JZGVudGl0eS5Db2duaXRvVXNlclBvb2wocG9vbERhdGEpO1xyXG4gICAgICAgIFxyXG4gICAgICAgIGZ1bmN0aW9uIExvZ2luRm9ybSh7IG9uTG9naW4gfSkge1xyXG4gICAgICAgICAgICBjb25zdCBbdXNlcm5hbWUsIHNldFVzZXJuYW1lXSA9IHVzZVN0YXRlKCd0ZXN0QHN1cHBseXNlbnNlLmNvbScpO1xyXG4gICAgICAgICAgICBjb25zdCBbcGFzc3dvcmQsIHNldFBhc3N3b3JkXSA9IHVzZVN0YXRlKCcnKTtcclxuICAgICAgICAgICAgY29uc3QgW25ld1Bhc3N3b3JkLCBzZXROZXdQYXNzd29yZF0gPSB1c2VTdGF0ZSgnJyk7XHJcbiAgICAgICAgICAgIGNvbnN0IFtpc0xvYWRpbmcsIHNldElzTG9hZGluZ10gPSB1c2VTdGF0ZShmYWxzZSk7XHJcbiAgICAgICAgICAgIGNvbnN0IFtuZWVkc05ld1Bhc3N3b3JkLCBzZXROZWVkc05ld1Bhc3N3b3JkXSA9IHVzZVN0YXRlKGZhbHNlKTtcclxuICAgICAgICAgICAgY29uc3QgW2Vycm9yLCBzZXRFcnJvcl0gPSB1c2VTdGF0ZSgnJyk7XHJcbiAgICAgICAgICAgIFxyXG4gICAgICAgICAgICBjb25zdCBoYW5kbGVMb2dpbiA9ICgpID0+IHtcclxuICAgICAgICAgICAgICAgIHNldElzTG9hZGluZyh0cnVlKTtcclxuICAgICAgICAgICAgICAgIHNldEVycm9yKCcnKTtcclxuICAgICAgICAgICAgICAgIFxyXG4gICAgICAgICAgICAgICAgY29uc3QgYXV0aGVudGljYXRpb25EYXRhID0ge1xyXG4gICAgICAgICAgICAgICAgICAgIFVzZXJuYW1lOiB1c2VybmFtZSxcclxuICAgICAgICAgICAgICAgICAgICBQYXNzd29yZDogcGFzc3dvcmQsXHJcbiAgICAgICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICAgICAgY29uc3QgYXV0aGVudGljYXRpb25EZXRhaWxzID0gbmV3IEFtYXpvbkNvZ25pdG9JZGVudGl0eS5BdXRoZW50aWNhdGlvbkRldGFpbHMoYXV0aGVudGljYXRpb25EYXRhKTtcclxuICAgICAgICAgICAgICAgIFxyXG4gICAgICAgICAgICAgICAgY29uc3QgdXNlckRhdGEgPSB7XHJcbiAgICAgICAgICAgICAgICAgICAgVXNlcm5hbWU6IHVzZXJuYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgIFBvb2w6IHVzZXJQb29sLFxyXG4gICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGNvZ25pdG9Vc2VyID0gbmV3IEFtYXpvbkNvZ25pdG9JZGVudGl0eS5Db2duaXRvVXNlcih1c2VyRGF0YSk7XHJcbiAgICAgICAgICAgICAgICBcclxuICAgICAgICAgICAgICAgIGNvZ25pdG9Vc2VyLmF1dGhlbnRpY2F0ZVVzZXIoYXV0aGVudGljYXRpb25EZXRhaWxzLCB7XHJcbiAgICAgICAgICAgICAgICAgICAgb25TdWNjZXNzOiAocmVzdWx0KSA9PiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHNldElzTG9hZGluZyhmYWxzZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG9uTG9naW4ocmVzdWx0LmdldElkVG9rZW4oKS5nZXRKd3RUb2tlbigpLCB1c2VybmFtZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgICAgICAgICBvbkZhaWx1cmU6IChlcnIpID0+IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgc2V0SXNMb2FkaW5nKGZhbHNlKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgc2V0RXJyb3IoZXJyLm1lc3NhZ2UpO1xyXG4gICAgICAgICAgICAgICAgICAgIH0sXHJcbiAgICAgICAgICAgICAgICAgICAgbmV3UGFzc3dvcmRSZXF1aXJlZDogKHVzZXJBdHRyaWJ1dGVzLCByZXF1aXJlZEF0dHJpYnV0ZXMpID0+IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgc2V0SXNMb2FkaW5nKGZhbHNlKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgc2V0TmVlZHNOZXdQYXNzd29yZCh0cnVlKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgd2luZG93LmNvZ25pdG9Vc2VyID0gY29nbml0b1VzZXI7IC8vIFN0b3JlIGZvciBwYXNzd29yZCBjaGFuZ2VcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgXHJcbiAgICAgICAgICAgIGNvbnN0IGhhbmRsZU5ld1Bhc3N3b3JkID0gKCkgPT4ge1xyXG4gICAgICAgICAgICAgICAgc2V0SXNMb2FkaW5nKHRydWUpO1xyXG4gICAgICAgICAgICAgICAgc2V0RXJyb3IoJycpO1xyXG4gICAgICAgICAgICAgICAgXHJcbiAgICAgICAgICAgICAgICB3aW5kb3cuY29nbml0b1VzZXIuY29tcGxldGVOZXdQYXNzd29yZENoYWxsZW5nZShuZXdQYXNzd29yZCwge30sIHtcclxuICAgICAgICAgICAgICAgICAgICBvblN1Y2Nlc3M6IChyZXN1bHQpID0+IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgc2V0SXNMb2FkaW5nKGZhbHNlKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgb25Mb2dpbihyZXN1bHQuZ2V0SWRUb2tlbigpLmdldEp3dFRva2VuKCksIHVzZXJuYW1lKTtcclxuICAgICAgICAgICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICAgICAgICAgIG9uRmFpbHVyZTogKGVycikgPT4ge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBzZXRJc0xvYWRpbmcoZmFsc2UpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBzZXRFcnJvcihlcnIubWVzc2FnZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgIFxyXG4gICAgICAgICAgICBpZiAobmVlZHNOZXdQYXNzd29yZCkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIChcclxuICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cInNwYWNlLXktNFwiPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICA8aDMgY2xhc3NOYW1lPVwidGV4dC14bCBmb250LXNlbWlib2xkIHRleHQtd2hpdGUgbWItNFwiPlNldCBOZXcgUGFzc3dvcmQ8L2gzPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICA8aW5wdXRcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU9XCJwYXNzd29yZFwiXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwbGFjZWhvbGRlcj1cIk5ldyBQYXNzd29yZFwiXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZT17bmV3UGFzc3dvcmR9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbkNoYW5nZT17KGUpID0+IHNldE5ld1Bhc3N3b3JkKGUudGFyZ2V0LnZhbHVlKX1cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cInctZnVsbCBwLTMgYmctd2hpdGUvMTAgYm9yZGVyIGJvcmRlci13aGl0ZS8yMCByb3VuZGVkLWxnIHRleHQtd2hpdGUgcGxhY2Vob2xkZXItYmx1ZS0yMDBcIlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAvPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICA8YnV0dG9uXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbkNsaWNrPXtoYW5kbGVOZXdQYXNzd29yZH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRpc2FibGVkPXtpc0xvYWRpbmcgfHwgIW5ld1Bhc3N3b3JkfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lPVwidy1mdWxsIGJnLWdyYWRpZW50LXRvLXIgZnJvbS1ibHVlLTUwMCB0by1wdXJwbGUtNjAwIHRleHQtd2hpdGUgcHktMyByb3VuZGVkLWxnIGhvdmVyOmZyb20tYmx1ZS02MDAgaG92ZXI6dG8tcHVycGxlLTcwMCBkaXNhYmxlZDpvcGFjaXR5LTUwXCJcclxuICAgICAgICAgICAgICAgICAgICAgICAgPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge2lzTG9hZGluZyA/ICdTZXR0aW5nIFBhc3N3b3JkLi4uJyA6ICdTZXQgUGFzc3dvcmQnfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICA8L2J1dHRvbj5cclxuICAgICAgICAgICAgICAgICAgICAgICAge2Vycm9yICYmIDxwIGNsYXNzTmFtZT1cInRleHQtcmVkLTMwMCB0ZXh0LXNtXCI+e2Vycm9yfTwvcD59XHJcbiAgICAgICAgICAgICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIFxyXG4gICAgICAgICAgICByZXR1cm4gKFxyXG4gICAgICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJzcGFjZS15LTRcIj5cclxuICAgICAgICAgICAgICAgICAgICA8aDMgY2xhc3NOYW1lPVwidGV4dC14bCBmb250LXNlbWlib2xkIHRleHQtd2hpdGUgbWItNFwiPkxvZ2luIHRvIFN1cHBseVNlbnNlPC9oMz5cclxuICAgICAgICAgICAgICAgICAgICA8aW5wdXRcclxuICAgICAgICAgICAgICAgICAgICAgICAgdHlwZT1cImVtYWlsXCJcclxuICAgICAgICAgICAgICAgICAgICAgICAgcGxhY2Vob2xkZXI9XCJFbWFpbFwiXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlPXt1c2VybmFtZX1cclxuICAgICAgICAgICAgICAgICAgICAgICAgb25DaGFuZ2U9eyhlKSA9PiBzZXRVc2VybmFtZShlLnRhcmdldC52YWx1ZSl9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cInctZnVsbCBwLTMgYmctd2hpdGUvMTAgYm9yZGVyIGJvcmRlci13aGl0ZS8yMCByb3VuZGVkLWxnIHRleHQtd2hpdGUgcGxhY2Vob2xkZXItYmx1ZS0yMDBcIlxyXG4gICAgICAgICAgICAgICAgICAgIC8+XHJcbiAgICAgICAgICAgICAgICAgICAgPGlucHV0XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU9XCJwYXNzd29yZFwiXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHBsYWNlaG9sZGVyPVwiUGFzc3dvcmRcIlxyXG4gICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZT17cGFzc3dvcmR9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG9uQ2hhbmdlPXsoZSkgPT4gc2V0UGFzc3dvcmQoZS50YXJnZXQudmFsdWUpfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICBvbktleVByZXNzPXsoZSkgPT4gZS5rZXkgPT09ICdFbnRlcicgJiYgaGFuZGxlTG9naW4oKX1cclxuICAgICAgICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lPVwidy1mdWxsIHAtMyBiZy13aGl0ZS8xMCBib3JkZXIgYm9yZGVyLXdoaXRlLzIwIHJvdW5kZWQtbGcgdGV4dC13aGl0ZSBwbGFjZWhvbGRlci1ibHVlLTIwMFwiXHJcbiAgICAgICAgICAgICAgICAgICAgLz5cclxuICAgICAgICAgICAgICAgICAgICA8YnV0dG9uXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG9uQ2xpY2s9e2hhbmRsZUxvZ2lufVxyXG4gICAgICAgICAgICAgICAgICAgICAgICBkaXNhYmxlZD17aXNMb2FkaW5nIHx8ICF1c2VybmFtZSB8fCAhcGFzc3dvcmR9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cInctZnVsbCBiZy1ncmFkaWVudC10by1yIGZyb20tYmx1ZS01MDAgdG8tcHVycGxlLTYwMCB0ZXh0LXdoaXRlIHB5LTMgcm91bmRlZC1sZyBob3Zlcjpmcm9tLWJsdWUtNjAwIGhvdmVyOnRvLXB1cnBsZS03MDAgZGlzYWJsZWQ6b3BhY2l0eS01MFwiXHJcbiAgICAgICAgICAgICAgICAgICAgPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICB7aXNMb2FkaW5nID8gJ1NpZ25pbmcgSW4uLi4nIDogJ1NpZ24gSW4nfVxyXG4gICAgICAgICAgICAgICAgICAgIDwvYnV0dG9uPlxyXG4gICAgICAgICAgICAgICAgICAgIHtlcnJvciAmJiA8cCBjbGFzc05hbWU9XCJ0ZXh0LXJlZC0zMDAgdGV4dC1zbVwiPntlcnJvcn08L3A+fVxyXG4gICAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwidGV4dC1jZW50ZXIgdGV4dC1ibHVlLTIwMCB0ZXh0LXNtXCI+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIDxwPlRlc3QgQWNjb3VudDogdGVzdEBzdXBwbHlzZW5zZS5jb208L3A+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIDxwPlVzZSB0ZW1wb3JhcnkgcGFzc3dvcmQ6IFRlbXBQYXNzMTIzITwvcD5cclxuICAgICAgICAgICAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgICApO1xyXG4gICAgICAgIH1cclxuICAgICAgICBcclxuICAgICAgICBmdW5jdGlvbiBDaGF0SW50ZXJmYWNlKHsgdG9rZW4sIHVzZXJuYW1lLCBvbkxvZ291dCB9KSB7XHJcbiAgICAgICAgICAgIGNvbnN0IFttZXNzYWdlcywgc2V0TWVzc2FnZXNdID0gdXNlU3RhdGUoW1xyXG4gICAgICAgICAgICAgICAge1xyXG4gICAgICAgICAgICAgICAgICAgIGlkOiAnMScsXHJcbiAgICAgICAgICAgICAgICAgICAgdHlwZTogJ2FnZW50JyxcclxuICAgICAgICAgICAgICAgICAgICBjb250ZW50OiAnSGVsbG8hIElcXFxcJ20geW91ciBTdXBwbHlTZW5zZSBBSSBhc3Npc3RhbnQuIEFzayBtZSBhYm91dCBpbnZlbnRvcnkgbGV2ZWxzLCBmdWxmaWxsbWVudCBjYXBhY2l0eSwgb3Igc3VwcGx5IGNoYWluIG9wdGltaXphdGlvbi4gRm9yIGV4YW1wbGU6IFwiQ2FuIEkgZnVsZmlsbCBhbGwgY3VzdG9tZXIgb3JkZXJzIHRoaXMgd2VlayBnaXZlbiBjdXJyZW50IGludmVudG9yeT9cIicsXHJcbiAgICAgICAgICAgICAgICAgICAgdGltZXN0YW1wOiBuZXcgRGF0ZSgpLFxyXG4gICAgICAgICAgICAgICAgICAgIGFnZW50VHlwZTogJ29yY2hlc3RyYXRvcidcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgXSk7XHJcbiAgICAgICAgICAgIGNvbnN0IFtpbnB1dE1lc3NhZ2UsIHNldElucHV0TWVzc2FnZV0gPSB1c2VTdGF0ZSgnJyk7XHJcbiAgICAgICAgICAgIGNvbnN0IFtpc0xvYWRpbmcsIHNldElzTG9hZGluZ10gPSB1c2VTdGF0ZShmYWxzZSk7XHJcbiAgICAgICAgICAgIFxyXG4gICAgICAgICAgICBjb25zdCBzZW5kTWVzc2FnZSA9IGFzeW5jICgpID0+IHtcclxuICAgICAgICAgICAgICAgIGlmICghaW5wdXRNZXNzYWdlLnRyaW0oKSkgcmV0dXJuO1xyXG4gICAgICAgICAgICAgICAgXHJcbiAgICAgICAgICAgICAgICBjb25zdCB1c2VyTWVzc2FnZSA9IHtcclxuICAgICAgICAgICAgICAgICAgICBpZDogRGF0ZS5ub3coKS50b1N0cmluZygpLFxyXG4gICAgICAgICAgICAgICAgICAgIHR5cGU6ICd1c2VyJyxcclxuICAgICAgICAgICAgICAgICAgICBjb250ZW50OiBpbnB1dE1lc3NhZ2UsXHJcbiAgICAgICAgICAgICAgICAgICAgdGltZXN0YW1wOiBuZXcgRGF0ZSgpLFxyXG4gICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgICAgIFxyXG4gICAgICAgICAgICAgICAgc2V0TWVzc2FnZXMocHJldiA9PiBbLi4ucHJldiwgdXNlck1lc3NhZ2VdKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGN1cnJlbnRRdWVyeSA9IGlucHV0TWVzc2FnZTtcclxuICAgICAgICAgICAgICAgIHNldElucHV0TWVzc2FnZSgnJyk7XHJcbiAgICAgICAgICAgICAgICBzZXRJc0xvYWRpbmcodHJ1ZSk7XHJcbiAgICAgICAgICAgICAgICBcclxuICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChjb25maWcuYXBpRW5kcG9pbnQgKyAnL2NoYXQnLCB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG1ldGhvZDogJ1BPU1QnLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBoZWFkZXJzOiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgJ0F1dGhvcml6YXRpb24nOiAnQmVhcmVyICcgKyB0b2tlbixcclxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcXVlcnk6IGN1cnJlbnRRdWVyeSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNlc3Npb25JZDogJ3Nlc3Npb24tJyArIHVzZXJuYW1lICsgJy0nICsgRGF0ZS5ub3coKSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgfSksXHJcbiAgICAgICAgICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgICAgICAgICAgXHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFyZXNwb25zZS5vaykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0ZhaWxlZCB0byBnZXQgcmVzcG9uc2UnKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgXHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgcmVhZGVyID0gcmVzcG9uc2UuYm9keS5nZXRSZWFkZXIoKTtcclxuICAgICAgICAgICAgICAgICAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XHJcbiAgICAgICAgICAgICAgICAgICAgbGV0IGJ1ZmZlciA9ICcnO1xyXG4gICAgICAgICAgICAgICAgICAgIGxldCBjdXJyZW50QWdlbnRNZXNzYWdlID0gbnVsbDtcclxuICAgICAgICAgICAgICAgICAgICBcclxuICAgICAgICAgICAgICAgICAgICB3aGlsZSAodHJ1ZSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZG9uZSkgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBidWZmZXIgKz0gZGVjb2Rlci5kZWNvZGUodmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBsaW5lcyA9IGJ1ZmZlci5zcGxpdCgnXFxcXG4nKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgYnVmZmVyID0gbGluZXMucG9wKCkgfHwgJyc7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoJ2RhdGE6ICcpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc3QgZGF0YSA9IEpTT04ucGFyc2UobGluZS5zbGljZSg2KSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZGF0YS50eXBlID09PSAnc3RhdHVzJykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY3VycmVudEFnZW50TWVzc2FnZSA9IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZDogRGF0ZS5ub3coKS50b1N0cmluZygpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6ICdhZ2VudCcsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29udGVudDogJ/CflIQgJyArIGRhdGEubWVzc2FnZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYWdlbnRUeXBlOiAnb3JjaGVzdHJhdG9yJyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZXRNZXNzYWdlcyhwcmV2ID0+IFsuLi5wcmV2LCBjdXJyZW50QWdlbnRNZXNzYWdlXSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZGF0YS50eXBlID09PSAnZmluYWxfcmVzcG9uc2UnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBmaW5hbE1lc3NhZ2UgPSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWQ6IERhdGUubm93KCkudG9TdHJpbmcoKSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiAnYWdlbnQnLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRlbnQ6IHR5cGVvZiBkYXRhLnJlc3BvbnNlID09PSAnc3RyaW5nJyA/IGRhdGEucmVzcG9uc2UgOiBKU09OLnN0cmluZ2lmeShkYXRhLnJlc3BvbnNlLCBudWxsLCAyKSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCksXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYWdlbnRUeXBlOiAnb3JjaGVzdHJhdG9yJyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZXRNZXNzYWdlcyhwcmV2ID0+IFsuLi5wcmV2LnNsaWNlKDAsIC0xKSwgZmluYWxNZXNzYWdlXSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZGF0YS50eXBlID09PSAnY29tcGxldGUnKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZXRJc0xvYWRpbmcoZmFsc2UpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIChlKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm9yIHBhcnNpbmcgU1NFIGRhdGE6JywgZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmVycm9yKCdFcnJvcjonLCBlcnJvcik7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZXJyb3JNZXNzYWdlID0ge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZDogRGF0ZS5ub3coKS50b1N0cmluZygpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB0eXBlOiAnYWdlbnQnLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb250ZW50OiAn4p2MIEVycm9yOiAnICsgZXJyb3IubWVzc2FnZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgdGltZXN0YW1wOiBuZXcgRGF0ZSgpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBhZ2VudFR5cGU6ICdvcmNoZXN0cmF0b3InLFxyXG4gICAgICAgICAgICAgICAgICAgIH07XHJcbiAgICAgICAgICAgICAgICAgICAgc2V0TWVzc2FnZXMocHJldiA9PiBbLi4ucHJldiwgZXJyb3JNZXNzYWdlXSk7XHJcbiAgICAgICAgICAgICAgICAgICAgc2V0SXNMb2FkaW5nKGZhbHNlKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgXHJcbiAgICAgICAgICAgIHJldHVybiAoXHJcbiAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cIm1pbi1oLXNjcmVlbiBmbGV4IGZsZXgtY29sXCI+XHJcbiAgICAgICAgICAgICAgICAgICAgey8qIEhlYWRlciAqL31cclxuICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cImJnLXdoaXRlLzEwIGJhY2tkcm9wLWJsdXItbWQgYm9yZGVyLWIgYm9yZGVyLXdoaXRlLzIwIHAtNFwiPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cImZsZXgganVzdGlmeS1iZXR3ZWVuIGl0ZW1zLWNlbnRlclwiPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJmbGV4IGl0ZW1zLWNlbnRlclwiPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwicC0yIGJnLWdyYWRpZW50LXRvLXIgZnJvbS1ibHVlLTUwMCB0by1wdXJwbGUtNjAwIHJvdW5kZWQtbGcgbXItM1wiPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8c3ZnIGNsYXNzTmFtZT1cInctNiBoLTYgdGV4dC13aGl0ZVwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCI+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8cGF0aCBkPVwiTTMgNGExIDEgMCAwMTEtMWgxMmExIDEgMCAwMTEgMXYyYTEgMSAwIDAxLTEgMUg0YTEgMSAwIDAxLTEtMVY0ek0zIDEwYTEgMSAwIDAxMS0xaDZhMSAxIDAgMDExIDF2NmExIDEgMCAwMS0xIDFINGExIDEgMCAwMS0xLTF2LTZ6TTE0IDlhMSAxIDAgMDAtMSAxdjZhMSAxIDAgMDAxIDFoMmExIDEgMCAwMDEtMXYtNmExIDEgMCAwMC0xLTFoLTJ6XCIvPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L3N2Zz5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2PlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8aDEgY2xhc3NOYW1lPVwidGV4dC14bCBmb250LWJvbGQgdGV4dC13aGl0ZVwiPlN1cHBseVNlbnNlPC9oMT5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPHAgY2xhc3NOYW1lPVwidGV4dC1zbSB0ZXh0LWJsdWUtMjAwXCI+V2VsY29tZSwge3VzZXJuYW1lfTwvcD5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPGJ1dHRvblxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uQ2xpY2s9e29uTG9nb3V0fVxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZT1cImJnLXJlZC01MDAvMjAgaG92ZXI6YmctcmVkLTUwMC8zMCB0ZXh0LXJlZC0zMDAgcHgtNCBweS0yIHJvdW5kZWQtbGdcIlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIExvZ291dFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9idXR0b24+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgICAgICAgICAgIFxyXG4gICAgICAgICAgICAgICAgICAgIHsvKiBDaGF0IE1lc3NhZ2VzICovfVxyXG4gICAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwiZmxleC0xIG92ZXJmbG93LXktYXV0byBwLTYgc3BhY2UteS00XCI+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHttZXNzYWdlcy5tYXAoKG1lc3NhZ2UpID0+IChcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYga2V5PXttZXNzYWdlLmlkfSBjbGFzc05hbWU9e1xcYGZsZXggXFwke21lc3NhZ2UudHlwZSA9PT0gJ3VzZXInID8gJ2p1c3RpZnktZW5kJyA6ICdqdXN0aWZ5LXN0YXJ0J31cXGB9PlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPXtcXGBtYXgtdy0yeGwgcHgtNCBweS0zIHJvdW5kZWQteGwgXFwke1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBtZXNzYWdlLnR5cGUgPT09ICd1c2VyJyBcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgID8gJ2JnLWdyYWRpZW50LXRvLXIgZnJvbS1ibHVlLTUwMCB0by1wdXJwbGUtNjAwIHRleHQtd2hpdGUnIFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgOiAnYmctd2hpdGUvMTAgYmFja2Ryb3AtYmx1ci1zbSB0ZXh0LXdoaXRlIGJvcmRlciBib3JkZXItd2hpdGUvMjAnXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxcYH0+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHttZXNzYWdlLnR5cGUgPT09ICdhZ2VudCcgJiYgbWVzc2FnZS5hZ2VudFR5cGUgJiYgKFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJ0ZXh0LXhzIHRleHQtYmx1ZS0yMDAgbWItMiBmb250LW1lZGl1bVwiPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIPCflIQgT3JjaGVzdHJhdG9yIEFnZW50XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKX1cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJ3aGl0ZXNwYWNlLXByZS1saW5lIHRleHQtc20gbGVhZGluZy1yZWxheGVkXCI+e21lc3NhZ2UuY29udGVudH08L2Rpdj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgICAgICAgICAgICAgICApKX1cclxuICAgICAgICAgICAgICAgICAgICAgICAgXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHtpc0xvYWRpbmcgJiYgKFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJmbGV4IGp1c3RpZnktc3RhcnRcIj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cImJnLXdoaXRlLzEwIGJhY2tkcm9wLWJsdXItc20gdGV4dC13aGl0ZSBweC00IHB5LTMgcm91bmRlZC14bCBib3JkZXIgYm9yZGVyLXdoaXRlLzIwXCI+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwiZmxleCBpdGVtcy1jZW50ZXIgc3BhY2UteC0zXCI+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cImFuaW1hdGUtc3BpbiByb3VuZGVkLWZ1bGwgaC01IHctNSBib3JkZXItMiBib3JkZXItYmx1ZS00MDAgYm9yZGVyLXQtdHJhbnNwYXJlbnRcIj48L2Rpdj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxzcGFuIGNsYXNzTmFtZT1cInRleHQtc21cIj5BSSBhZ2VudHMgYW5hbHl6aW5nLi4uPC9zcGFuPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgICAgICAgICAgICAgICApfVxyXG4gICAgICAgICAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgICAgICAgICAgIFxyXG4gICAgICAgICAgICAgICAgICAgIHsvKiBJbnB1dCAqL31cclxuICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cInAtNiBib3JkZXItdCBib3JkZXItd2hpdGUvMjBcIj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgPGRpdiBjbGFzc05hbWU9XCJmbGV4IHNwYWNlLXgtM1wiPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPGlucHV0XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdHlwZT1cInRleHRcIlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlPXtpbnB1dE1lc3NhZ2V9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb25DaGFuZ2U9eyhlKSA9PiBzZXRJbnB1dE1lc3NhZ2UoZS50YXJnZXQudmFsdWUpfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uS2V5UHJlc3M9eyhlKSA9PiBlLmtleSA9PT0gJ0VudGVyJyAmJiBzZW5kTWVzc2FnZSgpfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBsYWNlaG9sZGVyPVwiQXNrIGFib3V0IGludmVudG9yeSwgb3JkZXJzLCBvciBzdXBwbHkgY2hhaW4gb3B0aW1pemF0aW9uLi4uXCJcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWU9XCJmbGV4LTEgYmctd2hpdGUvMTAgYmFja2Ryb3AtYmx1ci1zbSBib3JkZXIgYm9yZGVyLXdoaXRlLzIwIHJvdW5kZWQteGwgcHgtNCBweS0zIHRleHQtd2hpdGUgcGxhY2Vob2xkZXItYmx1ZS0yMDAgZm9jdXM6b3V0bGluZS1ub25lIGZvY3VzOnJpbmctMiBmb2N1czpyaW5nLWJsdWUtNDAwXCJcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8YnV0dG9uXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb25DbGljaz17c2VuZE1lc3NhZ2V9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZGlzYWJsZWQ9e2lzTG9hZGluZyB8fCAhaW5wdXRNZXNzYWdlLnRyaW0oKX1cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWU9XCJiZy1ncmFkaWVudC10by1yIGZyb20tYmx1ZS01MDAgdG8tcHVycGxlLTYwMCB0ZXh0LXdoaXRlIHB4LTYgcHktMyByb3VuZGVkLXhsIGhvdmVyOmZyb20tYmx1ZS02MDAgaG92ZXI6dG8tcHVycGxlLTcwMCBkaXNhYmxlZDpvcGFjaXR5LTUwXCJcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgID5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBTZW5kXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8L2J1dHRvbj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgICAgICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgICAgKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgXHJcbiAgICAgICAgZnVuY3Rpb24gQXBwKCkge1xyXG4gICAgICAgICAgICBjb25zdCBbdXNlciwgc2V0VXNlcl0gPSB1c2VTdGF0ZShudWxsKTtcclxuICAgICAgICAgICAgY29uc3QgW3Rva2VuLCBzZXRUb2tlbl0gPSB1c2VTdGF0ZShudWxsKTtcclxuICAgICAgICAgICAgXHJcbiAgICAgICAgICAgIGNvbnN0IGhhbmRsZUxvZ2luID0gKGp3dFRva2VuLCB1c2VybmFtZSkgPT4ge1xyXG4gICAgICAgICAgICAgICAgc2V0VG9rZW4oand0VG9rZW4pO1xyXG4gICAgICAgICAgICAgICAgc2V0VXNlcih7IHVzZXJuYW1lIH0pO1xyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICBcclxuICAgICAgICAgICAgY29uc3QgaGFuZGxlTG9nb3V0ID0gKCkgPT4ge1xyXG4gICAgICAgICAgICAgICAgc2V0VG9rZW4obnVsbCk7XHJcbiAgICAgICAgICAgICAgICBzZXRVc2VyKG51bGwpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgY29nbml0b1VzZXIgPSB1c2VyUG9vbC5nZXRDdXJyZW50VXNlcigpO1xyXG4gICAgICAgICAgICAgICAgaWYgKGNvZ25pdG9Vc2VyKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29nbml0b1VzZXIuc2lnbk91dCgpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9O1xyXG4gICAgICAgICAgICBcclxuICAgICAgICAgICAgaWYgKCF1c2VyKSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gKFxyXG4gICAgICAgICAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwibWluLWgtc2NyZWVuIGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHAtOFwiPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cImJnLXdoaXRlLzEwIGJhY2tkcm9wLWJsdXItbWQgcm91bmRlZC0yeGwgcC04IG1heC13LW1kIHctZnVsbCBib3JkZXIgYm9yZGVyLXdoaXRlLzIwXCI+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cInRleHQtY2VudGVyIG1iLTZcIj5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cImlubGluZS1mbGV4IHAtNCBiZy1ncmFkaWVudC10by1yIGZyb20tYmx1ZS01MDAgdG8tcHVycGxlLTYwMCByb3VuZGVkLTJ4bCBtYi00XCI+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDxzdmcgY2xhc3NOYW1lPVwidy0xMiBoLTEyIHRleHQtd2hpdGVcIiBmaWxsPVwiY3VycmVudENvbG9yXCIgdmlld0JveD1cIjAgMCAyMCAyMFwiPlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPHBhdGggZD1cIk0zIDRhMSAxIDAgMDExLTFoMTJhMSAxIDAgMDExIDF2MmExIDEgMCAwMS0xIDFINGExIDEgMCAwMS0xLTFWNHpNMyAxMGExIDEgMCAwMTEtMWg2YTEgMSAwIDAxMSAxdjZhMSAxIDAgMDEtMSAxSDRhMSAxIDAgMDEtMS0xdi02ek0xNCA5YTEgMSAwIDAwLTEgMXY2YTEgMSAwIDAwMSAxaDJhMSAxIDAgMDAxLTF2LTZhMSAxIDAgMDAtMS0xaC0yelwiLz5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9zdmc+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPGgxIGNsYXNzTmFtZT1cInRleHQtM3hsIGZvbnQtYm9sZCB0ZXh0LXdoaXRlIG1iLTJcIj5TdXBwbHlTZW5zZTwvaDE+XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPHAgY2xhc3NOYW1lPVwidGV4dC1sZyB0ZXh0LWJsdWUtMjAwXCI+QUkgU3VwcGx5IENoYWluIEludGVsbGlnZW5jZTwvcD5cclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPExvZ2luRm9ybSBvbkxvZ2luPXtoYW5kbGVMb2dpbn0gLz5cclxuICAgICAgICAgICAgICAgICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgICAgICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgICAgICAgICApO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIFxyXG4gICAgICAgICAgICByZXR1cm4gPENoYXRJbnRlcmZhY2UgdG9rZW49e3Rva2VufSB1c2VybmFtZT17dXNlci51c2VybmFtZX0gb25Mb2dvdXQ9e2hhbmRsZUxvZ291dH0gLz47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIFxyXG4gICAgICAgIFJlYWN0RE9NLnJlbmRlcig8QXBwIC8+LCBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncm9vdCcpKTtcclxuICAgIDwvc2NyaXB0PlxyXG48L2JvZHk+XHJcbjwvaHRtbD5gO1xyXG5cclxuICAgIC8vIERlcGxveSBzaW1wbGUgSFRNTCBmaWxlIHRvIFMzXHJcbiAgICBjb25zdCB1aUJ1aWxkID0gbmV3IHMzZGVwbG95LkJ1Y2tldERlcGxveW1lbnQodGhpcywgJ1VJRGVwbG95bWVudCcsIHtcclxuICAgICAgc291cmNlczogW1xyXG4gICAgICAgIHMzZGVwbG95LlNvdXJjZS5kYXRhKCdpbmRleC5odG1sJywgaHRtbENvbnRlbnQpXHJcbiAgICAgIF0sXHJcbiAgICAgIGRlc3RpbmF0aW9uQnVja2V0OiB1aUJ1Y2tldCxcclxuICAgICAgZGlzdHJpYnV0aW9uLFxyXG4gICAgICBkaXN0cmlidXRpb25QYXRoczogWycvKiddLFxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gTWFrZSBzdXJlIFVJIGRlcGxveW1lbnQgaGFwcGVucyBhZnRlciB0aGUgQUxCIGlzIHJlYWR5XHJcbiAgICB1aUJ1aWxkLm5vZGUuYWRkRGVwZW5kZW5jeShhbGIpO1xyXG5cclxuICAgIC8vIE91dHB1dHNcclxuICAgIG5ldyBDZm5PdXRwdXQodGhpcywgJ0NoYXRTZXJ2aWNlVXJsJywge1xyXG4gICAgICB2YWx1ZTogdGhpcy5jaGF0U2VydmljZVVybCxcclxuICAgICAgZGVzY3JpcHRpb246ICdTdXBwbHlTZW5zZSBDaGF0IE9yY2hlc3RyYXRpb24gU2VydmljZSBVUkwnXHJcbiAgICB9KTtcclxuICAgIG5ldyBDZm5PdXRwdXQodGhpcywgJ0NoYXRTZXJ2aWNlQUxCJywge1xyXG4gICAgICB2YWx1ZTogYWxiLmxvYWRCYWxhbmNlckRuc05hbWUsXHJcbiAgICAgIGRlc2NyaXB0aW9uOiAnQXBwbGljYXRpb24gTG9hZCBCYWxhbmNlciBETlMgTmFtZSdcclxuICAgIH0pO1xyXG4gICAgbmV3IENmbk91dHB1dCh0aGlzLCAnVUlVcmwnLCB7XHJcbiAgICAgIHZhbHVlOiBgaHR0cHM6Ly8ke2Rpc3RyaWJ1dGlvbi5kaXN0cmlidXRpb25Eb21haW5OYW1lfWAsXHJcbiAgICAgIGRlc2NyaXB0aW9uOiAnU3VwcGx5U2Vuc2UgVUkgVVJMJ1xyXG4gICAgfSk7XHJcbiAgICBuZXcgQ2ZuT3V0cHV0KHRoaXMsICdDaGF0QnVpbGRQcm9qZWN0Jywge1xyXG4gICAgICB2YWx1ZTogY2hhdEJ1aWxkUHJvamVjdC5wcm9qZWN0TmFtZSxcclxuICAgICAgZGVzY3JpcHRpb246ICdDb2RlQnVpbGQgcHJvamVjdCBmb3IgQ2hhdCBPcmNoZXN0cmF0aW9uIFNlcnZpY2UnXHJcbiAgICB9KTtcclxuICB9XHJcbn0iXX0=