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
exports.SupplySenseAgentCoreStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const cr = __importStar(require("aws-cdk-lib/custom-resources"));
const path = __importStar(require("path"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const ssm = __importStar(require("aws-cdk-lib/aws-ssm"));
const s3assets = __importStar(require("aws-cdk-lib/aws-s3-assets"));
const codebuild = __importStar(require("aws-cdk-lib/aws-codebuild"));
const ecr = __importStar(require("aws-cdk-lib/aws-ecr"));
const cognito = __importStar(require("aws-cdk-lib/aws-cognito"));
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
class SupplySenseAgentCoreStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        this.agentRuntimeIds = {};
        // Common IAM role for all SupplySense agents
        const agentRole = new iam.Role(this, 'SupplySenseAgentCoreRole', {
            assumedBy: new iam.CompositePrincipal(new iam.ServicePrincipal('bedrock.amazonaws.com'), new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com')),
        });
        // Grant Nova model permissions
        agentRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'bedrock:InvokeModel',
                'bedrock:InvokeModelWithResponseStream',
                'bedrock:Converse',
                'bedrock:ConverseStream'
            ],
            resources: [
                'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0',
                'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0',
                'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-micro-v1:0'
            ],
        }));
        agentRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'bedrock-agentcore:InvokeAgentRuntime',
                'bedrock-agentcore:GetAgentRuntime',
                'bedrock-agentcore:ListAgentRuntimes'
            ],
            resources: ['*'],
        }));
        // Grant SSM permissions to read runtime ARN parameters
        agentRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'ssm:GetParameter',
                'ssm:GetParameters'
            ],
            resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter/supplysense/agents/*/invoke-arn`
            ],
        }));
        // Grant DynamoDB permissions for supply chain data
        agentRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'dynamodb:GetItem',
                'dynamodb:Query',
                'dynamodb:Scan',
                'dynamodb:BatchGetItem',
                'dynamodb:DescribeTable',
                'dynamodb:ListTables'
            ],
            resources: [
                `arn:aws:dynamodb:${this.region}:${this.account}:table/supplysense-*`,
                `arn:aws:dynamodb:${this.region}:${this.account}:table/supplysense-*/index/*`
            ],
        }));
        // Grant CloudWatch logging permissions
        agentRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
                'logs:DescribeLogGroups',
                'logs:DescribeLogStreams'
            ],
            resources: ['*'],
        }));
        // Grant X-Ray tracing permissions
        agentRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'xray:PutTraceSegments',
                'xray:PutTelemetryRecords'
            ],
            resources: ['*'],
        }));
        // Create provisioner Lambda function for AgentCore resources
        const provisionerPath = path.join(__dirname, '../custom-resources/agentcore_provisioner');
        const createProvisionerLambda = (agentName, manifestFile) => {
            const repoRootFromProvisioner = path.resolve(provisionerPath, '../../../');
            const manifestPath = path.join(repoRootFromProvisioner, `agentcore/${manifestFile}`);
            return new lambda.Function(this, `${agentName}AgentCoreProvisionerFn`, {
                code: lambda.Code.fromAsset(provisionerPath, {
                    bundling: {
                        image: lambda.Runtime.PYTHON_3_12.bundlingImage,
                        volumes: [
                            {
                                hostPath: path.dirname(manifestPath),
                                containerPath: '/ext/agentcore',
                            },
                        ],
                        command: [
                            'bash', '-lc',
                            [
                                'python -m pip install -r /asset-input/requirements.txt -t /asset-output',
                                '&&',
                                'cp handler.py /asset-output/',
                                '&&',
                                `cp /ext/agentcore/${manifestFile} /asset-output/gateway.manifest.json`,
                            ].join(' '),
                        ],
                        // Prefer local bundling to avoid Docker requirement
                        local: {
                            tryBundle: (outputDir) => {
                                try {
                                    const reqFile = path.join(provisionerPath, 'requirements.txt');
                                    const hasReq = fs.existsSync(reqFile) && fs.readFileSync(reqFile, 'utf-8').trim().length > 0;
                                    if (hasReq) {
                                        (0, child_process_1.execSync)(`python -m pip install -r "${reqFile}" -t "${outputDir}"`, { stdio: 'inherit' });
                                    }
                                    fs.copyFileSync(path.join(provisionerPath, 'handler.py'), path.join(outputDir, 'handler.py'));
                                    fs.copyFileSync(manifestPath, path.join(outputDir, 'gateway.manifest.json'));
                                    return true;
                                }
                                catch (e) {
                                    console.warn('Local bundling failed, will fall back to Docker bundling.', e);
                                    return false;
                                }
                            },
                        },
                    },
                }),
                handler: 'handler.handler',
                runtime: lambda.Runtime.PYTHON_3_12,
                timeout: aws_cdk_lib_1.Duration.minutes(10),
            });
        };
        // Grant AgentCore permissions to provisioner functions
        const grantAgentCorePermissions = (fn) => {
            fn.addToRolePolicy(new iam.PolicyStatement({
                actions: [
                    'bedrock-agentcore:CreateGateway',
                    'bedrock-agentcore:GetGateway',
                    'bedrock-agentcore:UpdateGateway',
                    'bedrock-agentcore:ListGateways',
                    'bedrock-agentcore:CreateGatewayTarget',
                    'bedrock-agentcore:ListGatewayTargets',
                    'bedrock-agentcore:CreateAgentRuntime',
                    'bedrock-agentcore:UpdateAgentRuntime',
                    'bedrock-agentcore:ListAgentRuntimes',
                    'bedrock-agentcore:CreateApiKeyCredentialProvider',
                    'bedrock-agentcore:GetApiKeyCredentialProvider',
                    'bedrock-agentcore:ListApiKeyCredentialProviders',
                    'bedrock-agentcore:CreateWorkloadIdentity',
                    'bedrock-agentcore:GetWorkloadIdentity',
                    'bedrock-agentcore:ListWorkloadIdentities',
                    'bedrock-agentcore:GetWorkloadIdentityDirectory',
                    'bedrock-agentcore:GetTokenVault',
                    'bedrock-agentcore:CreateTokenVault',
                    'bedrock-agentcore:SetTokenVaultCMK',
                    'bedrock-agentcore:*'
                ],
                resources: ['*'],
            }));
            fn.addToRolePolicy(new iam.PolicyStatement({
                actions: [
                    'secretsmanager:CreateSecret',
                    'secretsmanager:PutSecretValue',
                    'secretsmanager:TagResource',
                    'secretsmanager:DescribeSecret',
                    'secretsmanager:GetSecretValue',
                    'secretsmanager:UpdateSecret',
                    'secretsmanager:DeleteSecret',
                ],
                resources: ['*'],
            }));
            fn.addToRolePolicy(new iam.PolicyStatement({
                actions: ['iam:PassRole'],
                resources: [agentRole.roleArn],
                conditions: {
                    StringEquals: { 'iam:PassedToService': ['bedrock.amazonaws.com', 'bedrock-agentcore.amazonaws.com'] },
                },
            }));
            fn.addToRolePolicy(new iam.PolicyStatement({
                actions: ['iam:CreateServiceLinkedRole'],
                resources: ['*'],
            }));
        };
        // Cognito setup for authentication
        const userPool = new cognito.UserPool(this, 'SupplySenseUserPool', {
            selfSignUpEnabled: false,
            signInAliases: { email: true },
        });
        const userPoolClient = new cognito.UserPoolClient(this, 'SupplySenseUserPoolClient', {
            userPool,
            generateSecret: false,
        });
        const domainPrefix = `supplysense-${this.account}-${this.region}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 63);
        const domain = userPool.addDomain('SupplySenseCognitoDomain', {
            cognitoDomain: { domainPrefix },
        });
        const discoveryUrl = `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}/.well-known/openid-configuration`;
        this.cognitoUserPoolId = userPool.userPoolId;
        this.cognitoUserPoolClientId = userPoolClient.userPoolClientId;
        this.cognitoDomain = domain.domainName + `.auth.${this.region}.amazoncognito.com`;
        // Define the 5 agents
        const agentConfigs = [
            {
                name: 'Inventory',
                model: 'amazon.nova-micro-v1:0',
                systemPrompt: 'You are an Inventory Intelligence Agent for SupplySense supply chain system. Monitor inventory levels, analyze stock availability, and provide reorder recommendations.',
                manifestFile: 'inventory-gateway.manifest.json',
                agentPath: 'inventory_agent'
            },
            {
                name: 'Demand',
                model: 'amazon.nova-lite-v1:0',
                systemPrompt: 'You are a Demand Forecasting Agent for SupplySense. Generate demand forecasts, identify patterns, and detect demand surges.',
                manifestFile: 'demand-gateway.manifest.json',
                agentPath: 'demand_agent'
            },
            {
                name: 'Orchestrator',
                model: 'amazon.nova-pro-v1:0',
                systemPrompt: 'You are the Supply Chain Orchestrator Agent for SupplySense. Coordinate multi-agent workflows, synthesize responses, and create comprehensive action plans.',
                manifestFile: 'orchestrator-gateway.manifest.json',
                agentPath: 'orchestrator_agent'
            },
            {
                name: 'Logistics',
                model: 'amazon.nova-lite-v1:0',
                systemPrompt: 'You are a Logistics Optimization Agent for SupplySense. Optimize routes, manage shipping, and coordinate delivery schedules.',
                manifestFile: 'logistics-gateway.manifest.json',
                agentPath: 'logistics_agent'
            },
            {
                name: 'Risk',
                model: 'amazon.nova-pro-v1:0',
                systemPrompt: 'You are a Risk Assessment Agent for SupplySense. Analyze supply chain risks, assess disruption impacts, and recommend mitigation strategies.',
                manifestFile: 'risk-gateway.manifest.json',
                agentPath: 'risk_agent'
            }
        ];
        // Create each agent with its own AgentCore resource
        agentConfigs.forEach((config, index) => {
            // Create ECR repository for this agent's runtime
            const runtimeRepo = new ecr.Repository(this, `${config.name}AgentRuntimeRepo`, {
                repositoryName: `supplysense-${config.agentPath.replace('_', '-')}-runtime-${this.account}-${this.region}`,
                imageScanOnPush: true,
            });
            agentRole.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }));
            agentRole.addToPolicy(new iam.PolicyStatement({
                actions: ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
                resources: [runtimeRepo.repositoryArn],
            }));
            // Package runtime source and build ARM64 image in CodeBuild
            const runtimeSrc = new s3assets.Asset(this, `${config.name}AgentRuntimeSrc`, {
                path: path.join(__dirname, `../../agents/${config.agentPath}`),
            });
            const buildProject = new codebuild.Project(this, `${config.name}AgentRuntimeBuild`, {
                environment: { buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5, privileged: true },
                environmentVariables: {
                    REPO_URI: { value: runtimeRepo.repositoryUri },
                    IMAGE_TAG: { value: runtimeSrc.assetHash },
                    SRC_BUCKET: { value: runtimeSrc.s3BucketName },
                    SRC_KEY: { value: runtimeSrc.s3ObjectKey },
                    AWS_REGION: { value: this.region },
                },
                buildSpec: codebuild.BuildSpec.fromObject({
                    version: '0.2',
                    phases: {
                        pre_build: {
                            commands: [
                                'echo Logging into ECR',
                                'aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $REPO_URI',
                                'docker buildx create --use --name xbuilder || true',
                                'aws s3 cp s3://$SRC_BUCKET/$SRC_KEY src.zip',
                                'mkdir -p src && unzip -q src.zip -d src && cd src',
                            ],
                        },
                        build: {
                            commands: [
                                'docker buildx build --platform linux/arm64 -t $REPO_URI:$IMAGE_TAG --push .',
                            ],
                        },
                    },
                }),
            });
            runtimeSrc.grantRead(buildProject);
            runtimeRepo.grantPullPush(buildProject);
            // Create provisioner Lambda for this agent
            const onEvent = createProvisionerLambda(config.name, config.manifestFile);
            grantAgentCorePermissions(onEvent);
            // Allow provisioner to start and poll CodeBuild
            onEvent.addToRolePolicy(new iam.PolicyStatement({
                actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
                resources: [buildProject.projectArn],
            }));
            const provider = new cr.Provider(this, `${config.name}AgentCoreProvider`, {
                onEventHandler: onEvent,
            });
            // Create AgentCore resource for this agent
            const resource = new aws_cdk_lib_1.CustomResource(this, `${config.name}AgentCoreResource`, {
                serviceToken: provider.serviceToken,
                properties: {
                    AgentName: `SupplySense${config.name}`,
                    SystemPrompt: config.systemPrompt,
                    InferenceModel: config.model,
                    AgentRoleArn: agentRole.roleArn,
                    ApiUrl: props.apiUrl,
                    EnableLogging: true,
                    LogLevel: 'DEBUG',
                    EnableTracing: true,
                    RuntimeBuildProject: buildProject.projectName,
                    RuntimeRepoUri: runtimeRepo.repositoryUri,
                    RuntimeImageTag: runtimeSrc.assetHash,
                    RuntimeSrcBucket: runtimeSrc.s3BucketName,
                    RuntimeSrcKey: runtimeSrc.s3ObjectKey,
                    AuthorizerType: 'CUSTOM_JWT',
                    JwtDiscoveryUrl: discoveryUrl,
                    JwtAllowedAudience: [userPoolClient.userPoolClientId],
                    ApiKeyValue: props.apiKeyValue || undefined,
                    ApiKeyProviderArn: aws_cdk_lib_1.Stack.of(this).node.tryGetContext('apiKeyProviderArn') || undefined,
                    OAuthProviderArn: aws_cdk_lib_1.Stack.of(this).node.tryGetContext('oauthProviderArn') || undefined,
                    Nonce: aws_cdk_lib_1.Stack.of(this).node.tryGetContext('agentCoreNonce') || `v2-entrypoints-${config.name.toLowerCase()}`,
                },
            });
            // Store agent runtime IDs
            this.agentRuntimeIds[config.name.toLowerCase()] = resource.getAttString('AgentRuntimeId');
            // Output agent details
            new aws_cdk_lib_1.CfnOutput(this, `${config.name}GatewayId`, {
                value: resource.getAttString('GatewayId')
            });
            new aws_cdk_lib_1.CfnOutput(this, `${config.name}AgentAlias`, {
                value: resource.getAttString('AgentAlias')
            });
            new aws_cdk_lib_1.CfnOutput(this, `${config.name}AgentRuntimeId`, {
                value: resource.getAttString('AgentRuntimeId')
            });
            // Store in SSM for chat orchestration service
            const ns = `/supplysense/agents/${config.name.toLowerCase()}`;
            new ssm.StringParameter(this, `${config.name}AgentIdParam`, {
                parameterName: `${ns}/id`,
                stringValue: resource.getAttString('GatewayId'),
            });
            new ssm.StringParameter(this, `${config.name}AgentAliasParam`, {
                parameterName: `${ns}/alias`,
                stringValue: resource.getAttString('AgentAlias'),
            });
            new ssm.StringParameter(this, `${config.name}AgentInvokeArnParam`, {
                parameterName: `${ns}/invoke-arn`,
                stringValue: resource.getAttString('RuntimeEndpointArn'),
            });
            new ssm.StringParameter(this, `${config.name}AgentRuntimeIdParam`, {
                parameterName: `${ns}/runtime-id`,
                stringValue: resource.getAttString('AgentRuntimeId'),
            });
        });
        // Outputs
        new aws_cdk_lib_1.CfnOutput(this, 'CognitoUserPoolId', { value: this.cognitoUserPoolId });
        new aws_cdk_lib_1.CfnOutput(this, 'CognitoUserPoolClientId', { value: this.cognitoUserPoolClientId });
        new aws_cdk_lib_1.CfnOutput(this, 'CognitoDomain', { value: this.cognitoDomain });
        new aws_cdk_lib_1.CfnOutput(this, 'AgentRoleArn', { value: agentRole.roleArn });
    }
}
exports.SupplySenseAgentCoreStack = SupplySenseAgentCoreStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3VwcGx5c2Vuc2UtYWdlbnRjb3JlLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsic3VwcGx5c2Vuc2UtYWdlbnRjb3JlLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUFxRjtBQUVyRix5REFBMkM7QUFDM0MsaUVBQW1EO0FBQ25ELDJDQUE2QjtBQUM3QiwrREFBaUQ7QUFDakQseURBQTJDO0FBQzNDLG9FQUFzRDtBQUN0RCxxRUFBdUQ7QUFDdkQseURBQTJDO0FBQzNDLGlFQUFtRDtBQUNuRCx1Q0FBeUI7QUFDekIsaURBQXlDO0FBT3pDLE1BQWEseUJBQTBCLFNBQVEsbUJBQUs7SUFNaEQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFnQztRQUN0RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUhaLG9CQUFlLEdBQThCLEVBQUUsQ0FBQztRQUs1RCw2Q0FBNkM7UUFDN0MsTUFBTSxTQUFTLEdBQUcsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSwwQkFBMEIsRUFBRTtZQUM3RCxTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsa0JBQWtCLENBQ2pDLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLHVCQUF1QixDQUFDLEVBQ2pELElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLGlDQUFpQyxDQUFDLENBQzlEO1NBQ0osQ0FBQyxDQUFDO1FBRUgsK0JBQStCO1FBQy9CLFNBQVMsQ0FBQyxXQUFXLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQzFDLE9BQU8sRUFBRTtnQkFDTCxxQkFBcUI7Z0JBQ3JCLHVDQUF1QztnQkFDdkMsa0JBQWtCO2dCQUNsQix3QkFBd0I7YUFDM0I7WUFDRCxTQUFTLEVBQUU7Z0JBQ1Asa0VBQWtFO2dCQUNsRSxtRUFBbUU7Z0JBQ25FLG9FQUFvRTth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QUFFLEtBQUssRUFBRSxJQUFJLENBQUMsYUFBYSxFQUFFLENBQUMsQ0FBQztRQUNwRSxJQUFJLHVCQUFTLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRSxFQUFFLEtBQUssRUFBRSxTQUFTLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQztJQUN0RSxDQUFDO0NBQ0o7QUF0WUQsOERBc1lDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgU3RhY2ssIFN0YWNrUHJvcHMsIENmbk91dHB1dCwgRHVyYXRpb24sIEN1c3RvbVJlc291cmNlIH0gZnJvbSAnYXdzLWNkay1saWInO1xyXG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcclxuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xyXG5pbXBvcnQgKiBhcyBjciBmcm9tICdhd3MtY2RrLWxpYi9jdXN0b20tcmVzb3VyY2VzJztcclxuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcclxuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xyXG5pbXBvcnQgKiBhcyBzc20gZnJvbSAnYXdzLWNkay1saWIvYXdzLXNzbSc7XHJcbmltcG9ydCAqIGFzIHMzYXNzZXRzIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zMy1hc3NldHMnO1xyXG5pbXBvcnQgKiBhcyBjb2RlYnVpbGQgZnJvbSAnYXdzLWNkay1saWIvYXdzLWNvZGVidWlsZCc7XHJcbmltcG9ydCAqIGFzIGVjciBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNyJztcclxuaW1wb3J0ICogYXMgY29nbml0byBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY29nbml0byc7XHJcbmltcG9ydCAqIGFzIGZzIGZyb20gJ2ZzJztcclxuaW1wb3J0IHsgZXhlY1N5bmMgfSBmcm9tICdjaGlsZF9wcm9jZXNzJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgU3VwcGx5U2Vuc2VBZ2VudENvcmVQcm9wcyBleHRlbmRzIFN0YWNrUHJvcHMge1xyXG4gICAgYXBpVXJsOiBzdHJpbmc7XHJcbiAgICBhcGlLZXlWYWx1ZT86IHN0cmluZztcclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIFN1cHBseVNlbnNlQWdlbnRDb3JlU3RhY2sgZXh0ZW5kcyBTdGFjayB7XHJcbiAgICBwdWJsaWMgcmVhZG9ubHkgY29nbml0b1VzZXJQb29sSWQ6IHN0cmluZztcclxuICAgIHB1YmxpYyByZWFkb25seSBjb2duaXRvVXNlclBvb2xDbGllbnRJZDogc3RyaW5nO1xyXG4gICAgcHVibGljIHJlYWRvbmx5IGNvZ25pdG9Eb21haW46IHN0cmluZztcclxuICAgIHB1YmxpYyByZWFkb25seSBhZ2VudFJ1bnRpbWVJZHM6IHsgW2tleTogc3RyaW5nXTogc3RyaW5nIH0gPSB7fTtcclxuXHJcbiAgICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogU3VwcGx5U2Vuc2VBZ2VudENvcmVQcm9wcykge1xyXG4gICAgICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xyXG5cclxuICAgICAgICAvLyBDb21tb24gSUFNIHJvbGUgZm9yIGFsbCBTdXBwbHlTZW5zZSBhZ2VudHNcclxuICAgICAgICBjb25zdCBhZ2VudFJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1N1cHBseVNlbnNlQWdlbnRDb3JlUm9sZScsIHtcclxuICAgICAgICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLkNvbXBvc2l0ZVByaW5jaXBhbChcclxuICAgICAgICAgICAgICAgIG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnYmVkcm9jay5hbWF6b25hd3MuY29tJyksXHJcbiAgICAgICAgICAgICAgICBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2JlZHJvY2stYWdlbnRjb3JlLmFtYXpvbmF3cy5jb20nKSxcclxuICAgICAgICAgICAgKSxcclxuICAgICAgICB9KTtcclxuXHJcbiAgICAgICAgLy8gR3JhbnQgTm92YSBtb2RlbCBwZXJtaXNzaW9uc1xyXG4gICAgICAgIGFnZW50Um9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgICAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAgICAgICAgICdiZWRyb2NrOkludm9rZU1vZGVsJyxcclxuICAgICAgICAgICAgICAgICdiZWRyb2NrOkludm9rZU1vZGVsV2l0aFJlc3BvbnNlU3RyZWFtJyxcclxuICAgICAgICAgICAgICAgICdiZWRyb2NrOkNvbnZlcnNlJyxcclxuICAgICAgICAgICAgICAgICdiZWRyb2NrOkNvbnZlcnNlU3RyZWFtJ1xyXG4gICAgICAgICAgICBdLFxyXG4gICAgICAgICAgICByZXNvdXJjZXM6IFtcclxuICAgICAgICAgICAgICAgICdhcm46YXdzOmJlZHJvY2s6dXMtZWFzdC0xOjpmb3VuZGF0aW9uLW1vZGVsL2FtYXpvbi5ub3ZhLXByby12MTowJywgICBcclxuICAgICAgICAgICAgICAgICdhcm46YXdzOmJlZHJvY2s6dXMtZWFzdC0xOjpmb3VuZGF0aW9uLW1vZGVsL2FtYXpvbi5ub3ZhLWxpdGUtdjE6MCcsICBcclxuICAgICAgICAgICAgICAgICdhcm46YXdzOmJlZHJvY2s6dXMtZWFzdC0xOjpmb3VuZGF0aW9uLW1vZGVsL2FtYXpvbi5ub3ZhLW1pY3JvLXYxOjAnICBcclxuICAgICAgICAgICAgXSxcclxuICAgICAgICB9KSk7XHJcblxyXG4gICAgICAgIGFnZW50Um9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgICAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAgICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpJbnZva2VBZ2VudFJ1bnRpbWUnLFxyXG4gICAgICAgICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldEFnZW50UnVudGltZScsXHJcbiAgICAgICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6TGlzdEFnZW50UnVudGltZXMnXHJcbiAgICAgICAgICAgIF0sXHJcbiAgICAgICAgICAgIHJlc291cmNlczogWycqJ10sXHJcbiAgICAgICAgfSkpO1xyXG5cclxuICAgICAgICAvLyBHcmFudCBTU00gcGVybWlzc2lvbnMgdG8gcmVhZCBydW50aW1lIEFSTiBwYXJhbWV0ZXJzXHJcbiAgICAgICAgYWdlbnRSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICAgICAgICAgJ3NzbTpHZXRQYXJhbWV0ZXInLFxyXG4gICAgICAgICAgICAgICAgJ3NzbTpHZXRQYXJhbWV0ZXJzJ1xyXG4gICAgICAgICAgICBdLFxyXG4gICAgICAgICAgICByZXNvdXJjZXM6IFtcclxuICAgICAgICAgICAgICAgIGBhcm46YXdzOnNzbToke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06cGFyYW1ldGVyL3N1cHBseXNlbnNlL2FnZW50cy8qL2ludm9rZS1hcm5gXHJcbiAgICAgICAgICAgIF0sXHJcbiAgICAgICAgfSkpO1xyXG5cclxuICAgICAgICAvLyBHcmFudCBEeW5hbW9EQiBwZXJtaXNzaW9ucyBmb3Igc3VwcGx5IGNoYWluIGRhdGFcclxuICAgICAgICBhZ2VudFJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgICAgICAgICAnZHluYW1vZGI6R2V0SXRlbScsXHJcbiAgICAgICAgICAgICAgICAnZHluYW1vZGI6UXVlcnknLFxyXG4gICAgICAgICAgICAgICAgJ2R5bmFtb2RiOlNjYW4nLFxyXG4gICAgICAgICAgICAgICAgJ2R5bmFtb2RiOkJhdGNoR2V0SXRlbScsXHJcbiAgICAgICAgICAgICAgICAnZHluYW1vZGI6RGVzY3JpYmVUYWJsZScsXHJcbiAgICAgICAgICAgICAgICAnZHluYW1vZGI6TGlzdFRhYmxlcydcclxuICAgICAgICAgICAgXSxcclxuICAgICAgICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgICAgICAgICBgYXJuOmF3czpkeW5hbW9kYjoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06dGFibGUvc3VwcGx5c2Vuc2UtKmAsXHJcbiAgICAgICAgICAgICAgICBgYXJuOmF3czpkeW5hbW9kYjoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06dGFibGUvc3VwcGx5c2Vuc2UtKi9pbmRleC8qYFxyXG4gICAgICAgICAgICBdLFxyXG4gICAgICAgIH0pKTtcclxuXHJcbiAgICAgICAgLy8gR3JhbnQgQ2xvdWRXYXRjaCBsb2dnaW5nIHBlcm1pc3Npb25zXHJcbiAgICAgICAgYWdlbnRSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICAgICAgICAgJ2xvZ3M6Q3JlYXRlTG9nR3JvdXAnLFxyXG4gICAgICAgICAgICAgICAgJ2xvZ3M6Q3JlYXRlTG9nU3RyZWFtJyxcclxuICAgICAgICAgICAgICAgICdsb2dzOlB1dExvZ0V2ZW50cycsXHJcbiAgICAgICAgICAgICAgICAnbG9nczpEZXNjcmliZUxvZ0dyb3VwcycsXHJcbiAgICAgICAgICAgICAgICAnbG9nczpEZXNjcmliZUxvZ1N0cmVhbXMnXHJcbiAgICAgICAgICAgIF0sXHJcbiAgICAgICAgICAgIHJlc291cmNlczogWycqJ10sXHJcbiAgICAgICAgfSkpO1xyXG5cclxuICAgICAgICAvLyBHcmFudCBYLVJheSB0cmFjaW5nIHBlcm1pc3Npb25zXHJcbiAgICAgICAgYWdlbnRSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICAgICAgICAgJ3hyYXk6UHV0VHJhY2VTZWdtZW50cycsXHJcbiAgICAgICAgICAgICAgICAneHJheTpQdXRUZWxlbWV0cnlSZWNvcmRzJ1xyXG4gICAgICAgICAgICBdLFxyXG4gICAgICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxyXG4gICAgICAgIH0pKTtcclxuXHJcbiAgICAgICAgLy8gQ3JlYXRlIHByb3Zpc2lvbmVyIExhbWJkYSBmdW5jdGlvbiAoY29waWVkIGZyb20geW91ciB3b3JraW5nIFNwZW5kT3B0aW1vKVxyXG4gICAgICAgIGNvbnN0IHByb3Zpc2lvbmVyUGF0aCA9IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9jdXN0b20tcmVzb3VyY2VzL2FnZW50Y29yZV9wcm92aXNpb25lcicpO1xyXG5cclxuICAgICAgICBjb25zdCBjcmVhdGVQcm92aXNpb25lckxhbWJkYSA9IChhZ2VudE5hbWU6IHN0cmluZywgbWFuaWZlc3RGaWxlOiBzdHJpbmcpID0+IHtcclxuICAgICAgICAgICAgY29uc3QgcmVwb1Jvb3RGcm9tUHJvdmlzaW9uZXIgPSBwYXRoLnJlc29sdmUocHJvdmlzaW9uZXJQYXRoLCAnLi4vLi4vLi4vJyk7XHJcbiAgICAgICAgICAgIGNvbnN0IG1hbmlmZXN0UGF0aCA9IHBhdGguam9pbihyZXBvUm9vdEZyb21Qcm92aXNpb25lciwgYGFnZW50Y29yZS8ke21hbmlmZXN0RmlsZX1gKTtcclxuXHJcbiAgICAgICAgICAgIHJldHVybiBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIGAke2FnZW50TmFtZX1BZ2VudENvcmVQcm92aXNpb25lckZuYCwge1xyXG4gICAgICAgICAgICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHByb3Zpc2lvbmVyUGF0aCwge1xyXG4gICAgICAgICAgICAgICAgICAgIGJ1bmRsaW5nOiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGltYWdlOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMi5idW5kbGluZ0ltYWdlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB2b2x1bWVzOiBbXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaG9zdFBhdGg6IHBhdGguZGlybmFtZShtYW5pZmVzdFBhdGgpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRhaW5lclBhdGg6ICcvZXh0L2FnZW50Y29yZScsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBdLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb21tYW5kOiBbXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAnYmFzaCcsICctbGMnLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgW1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICdweXRob24gLW0gcGlwIGluc3RhbGwgLXIgL2Fzc2V0LWlucHV0L3JlcXVpcmVtZW50cy50eHQgLXQgL2Fzc2V0LW91dHB1dCcsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJyYmJyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAnY3AgaGFuZGxlci5weSAvYXNzZXQtb3V0cHV0LycsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJyYmJyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBgY3AgL2V4dC9hZ2VudGNvcmUvJHttYW5pZmVzdEZpbGV9IC9hc3NldC1vdXRwdXQvZ2F0ZXdheS5tYW5pZmVzdC5qc29uYCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIF0uam9pbignICcpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBdLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBQcmVmZXIgbG9jYWwgYnVuZGxpbmcgdG8gYXZvaWQgRG9ja2VyIHJlcXVpcmVtZW50XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGxvY2FsOiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0cnlCdW5kbGU6IChvdXRwdXREaXI6IHN0cmluZykgPT4ge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHJlcUZpbGUgPSBwYXRoLmpvaW4ocHJvdmlzaW9uZXJQYXRoLCAncmVxdWlyZW1lbnRzLnR4dCcpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBoYXNSZXEgPSBmcy5leGlzdHNTeW5jKHJlcUZpbGUpICYmIGZzLnJlYWRGaWxlU3luYyhyZXFGaWxlLCAndXRmLTgnKS50cmltKCkubGVuZ3RoID4gMDtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGhhc1JlcSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhlY1N5bmMoYHB5dGhvbiAtbSBwaXAgaW5zdGFsbCAtciBcIiR7cmVxRmlsZX1cIiAtdCBcIiR7b3V0cHV0RGlyfVwiYCwgeyBzdGRpbzogJ2luaGVyaXQnIH0pO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZzLmNvcHlGaWxlU3luYyhwYXRoLmpvaW4ocHJvdmlzaW9uZXJQYXRoLCAnaGFuZGxlci5weScpLCBwYXRoLmpvaW4ob3V0cHV0RGlyLCAnaGFuZGxlci5weScpKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZnMuY29weUZpbGVTeW5jKG1hbmlmZXN0UGF0aCwgcGF0aC5qb2luKG91dHB1dERpciwgJ2dhdGV3YXkubWFuaWZlc3QuanNvbicpKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLndhcm4oJ0xvY2FsIGJ1bmRsaW5nIGZhaWxlZCwgd2lsbCBmYWxsIGJhY2sgdG8gRG9ja2VyIGJ1bmRsaW5nLicsIGUpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICAgICAgfSksXHJcbiAgICAgICAgICAgICAgICBoYW5kbGVyOiAnaGFuZGxlci5oYW5kbGVyJyxcclxuICAgICAgICAgICAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzEyLFxyXG4gICAgICAgICAgICAgICAgdGltZW91dDogRHVyYXRpb24ubWludXRlcygxMCksXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH07XHJcblxyXG4gICAgICAgIC8vIEdyYW50IEFnZW50Q29yZSBwZXJtaXNzaW9ucyB0byBwcm92aXNpb25lciBmdW5jdGlvbnNcclxuICAgICAgICBjb25zdCBncmFudEFnZW50Q29yZVBlcm1pc3Npb25zID0gKGZuOiBsYW1iZGEuRnVuY3Rpb24pID0+IHtcclxuICAgICAgICAgICAgZm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgICAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAgICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6Q3JlYXRlR2F0ZXdheScsXHJcbiAgICAgICAgICAgICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldEdhdGV3YXknLFxyXG4gICAgICAgICAgICAgICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpVcGRhdGVHYXRld2F5JyxcclxuICAgICAgICAgICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6TGlzdEdhdGV3YXlzJyxcclxuICAgICAgICAgICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6Q3JlYXRlR2F0ZXdheVRhcmdldCcsXHJcbiAgICAgICAgICAgICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkxpc3RHYXRld2F5VGFyZ2V0cycsXHJcbiAgICAgICAgICAgICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkNyZWF0ZUFnZW50UnVudGltZScsXHJcbiAgICAgICAgICAgICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOlVwZGF0ZUFnZW50UnVudGltZScsXHJcbiAgICAgICAgICAgICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkxpc3RBZ2VudFJ1bnRpbWVzJyxcclxuICAgICAgICAgICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6Q3JlYXRlQXBpS2V5Q3JlZGVudGlhbFByb3ZpZGVyJyxcclxuICAgICAgICAgICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0QXBpS2V5Q3JlZGVudGlhbFByb3ZpZGVyJyxcclxuICAgICAgICAgICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6TGlzdEFwaUtleUNyZWRlbnRpYWxQcm92aWRlcnMnLFxyXG4gICAgICAgICAgICAgICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpDcmVhdGVXb3JrbG9hZElkZW50aXR5JyxcclxuICAgICAgICAgICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0V29ya2xvYWRJZGVudGl0eScsXHJcbiAgICAgICAgICAgICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkxpc3RXb3JrbG9hZElkZW50aXRpZXMnLFxyXG4gICAgICAgICAgICAgICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRXb3JrbG9hZElkZW50aXR5RGlyZWN0b3J5JyxcclxuICAgICAgICAgICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0VG9rZW5WYXVsdCcsXHJcbiAgICAgICAgICAgICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkNyZWF0ZVRva2VuVmF1bHQnLFxyXG4gICAgICAgICAgICAgICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpTZXRUb2tlblZhdWx0Q01LJyxcclxuICAgICAgICAgICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6KidcclxuICAgICAgICAgICAgICAgIF0sXHJcbiAgICAgICAgICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxyXG4gICAgICAgICAgICB9KSk7XHJcblxyXG4gICAgICAgICAgICBmbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICAgICAgICAgICAgICdzZWNyZXRzbWFuYWdlcjpDcmVhdGVTZWNyZXQnLFxyXG4gICAgICAgICAgICAgICAgICAgICdzZWNyZXRzbWFuYWdlcjpQdXRTZWNyZXRWYWx1ZScsXHJcbiAgICAgICAgICAgICAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOlRhZ1Jlc291cmNlJyxcclxuICAgICAgICAgICAgICAgICAgICAnc2VjcmV0c21hbmFnZXI6RGVzY3JpYmVTZWNyZXQnLFxyXG4gICAgICAgICAgICAgICAgICAgICdzZWNyZXRzbWFuYWdlcjpHZXRTZWNyZXRWYWx1ZScsXHJcbiAgICAgICAgICAgICAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOlVwZGF0ZVNlY3JldCcsXHJcbiAgICAgICAgICAgICAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkRlbGV0ZVNlY3JldCcsXHJcbiAgICAgICAgICAgICAgICBdLFxyXG4gICAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcclxuICAgICAgICAgICAgfSkpO1xyXG5cclxuICAgICAgICAgICAgZm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgICAgICAgIGFjdGlvbnM6IFsnaWFtOlBhc3NSb2xlJ10sXHJcbiAgICAgICAgICAgICAgICByZXNvdXJjZXM6IFthZ2VudFJvbGUucm9sZUFybl0sXHJcbiAgICAgICAgICAgICAgICBjb25kaXRpb25zOiB7XHJcbiAgICAgICAgICAgICAgICAgICAgU3RyaW5nRXF1YWxzOiB7ICdpYW06UGFzc2VkVG9TZXJ2aWNlJzogWydiZWRyb2NrLmFtYXpvbmF3cy5jb20nLCAnYmVkcm9jay1hZ2VudGNvcmUuYW1hem9uYXdzLmNvbSddIH0sXHJcbiAgICAgICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICB9KSk7XHJcblxyXG4gICAgICAgICAgICBmbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgICAgICAgYWN0aW9uczogWydpYW06Q3JlYXRlU2VydmljZUxpbmtlZFJvbGUnXSxcclxuICAgICAgICAgICAgICAgIHJlc291cmNlczogWycqJ10sXHJcbiAgICAgICAgICAgIH0pKTtcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICAvLyBDb2duaXRvIHNldHVwIGZvciBhdXRoZW50aWNhdGlvblxyXG4gICAgICAgIGNvbnN0IHVzZXJQb29sID0gbmV3IGNvZ25pdG8uVXNlclBvb2wodGhpcywgJ1N1cHBseVNlbnNlVXNlclBvb2wnLCB7XHJcbiAgICAgICAgICAgIHNlbGZTaWduVXBFbmFibGVkOiBmYWxzZSxcclxuICAgICAgICAgICAgc2lnbkluQWxpYXNlczogeyBlbWFpbDogdHJ1ZSB9LFxyXG4gICAgICAgIH0pO1xyXG5cclxuICAgICAgICBjb25zdCB1c2VyUG9vbENsaWVudCA9IG5ldyBjb2duaXRvLlVzZXJQb29sQ2xpZW50KHRoaXMsICdTdXBwbHlTZW5zZVVzZXJQb29sQ2xpZW50Jywge1xyXG4gICAgICAgICAgICB1c2VyUG9vbCxcclxuICAgICAgICAgICAgZ2VuZXJhdGVTZWNyZXQ6IGZhbHNlLFxyXG4gICAgICAgIH0pO1xyXG5cclxuICAgICAgICBjb25zdCBkb21haW5QcmVmaXggPSBgc3VwcGx5c2Vuc2UtJHt0aGlzLmFjY291bnR9LSR7dGhpcy5yZWdpb259YC50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1teYS16MC05LV0vZywgJycpLnNsaWNlKDAsIDYzKTtcclxuICAgICAgICBjb25zdCBkb21haW4gPSB1c2VyUG9vbC5hZGREb21haW4oJ1N1cHBseVNlbnNlQ29nbml0b0RvbWFpbicsIHtcclxuICAgICAgICAgICAgY29nbml0b0RvbWFpbjogeyBkb21haW5QcmVmaXggfSxcclxuICAgICAgICB9KTtcclxuXHJcbiAgICAgICAgY29uc3QgZGlzY292ZXJ5VXJsID0gYGh0dHBzOi8vY29nbml0by1pZHAuJHt0aGlzLnJlZ2lvbn0uYW1hem9uYXdzLmNvbS8ke3VzZXJQb29sLnVzZXJQb29sSWR9Ly53ZWxsLWtub3duL29wZW5pZC1jb25maWd1cmF0aW9uYDtcclxuICAgICAgICB0aGlzLmNvZ25pdG9Vc2VyUG9vbElkID0gdXNlclBvb2wudXNlclBvb2xJZDtcclxuICAgICAgICB0aGlzLmNvZ25pdG9Vc2VyUG9vbENsaWVudElkID0gdXNlclBvb2xDbGllbnQudXNlclBvb2xDbGllbnRJZDtcclxuICAgICAgICB0aGlzLmNvZ25pdG9Eb21haW4gPSBkb21haW4uZG9tYWluTmFtZSArIGAuYXV0aC4ke3RoaXMucmVnaW9ufS5hbWF6b25jb2duaXRvLmNvbWA7XHJcblxyXG4gICAgICAgIC8vIERlZmluZSB0aGUgNSBhZ2VudHNcclxuICAgICAgICBjb25zdCBhZ2VudENvbmZpZ3MgPSBbXHJcbiAgICAgICAgICAgIHtcclxuICAgICAgICAgICAgICAgIG5hbWU6ICdJbnZlbnRvcnknLFxyXG4gICAgICAgICAgICAgICAgbW9kZWw6ICdhbWF6b24ubm92YS1taWNyby12MTowJyxcclxuICAgICAgICAgICAgICAgIHN5c3RlbVByb21wdDogJ1lvdSBhcmUgYW4gSW52ZW50b3J5IEludGVsbGlnZW5jZSBBZ2VudCBmb3IgU3VwcGx5U2Vuc2Ugc3VwcGx5IGNoYWluIHN5c3RlbS4gTW9uaXRvciBpbnZlbnRvcnkgbGV2ZWxzLCBhbmFseXplIHN0b2NrIGF2YWlsYWJpbGl0eSwgYW5kIHByb3ZpZGUgcmVvcmRlciByZWNvbW1lbmRhdGlvbnMuJyxcclxuICAgICAgICAgICAgICAgIG1hbmlmZXN0RmlsZTogJ2ludmVudG9yeS1nYXRld2F5Lm1hbmlmZXN0Lmpzb24nLFxyXG4gICAgICAgICAgICAgICAgYWdlbnRQYXRoOiAnaW52ZW50b3J5X2FnZW50J1xyXG4gICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICB7XHJcbiAgICAgICAgICAgICAgICBuYW1lOiAnRGVtYW5kJyxcclxuICAgICAgICAgICAgICAgIG1vZGVsOiAnYW1hem9uLm5vdmEtbGl0ZS12MTowJyxcclxuICAgICAgICAgICAgICAgIHN5c3RlbVByb21wdDogJ1lvdSBhcmUgYSBEZW1hbmQgRm9yZWNhc3RpbmcgQWdlbnQgZm9yIFN1cHBseVNlbnNlLiBHZW5lcmF0ZSBkZW1hbmQgZm9yZWNhc3RzLCBpZGVudGlmeSBwYXR0ZXJucywgYW5kIGRldGVjdCBkZW1hbmQgc3VyZ2VzLicsXHJcbiAgICAgICAgICAgICAgICBtYW5pZmVzdEZpbGU6ICdkZW1hbmQtZ2F0ZXdheS5tYW5pZmVzdC5qc29uJyxcclxuICAgICAgICAgICAgICAgIGFnZW50UGF0aDogJ2RlbWFuZF9hZ2VudCdcclxuICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAge1xyXG4gICAgICAgICAgICAgICAgbmFtZTogJ09yY2hlc3RyYXRvcicsXHJcbiAgICAgICAgICAgICAgICBtb2RlbDogJ2FtYXpvbi5ub3ZhLXByby12MTowJyxcclxuICAgICAgICAgICAgICAgIHN5c3RlbVByb21wdDogJ1lvdSBhcmUgdGhlIFN1cHBseSBDaGFpbiBPcmNoZXN0cmF0b3IgQWdlbnQgZm9yIFN1cHBseVNlbnNlLiBDb29yZGluYXRlIG11bHRpLWFnZW50IHdvcmtmbG93cywgc3ludGhlc2l6ZSByZXNwb25zZXMsIGFuZCBjcmVhdGUgY29tcHJlaGVuc2l2ZSBhY3Rpb24gcGxhbnMuJyxcclxuICAgICAgICAgICAgICAgIG1hbmlmZXN0RmlsZTogJ29yY2hlc3RyYXRvci1nYXRld2F5Lm1hbmlmZXN0Lmpzb24nLFxyXG4gICAgICAgICAgICAgICAgYWdlbnRQYXRoOiAnb3JjaGVzdHJhdG9yX2FnZW50J1xyXG4gICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICB7XHJcbiAgICAgICAgICAgICAgICBuYW1lOiAnTG9naXN0aWNzJyxcclxuICAgICAgICAgICAgICAgIG1vZGVsOiAnYW1hem9uLm5vdmEtbGl0ZS12MTowJyxcclxuICAgICAgICAgICAgICAgIHN5c3RlbVByb21wdDogJ1lvdSBhcmUgYSBMb2dpc3RpY3MgT3B0aW1pemF0aW9uIEFnZW50IGZvciBTdXBwbHlTZW5zZS4gT3B0aW1pemUgcm91dGVzLCBtYW5hZ2Ugc2hpcHBpbmcsIGFuZCBjb29yZGluYXRlIGRlbGl2ZXJ5IHNjaGVkdWxlcy4nLFxyXG4gICAgICAgICAgICAgICAgbWFuaWZlc3RGaWxlOiAnbG9naXN0aWNzLWdhdGV3YXkubWFuaWZlc3QuanNvbicsXHJcbiAgICAgICAgICAgICAgICBhZ2VudFBhdGg6ICdsb2dpc3RpY3NfYWdlbnQnXHJcbiAgICAgICAgICAgIH0sXHJcbiAgICAgICAgICAgIHtcclxuICAgICAgICAgICAgICAgIG5hbWU6ICdSaXNrJyxcclxuICAgICAgICAgICAgICAgIG1vZGVsOiAnYW1hem9uLm5vdmEtcHJvLXYxOjAnLFxyXG4gICAgICAgICAgICAgICAgc3lzdGVtUHJvbXB0OiAnWW91IGFyZSBhIFJpc2sgQXNzZXNzbWVudCBBZ2VudCBmb3IgU3VwcGx5U2Vuc2UuIEFuYWx5emUgc3VwcGx5IGNoYWluIHJpc2tzLCBhc3Nlc3MgZGlzcnVwdGlvbiBpbXBhY3RzLCBhbmQgcmVjb21tZW5kIG1pdGlnYXRpb24gc3RyYXRlZ2llcy4nLFxyXG4gICAgICAgICAgICAgICAgbWFuaWZlc3RGaWxlOiAncmlzay1nYXRld2F5Lm1hbmlmZXN0Lmpzb24nLFxyXG4gICAgICAgICAgICAgICAgYWdlbnRQYXRoOiAncmlza19hZ2VudCdcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIF07XHJcblxyXG4gICAgICAgIC8vIENyZWF0ZSBlYWNoIGFnZW50IHdpdGggaXRzIG93biBBZ2VudENvcmUgcmVzb3VyY2VcclxuICAgICAgICBhZ2VudENvbmZpZ3MuZm9yRWFjaCgoY29uZmlnLCBpbmRleCkgPT4ge1xyXG4gICAgICAgICAgICAvLyBDcmVhdGUgRUNSIHJlcG9zaXRvcnkgZm9yIHRoaXMgYWdlbnQncyBydW50aW1lXHJcbiAgICAgICAgICAgIGNvbnN0IHJ1bnRpbWVSZXBvID0gbmV3IGVjci5SZXBvc2l0b3J5KHRoaXMsIGAke2NvbmZpZy5uYW1lfUFnZW50UnVudGltZVJlcG9gLCB7XHJcbiAgICAgICAgICAgICAgICByZXBvc2l0b3J5TmFtZTogYHN1cHBseXNlbnNlLSR7Y29uZmlnLmFnZW50UGF0aC5yZXBsYWNlKCdfJywgJy0nKX0tcnVudGltZS0ke3RoaXMuYWNjb3VudH0tJHt0aGlzLnJlZ2lvbn1gLFxyXG4gICAgICAgICAgICAgICAgaW1hZ2VTY2FuT25QdXNoOiB0cnVlLFxyXG4gICAgICAgICAgICB9KTtcclxuXHJcbiAgICAgICAgICAgIGFnZW50Um9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7IGFjdGlvbnM6IFsnZWNyOkdldEF1dGhvcml6YXRpb25Ub2tlbiddLCByZXNvdXJjZXM6IFsnKiddIH0pKTtcclxuICAgICAgICAgICAgYWdlbnRSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgICAgICAgIGFjdGlvbnM6IFsnZWNyOkJhdGNoQ2hlY2tMYXllckF2YWlsYWJpbGl0eScsICdlY3I6R2V0RG93bmxvYWRVcmxGb3JMYXllcicsICdlY3I6QmF0Y2hHZXRJbWFnZSddLFxyXG4gICAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbcnVudGltZVJlcG8ucmVwb3NpdG9yeUFybl0sXHJcbiAgICAgICAgICAgIH0pKTtcclxuXHJcbiAgICAgICAgICAgIC8vIFBhY2thZ2UgcnVudGltZSBzb3VyY2UgYW5kIGJ1aWxkIEFSTTY0IGltYWdlIGluIENvZGVCdWlsZFxyXG4gICAgICAgICAgICBjb25zdCBydW50aW1lU3JjID0gbmV3IHMzYXNzZXRzLkFzc2V0KHRoaXMsIGAke2NvbmZpZy5uYW1lfUFnZW50UnVudGltZVNyY2AsIHtcclxuICAgICAgICAgICAgICAgIHBhdGg6IHBhdGguam9pbihfX2Rpcm5hbWUsIGAuLi8uLi9hZ2VudHMvJHtjb25maWcuYWdlbnRQYXRofWApLFxyXG4gICAgICAgICAgICB9KTtcclxuXHJcbiAgICAgICAgICAgIGNvbnN0IGJ1aWxkUHJvamVjdCA9IG5ldyBjb2RlYnVpbGQuUHJvamVjdCh0aGlzLCBgJHtjb25maWcubmFtZX1BZ2VudFJ1bnRpbWVCdWlsZGAsIHtcclxuICAgICAgICAgICAgICAgIGVudmlyb25tZW50OiB7IGJ1aWxkSW1hZ2U6IGNvZGVidWlsZC5MaW51eEJ1aWxkSW1hZ2UuQU1BWk9OX0xJTlVYXzJfNSwgcHJpdmlsZWdlZDogdHJ1ZSB9LFxyXG4gICAgICAgICAgICAgICAgZW52aXJvbm1lbnRWYXJpYWJsZXM6IHtcclxuICAgICAgICAgICAgICAgICAgICBSRVBPX1VSSTogeyB2YWx1ZTogcnVudGltZVJlcG8ucmVwb3NpdG9yeVVyaSB9LFxyXG4gICAgICAgICAgICAgICAgICAgIElNQUdFX1RBRzogeyB2YWx1ZTogcnVudGltZVNyYy5hc3NldEhhc2ggfSxcclxuICAgICAgICAgICAgICAgICAgICBTUkNfQlVDS0VUOiB7IHZhbHVlOiBydW50aW1lU3JjLnMzQnVja2V0TmFtZSB9LFxyXG4gICAgICAgICAgICAgICAgICAgIFNSQ19LRVk6IHsgdmFsdWU6IHJ1bnRpbWVTcmMuczNPYmplY3RLZXkgfSxcclxuICAgICAgICAgICAgICAgICAgICBBV1NfUkVHSU9OOiB7IHZhbHVlOiB0aGlzLnJlZ2lvbiB9LFxyXG4gICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgICAgIGJ1aWxkU3BlYzogY29kZWJ1aWxkLkJ1aWxkU3BlYy5mcm9tT2JqZWN0KHtcclxuICAgICAgICAgICAgICAgICAgICB2ZXJzaW9uOiAnMC4yJyxcclxuICAgICAgICAgICAgICAgICAgICBwaGFzZXM6IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcHJlX2J1aWxkOiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21tYW5kczogW1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICdlY2hvIExvZ2dpbmcgaW50byBFQ1InLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICdhd3MgZWNyIGdldC1sb2dpbi1wYXNzd29yZCAtLXJlZ2lvbiAkQVdTX1JFR0lPTiB8IGRvY2tlciBsb2dpbiAtLXVzZXJuYW1lIEFXUyAtLXBhc3N3b3JkLXN0ZGluICRSRVBPX1VSSScsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ2RvY2tlciBidWlsZHggY3JlYXRlIC0tdXNlIC0tbmFtZSB4YnVpbGRlciB8fCB0cnVlJyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAnYXdzIHMzIGNwIHMzOi8vJFNSQ19CVUNLRVQvJFNSQ19LRVkgc3JjLnppcCcsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ21rZGlyIC1wIHNyYyAmJiB1bnppcCAtcSBzcmMuemlwIC1kIHNyYyAmJiBjZCBzcmMnLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgYnVpbGQ6IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbW1hbmRzOiBbXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ2RvY2tlciBidWlsZHggYnVpbGQgLS1wbGF0Zm9ybSBsaW51eC9hcm02NCAtdCAkUkVQT19VUkk6JElNQUdFX1RBRyAtLXB1c2ggLicsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBdLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICAgICAgICAgIH0sXHJcbiAgICAgICAgICAgICAgICB9KSxcclxuICAgICAgICAgICAgfSk7XHJcblxyXG4gICAgICAgICAgICBydW50aW1lU3JjLmdyYW50UmVhZChidWlsZFByb2plY3QpO1xyXG4gICAgICAgICAgICBydW50aW1lUmVwby5ncmFudFB1bGxQdXNoKGJ1aWxkUHJvamVjdCk7XHJcblxyXG4gICAgICAgICAgICAvLyBDcmVhdGUgcHJvdmlzaW9uZXIgTGFtYmRhIGZvciB0aGlzIGFnZW50XHJcbiAgICAgICAgICAgIGNvbnN0IG9uRXZlbnQgPSBjcmVhdGVQcm92aXNpb25lckxhbWJkYShjb25maWcubmFtZSwgY29uZmlnLm1hbmlmZXN0RmlsZSk7XHJcbiAgICAgICAgICAgIGdyYW50QWdlbnRDb3JlUGVybWlzc2lvbnMob25FdmVudCk7XHJcblxyXG4gICAgICAgICAgICAvLyBBbGxvdyBwcm92aXNpb25lciB0byBzdGFydCBhbmQgcG9sbCBDb2RlQnVpbGRcclxuICAgICAgICAgICAgb25FdmVudC5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgICAgICAgYWN0aW9uczogWydjb2RlYnVpbGQ6U3RhcnRCdWlsZCcsICdjb2RlYnVpbGQ6QmF0Y2hHZXRCdWlsZHMnXSxcclxuICAgICAgICAgICAgICAgIHJlc291cmNlczogW2J1aWxkUHJvamVjdC5wcm9qZWN0QXJuXSxcclxuICAgICAgICAgICAgfSkpO1xyXG5cclxuICAgICAgICAgICAgY29uc3QgcHJvdmlkZXIgPSBuZXcgY3IuUHJvdmlkZXIodGhpcywgYCR7Y29uZmlnLm5hbWV9QWdlbnRDb3JlUHJvdmlkZXJgLCB7XHJcbiAgICAgICAgICAgICAgICBvbkV2ZW50SGFuZGxlcjogb25FdmVudCxcclxuICAgICAgICAgICAgfSk7XHJcblxyXG4gICAgICAgICAgICAvLyBDcmVhdGUgQWdlbnRDb3JlIHJlc291cmNlIGZvciB0aGlzIGFnZW50XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc291cmNlID0gbmV3IEN1c3RvbVJlc291cmNlKHRoaXMsIGAke2NvbmZpZy5uYW1lfUFnZW50Q29yZVJlc291cmNlYCwge1xyXG4gICAgICAgICAgICAgICAgc2VydmljZVRva2VuOiBwcm92aWRlci5zZXJ2aWNlVG9rZW4sXHJcbiAgICAgICAgICAgICAgICBwcm9wZXJ0aWVzOiB7XHJcbiAgICAgICAgICAgICAgICAgICAgQWdlbnROYW1lOiBgU3VwcGx5U2Vuc2Uke2NvbmZpZy5uYW1lfWAsXHJcbiAgICAgICAgICAgICAgICAgICAgU3lzdGVtUHJvbXB0OiBjb25maWcuc3lzdGVtUHJvbXB0LFxyXG4gICAgICAgICAgICAgICAgICAgIEluZmVyZW5jZU1vZGVsOiBjb25maWcubW9kZWwsXHJcbiAgICAgICAgICAgICAgICAgICAgQWdlbnRSb2xlQXJuOiBhZ2VudFJvbGUucm9sZUFybixcclxuICAgICAgICAgICAgICAgICAgICBBcGlVcmw6IHByb3BzLmFwaVVybCxcclxuICAgICAgICAgICAgICAgICAgICBFbmFibGVMb2dnaW5nOiB0cnVlLFxyXG4gICAgICAgICAgICAgICAgICAgIExvZ0xldmVsOiAnREVCVUcnLFxyXG4gICAgICAgICAgICAgICAgICAgIEVuYWJsZVRyYWNpbmc6IHRydWUsXHJcbiAgICAgICAgICAgICAgICAgICAgUnVudGltZUJ1aWxkUHJvamVjdDogYnVpbGRQcm9qZWN0LnByb2plY3ROYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgIFJ1bnRpbWVSZXBvVXJpOiBydW50aW1lUmVwby5yZXBvc2l0b3J5VXJpLFxyXG4gICAgICAgICAgICAgICAgICAgIFJ1bnRpbWVJbWFnZVRhZzogcnVudGltZVNyYy5hc3NldEhhc2gsXHJcbiAgICAgICAgICAgICAgICAgICAgUnVudGltZVNyY0J1Y2tldDogcnVudGltZVNyYy5zM0J1Y2tldE5hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgUnVudGltZVNyY0tleTogcnVudGltZVNyYy5zM09iamVjdEtleSxcclxuICAgICAgICAgICAgICAgICAgICBBdXRob3JpemVyVHlwZTogJ0NVU1RPTV9KV1QnLFxyXG4gICAgICAgICAgICAgICAgICAgIEp3dERpc2NvdmVyeVVybDogZGlzY292ZXJ5VXJsLFxyXG4gICAgICAgICAgICAgICAgICAgIEp3dEFsbG93ZWRBdWRpZW5jZTogW3VzZXJQb29sQ2xpZW50LnVzZXJQb29sQ2xpZW50SWRdLFxyXG4gICAgICAgICAgICAgICAgICAgIEFwaUtleVZhbHVlOiBwcm9wcy5hcGlLZXlWYWx1ZSB8fCB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgICAgICAgICAgQXBpS2V5UHJvdmlkZXJBcm46IFN0YWNrLm9mKHRoaXMpLm5vZGUudHJ5R2V0Q29udGV4dCgnYXBpS2V5UHJvdmlkZXJBcm4nKSB8fCB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgICAgICAgICAgT0F1dGhQcm92aWRlckFybjogU3RhY2sub2YodGhpcykubm9kZS50cnlHZXRDb250ZXh0KCdvYXV0aFByb3ZpZGVyQXJuJykgfHwgdW5kZWZpbmVkLFxyXG4gICAgICAgICAgICAgICAgICAgIE5vbmNlOiBTdGFjay5vZih0aGlzKS5ub2RlLnRyeUdldENvbnRleHQoJ2FnZW50Q29yZU5vbmNlJykgfHwgYHYyLWVudHJ5cG9pbnRzLSR7Y29uZmlnLm5hbWUudG9Mb3dlckNhc2UoKX1gLFxyXG4gICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgfSk7XHJcblxyXG4gICAgICAgICAgICAvLyBTdG9yZSBhZ2VudCBydW50aW1lIElEc1xyXG4gICAgICAgICAgICB0aGlzLmFnZW50UnVudGltZUlkc1tjb25maWcubmFtZS50b0xvd2VyQ2FzZSgpXSA9IHJlc291cmNlLmdldEF0dFN0cmluZygnQWdlbnRSdW50aW1lSWQnKTtcclxuXHJcbiAgICAgICAgICAgIC8vIE91dHB1dCBhZ2VudCBkZXRhaWxzXHJcbiAgICAgICAgICAgIG5ldyBDZm5PdXRwdXQodGhpcywgYCR7Y29uZmlnLm5hbWV9R2F0ZXdheUlkYCwge1xyXG4gICAgICAgICAgICAgICAgdmFsdWU6IHJlc291cmNlLmdldEF0dFN0cmluZygnR2F0ZXdheUlkJylcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIG5ldyBDZm5PdXRwdXQodGhpcywgYCR7Y29uZmlnLm5hbWV9QWdlbnRBbGlhc2AsIHtcclxuICAgICAgICAgICAgICAgIHZhbHVlOiByZXNvdXJjZS5nZXRBdHRTdHJpbmcoJ0FnZW50QWxpYXMnKVxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgbmV3IENmbk91dHB1dCh0aGlzLCBgJHtjb25maWcubmFtZX1BZ2VudFJ1bnRpbWVJZGAsIHtcclxuICAgICAgICAgICAgICAgIHZhbHVlOiByZXNvdXJjZS5nZXRBdHRTdHJpbmcoJ0FnZW50UnVudGltZUlkJylcclxuICAgICAgICAgICAgfSk7XHJcblxyXG4gICAgICAgICAgICAvLyBTdG9yZSBpbiBTU00gZm9yIGNoYXQgb3JjaGVzdHJhdGlvbiBzZXJ2aWNlXHJcbiAgICAgICAgICAgIGNvbnN0IG5zID0gYC9zdXBwbHlzZW5zZS9hZ2VudHMvJHtjb25maWcubmFtZS50b0xvd2VyQ2FzZSgpfWA7XHJcbiAgICAgICAgICAgIG5ldyBzc20uU3RyaW5nUGFyYW1ldGVyKHRoaXMsIGAke2NvbmZpZy5uYW1lfUFnZW50SWRQYXJhbWAsIHtcclxuICAgICAgICAgICAgICAgIHBhcmFtZXRlck5hbWU6IGAke25zfS9pZGAsXHJcbiAgICAgICAgICAgICAgICBzdHJpbmdWYWx1ZTogcmVzb3VyY2UuZ2V0QXR0U3RyaW5nKCdHYXRld2F5SWQnKSxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIG5ldyBzc20uU3RyaW5nUGFyYW1ldGVyKHRoaXMsIGAke2NvbmZpZy5uYW1lfUFnZW50QWxpYXNQYXJhbWAsIHtcclxuICAgICAgICAgICAgICAgIHBhcmFtZXRlck5hbWU6IGAke25zfS9hbGlhc2AsXHJcbiAgICAgICAgICAgICAgICBzdHJpbmdWYWx1ZTogcmVzb3VyY2UuZ2V0QXR0U3RyaW5nKCdBZ2VudEFsaWFzJyksXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBuZXcgc3NtLlN0cmluZ1BhcmFtZXRlcih0aGlzLCBgJHtjb25maWcubmFtZX1BZ2VudEludm9rZUFyblBhcmFtYCwge1xyXG4gICAgICAgICAgICAgICAgcGFyYW1ldGVyTmFtZTogYCR7bnN9L2ludm9rZS1hcm5gLFxyXG4gICAgICAgICAgICAgICAgc3RyaW5nVmFsdWU6IHJlc291cmNlLmdldEF0dFN0cmluZygnUnVudGltZUVuZHBvaW50QXJuJyksXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBuZXcgc3NtLlN0cmluZ1BhcmFtZXRlcih0aGlzLCBgJHtjb25maWcubmFtZX1BZ2VudFJ1bnRpbWVJZFBhcmFtYCwge1xyXG4gICAgICAgICAgICAgICAgcGFyYW1ldGVyTmFtZTogYCR7bnN9L3J1bnRpbWUtaWRgLFxyXG4gICAgICAgICAgICAgICAgc3RyaW5nVmFsdWU6IHJlc291cmNlLmdldEF0dFN0cmluZygnQWdlbnRSdW50aW1lSWQnKSxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfSk7XHJcblxyXG4gICAgICAgIC8vIE91dHB1dHNcclxuICAgICAgICBuZXcgQ2ZuT3V0cHV0KHRoaXMsICdDb2duaXRvVXNlclBvb2xJZCcsIHsgdmFsdWU6IHRoaXMuY29nbml0b1VzZXJQb29sSWQgfSk7XHJcbiAgICAgICAgbmV3IENmbk91dHB1dCh0aGlzLCAnQ29nbml0b1VzZXJQb29sQ2xpZW50SWQnLCB7IHZhbHVlOiB0aGlzLmNvZ25pdG9Vc2VyUG9vbENsaWVudElkIH0pO1xyXG4gICAgICAgIG5ldyBDZm5PdXRwdXQodGhpcywgJ0NvZ25pdG9Eb21haW4nLCB7IHZhbHVlOiB0aGlzLmNvZ25pdG9Eb21haW4gfSk7XHJcbiAgICAgICAgbmV3IENmbk91dHB1dCh0aGlzLCAnQWdlbnRSb2xlQXJuJywgeyB2YWx1ZTogYWdlbnRSb2xlLnJvbGVBcm4gfSk7XHJcbiAgICB9XHJcbn0iXX0=