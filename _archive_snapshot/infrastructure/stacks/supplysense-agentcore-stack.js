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
        // Grant DynamoDB permissions for supply chain data
        agentRole.addToPolicy(new iam.PolicyStatement({
            actions: [
                'dynamodb:GetItem',
                'dynamodb:PutItem',
                'dynamodb:UpdateItem',
                'dynamodb:DeleteItem',
                'dynamodb:Query',
                'dynamodb:Scan',
                'dynamodb:BatchGetItem',
                'dynamodb:BatchWriteItem',
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
        // Create provisioner Lambda function (copied from your working SpendOptimo)
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3VwcGx5c2Vuc2UtYWdlbnRjb3JlLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsic3VwcGx5c2Vuc2UtYWdlbnRjb3JlLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUFxRjtBQUVyRix5REFBMkM7QUFDM0MsaUVBQW1EO0FBQ25ELDJDQUE2QjtBQUM3QiwrREFBaUQ7QUFDakQseURBQTJDO0FBQzNDLG9FQUFzRDtBQUN0RCxxRUFBdUQ7QUFDdkQseURBQTJDO0FBQzNDLGlFQUFtRDtBQUNuRCx1Q0FBeUI7QUFDekIsaURBQXlDO0FBT3pDLE1BQWEseUJBQTBCLFNBQVEsbUJBQUs7SUFNaEQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFnQztRQUN0RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUhaLG9CQUFlLEdBQThCLEVBQUUsQ0FBQztRQUs1RCw2Q0FBNkM7UUFDN0MsTUFBTSxTQUFTLEdBQUcsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSwwQkFBMEIsRUFBRTtZQUM3RCxTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsa0JBQWtCLENBQ2pDLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLHVCQUF1QixDQUFDLEVBQ2pELElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLGlDQUFpQyxDQUFDLENBQzlEO1NBQ0osQ0FBQyxDQUFDO1FBRUgsK0JBQStCO1FBQy9CLFNBQVMsQ0FBQyxXQUFXLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQzFDLE9BQU8sRUFBRTtnQkFDTCxxQkFBcUI7Z0JBQ3JCLHVDQUF1QztnQkFDdkMsa0JBQWtCO2dCQUNsQix3QkFBd0I7YUFDM0I7WUFDRCxTQUFTLEVBQUU7Z0JBQ1Asa0VBQWtFO2dCQUNsRSxtRUFBbUU7Z0JBQ25FLG9FQUFvRTth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QUFJLEdBQUcsQ0FBQyxlQUFlLENBQUMsSUFBSSxFQUFFLEdBQUcsTUFBTSxDQUFDLElBQUkscUJBQXFCLEVBQUU7Z0JBQy9ELGFBQWEsRUFBRSxHQUFHLEVBQUUsYUFBYTtnQkFDakMsV0FBVyxFQUFFLFFBQVEsQ0FBQyxZQUFZLENBQUMsb0JBQW9CLENBQUM7YUFDM0QsQ0FBQyxDQUFDO1lBQ0gsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDLElBQUksRUFBRSxHQUFHLE1BQU0sQ0FBQyxJQUFJLHFCQUFxQixFQUFFO2dCQUMvRCxhQUFhLEVBQUUsR0FBRyxFQUFFLGFBQWE7Z0JBQ2pDLFdBQVcsRUFBRSxRQUFRLENBQUMsWUFBWSxDQUFDLGdCQUFnQixDQUFDO2FBQ3ZELENBQUMsQ0FBQztRQUNQLENBQUMsQ0FBQyxDQUFDO1FBRUgsVUFBVTtRQUNWLElBQUksdUJBQVMsQ0FBQyxJQUFJLEVBQUUsbUJBQW1CLEVBQUUsRUFBRSxLQUFLLEVBQUUsSUFBSSxDQUFDLGlCQUFpQixFQUFFLENBQUMsQ0FBQztRQUM1RSxJQUFJLHVCQUFTLENBQUMsSUFBSSxFQUFFLHlCQUF5QixFQUFFLEVBQUUsS0FBSyxFQUFFLElBQUksQ0FBQyx1QkFBdUIsRUFBRSxDQUFDLENBQUM7UUFDeEYsSUFBSSx1QkFBUyxDQUFDLElBQUksRUFBRSxlQUFlLEVBQUUsRUFBRSxLQUFLLEVBQUUsSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDLENBQUM7UUFDcEUsSUFBSSx1QkFBUyxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUUsRUFBRSxLQUFLLEVBQUUsU0FBUyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUM7SUFDdEUsQ0FBQztDQUNKO0FBdFhELDhEQXNYQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFN0YWNrLCBTdGFja1Byb3BzLCBDZm5PdXRwdXQsIER1cmF0aW9uLCBDdXN0b21SZXNvdXJjZSB9IGZyb20gJ2F3cy1jZGstbGliJztcclxuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XHJcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcclxuaW1wb3J0ICogYXMgY3IgZnJvbSAnYXdzLWNkay1saWIvY3VzdG9tLXJlc291cmNlcyc7XHJcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XHJcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtbGFtYmRhJztcclxuaW1wb3J0ICogYXMgc3NtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zc20nO1xyXG5pbXBvcnQgKiBhcyBzM2Fzc2V0cyBmcm9tICdhd3MtY2RrLWxpYi9hd3MtczMtYXNzZXRzJztcclxuaW1wb3J0ICogYXMgY29kZWJ1aWxkIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jb2RlYnVpbGQnO1xyXG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XHJcbmltcG9ydCAqIGFzIGNvZ25pdG8gZnJvbSAnYXdzLWNkay1saWIvYXdzLWNvZ25pdG8nO1xyXG5pbXBvcnQgKiBhcyBmcyBmcm9tICdmcyc7XHJcbmltcG9ydCB7IGV4ZWNTeW5jIH0gZnJvbSAnY2hpbGRfcHJvY2Vzcyc7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIFN1cHBseVNlbnNlQWdlbnRDb3JlUHJvcHMgZXh0ZW5kcyBTdGFja1Byb3BzIHtcclxuICAgIGFwaVVybDogc3RyaW5nO1xyXG4gICAgYXBpS2V5VmFsdWU/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBTdXBwbHlTZW5zZUFnZW50Q29yZVN0YWNrIGV4dGVuZHMgU3RhY2sge1xyXG4gICAgcHVibGljIHJlYWRvbmx5IGNvZ25pdG9Vc2VyUG9vbElkOiBzdHJpbmc7XHJcbiAgICBwdWJsaWMgcmVhZG9ubHkgY29nbml0b1VzZXJQb29sQ2xpZW50SWQ6IHN0cmluZztcclxuICAgIHB1YmxpYyByZWFkb25seSBjb2duaXRvRG9tYWluOiBzdHJpbmc7XHJcbiAgICBwdWJsaWMgcmVhZG9ubHkgYWdlbnRSdW50aW1lSWRzOiB7IFtrZXk6IHN0cmluZ106IHN0cmluZyB9ID0ge307XHJcblxyXG4gICAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IFN1cHBseVNlbnNlQWdlbnRDb3JlUHJvcHMpIHtcclxuICAgICAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcclxuXHJcbiAgICAgICAgLy8gQ29tbW9uIElBTSByb2xlIGZvciBhbGwgU3VwcGx5U2Vuc2UgYWdlbnRzXHJcbiAgICAgICAgY29uc3QgYWdlbnRSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdTdXBwbHlTZW5zZUFnZW50Q29yZVJvbGUnLCB7XHJcbiAgICAgICAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5Db21wb3NpdGVQcmluY2lwYWwoXHJcbiAgICAgICAgICAgICAgICBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2JlZHJvY2suYW1hem9uYXdzLmNvbScpLFxyXG4gICAgICAgICAgICAgICAgbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdiZWRyb2NrLWFnZW50Y29yZS5hbWF6b25hd3MuY29tJyksXHJcbiAgICAgICAgICAgICksXHJcbiAgICAgICAgfSk7XHJcblxyXG4gICAgICAgIC8vIEdyYW50IE5vdmEgbW9kZWwgcGVybWlzc2lvbnNcclxuICAgICAgICBhZ2VudFJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgICAgICAgICAnYmVkcm9jazpJbnZva2VNb2RlbCcsXHJcbiAgICAgICAgICAgICAgICAnYmVkcm9jazpJbnZva2VNb2RlbFdpdGhSZXNwb25zZVN0cmVhbScsXHJcbiAgICAgICAgICAgICAgICAnYmVkcm9jazpDb252ZXJzZScsXHJcbiAgICAgICAgICAgICAgICAnYmVkcm9jazpDb252ZXJzZVN0cmVhbSdcclxuICAgICAgICAgICAgXSxcclxuICAgICAgICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgICAgICAgICAnYXJuOmF3czpiZWRyb2NrOnVzLWVhc3QtMTo6Zm91bmRhdGlvbi1tb2RlbC9hbWF6b24ubm92YS1wcm8tdjE6MCcsXHJcbiAgICAgICAgICAgICAgICAnYXJuOmF3czpiZWRyb2NrOnVzLWVhc3QtMTo6Zm91bmRhdGlvbi1tb2RlbC9hbWF6b24ubm92YS1saXRlLXYxOjAnLFxyXG4gICAgICAgICAgICAgICAgJ2Fybjphd3M6YmVkcm9jazp1cy1lYXN0LTE6OmZvdW5kYXRpb24tbW9kZWwvYW1hem9uLm5vdmEtbWljcm8tdjE6MCdcclxuICAgICAgICAgICAgXSxcclxuICAgICAgICB9KSk7XHJcblxyXG4gICAgICAgIC8vIEdyYW50IER5bmFtb0RCIHBlcm1pc3Npb25zIGZvciBzdXBwbHkgY2hhaW4gZGF0YVxyXG4gICAgICAgIGFnZW50Um9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgICAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAgICAgICAgICdkeW5hbW9kYjpHZXRJdGVtJyxcclxuICAgICAgICAgICAgICAgICdkeW5hbW9kYjpQdXRJdGVtJyxcclxuICAgICAgICAgICAgICAgICdkeW5hbW9kYjpVcGRhdGVJdGVtJyxcclxuICAgICAgICAgICAgICAgICdkeW5hbW9kYjpEZWxldGVJdGVtJyxcclxuICAgICAgICAgICAgICAgICdkeW5hbW9kYjpRdWVyeScsXHJcbiAgICAgICAgICAgICAgICAnZHluYW1vZGI6U2NhbicsXHJcbiAgICAgICAgICAgICAgICAnZHluYW1vZGI6QmF0Y2hHZXRJdGVtJyxcclxuICAgICAgICAgICAgICAgICdkeW5hbW9kYjpCYXRjaFdyaXRlSXRlbScsXHJcbiAgICAgICAgICAgICAgICAnZHluYW1vZGI6RGVzY3JpYmVUYWJsZScsXHJcbiAgICAgICAgICAgICAgICAnZHluYW1vZGI6TGlzdFRhYmxlcydcclxuICAgICAgICAgICAgXSxcclxuICAgICAgICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgICAgICAgICBgYXJuOmF3czpkeW5hbW9kYjoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06dGFibGUvc3VwcGx5c2Vuc2UtKmAsXHJcbiAgICAgICAgICAgICAgICBgYXJuOmF3czpkeW5hbW9kYjoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06dGFibGUvc3VwcGx5c2Vuc2UtKi9pbmRleC8qYFxyXG4gICAgICAgICAgICBdLFxyXG4gICAgICAgIH0pKTtcclxuXHJcbiAgICAgICAgLy8gR3JhbnQgQ2xvdWRXYXRjaCBsb2dnaW5nIHBlcm1pc3Npb25zXHJcbiAgICAgICAgYWdlbnRSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICAgICAgICAgJ2xvZ3M6Q3JlYXRlTG9nR3JvdXAnLFxyXG4gICAgICAgICAgICAgICAgJ2xvZ3M6Q3JlYXRlTG9nU3RyZWFtJyxcclxuICAgICAgICAgICAgICAgICdsb2dzOlB1dExvZ0V2ZW50cycsXHJcbiAgICAgICAgICAgICAgICAnbG9nczpEZXNjcmliZUxvZ0dyb3VwcycsXHJcbiAgICAgICAgICAgICAgICAnbG9nczpEZXNjcmliZUxvZ1N0cmVhbXMnXHJcbiAgICAgICAgICAgIF0sXHJcbiAgICAgICAgICAgIHJlc291cmNlczogWycqJ10sXHJcbiAgICAgICAgfSkpO1xyXG5cclxuICAgICAgICAvLyBHcmFudCBYLVJheSB0cmFjaW5nIHBlcm1pc3Npb25zXHJcbiAgICAgICAgYWdlbnRSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICAgICAgICAgJ3hyYXk6UHV0VHJhY2VTZWdtZW50cycsXHJcbiAgICAgICAgICAgICAgICAneHJheTpQdXRUZWxlbWV0cnlSZWNvcmRzJ1xyXG4gICAgICAgICAgICBdLFxyXG4gICAgICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxyXG4gICAgICAgIH0pKTtcclxuXHJcbiAgICAgICAgLy8gQ3JlYXRlIHByb3Zpc2lvbmVyIExhbWJkYSBmdW5jdGlvbiAoY29waWVkIGZyb20geW91ciB3b3JraW5nIFNwZW5kT3B0aW1vKVxyXG4gICAgICAgIGNvbnN0IHByb3Zpc2lvbmVyUGF0aCA9IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLi9jdXN0b20tcmVzb3VyY2VzL2FnZW50Y29yZV9wcm92aXNpb25lcicpO1xyXG5cclxuICAgICAgICBjb25zdCBjcmVhdGVQcm92aXNpb25lckxhbWJkYSA9IChhZ2VudE5hbWU6IHN0cmluZywgbWFuaWZlc3RGaWxlOiBzdHJpbmcpID0+IHtcclxuICAgICAgICAgICAgY29uc3QgcmVwb1Jvb3RGcm9tUHJvdmlzaW9uZXIgPSBwYXRoLnJlc29sdmUocHJvdmlzaW9uZXJQYXRoLCAnLi4vLi4vLi4vJyk7XHJcbiAgICAgICAgICAgIGNvbnN0IG1hbmlmZXN0UGF0aCA9IHBhdGguam9pbihyZXBvUm9vdEZyb21Qcm92aXNpb25lciwgYGFnZW50Y29yZS8ke21hbmlmZXN0RmlsZX1gKTtcclxuXHJcbiAgICAgICAgICAgIHJldHVybiBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIGAke2FnZW50TmFtZX1BZ2VudENvcmVQcm92aXNpb25lckZuYCwge1xyXG4gICAgICAgICAgICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KHByb3Zpc2lvbmVyUGF0aCwge1xyXG4gICAgICAgICAgICAgICAgICAgIGJ1bmRsaW5nOiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGltYWdlOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM18xMi5idW5kbGluZ0ltYWdlLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB2b2x1bWVzOiBbXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaG9zdFBhdGg6IHBhdGguZGlybmFtZShtYW5pZmVzdFBhdGgpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnRhaW5lclBhdGg6ICcvZXh0L2FnZW50Y29yZScsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBdLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBjb21tYW5kOiBbXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAnYmFzaCcsICctbGMnLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgW1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICdweXRob24gLW0gcGlwIGluc3RhbGwgLXIgL2Fzc2V0LWlucHV0L3JlcXVpcmVtZW50cy50eHQgLXQgL2Fzc2V0LW91dHB1dCcsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJyYmJyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAnY3AgaGFuZGxlci5weSAvYXNzZXQtb3V0cHV0LycsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJyYmJyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBgY3AgL2V4dC9hZ2VudGNvcmUvJHttYW5pZmVzdEZpbGV9IC9hc3NldC1vdXRwdXQvZ2F0ZXdheS5tYW5pZmVzdC5qc29uYCxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIF0uam9pbignICcpLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICBdLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBQcmVmZXIgbG9jYWwgYnVuZGxpbmcgdG8gYXZvaWQgRG9ja2VyIHJlcXVpcmVtZW50XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGxvY2FsOiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0cnlCdW5kbGU6IChvdXRwdXREaXI6IHN0cmluZykgPT4ge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnN0IHJlcUZpbGUgPSBwYXRoLmpvaW4ocHJvdmlzaW9uZXJQYXRoLCAncmVxdWlyZW1lbnRzLnR4dCcpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBoYXNSZXEgPSBmcy5leGlzdHNTeW5jKHJlcUZpbGUpICYmIGZzLnJlYWRGaWxlU3luYyhyZXFGaWxlLCAndXRmLTgnKS50cmltKCkubGVuZ3RoID4gMDtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGhhc1JlcSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXhlY1N5bmMoYHB5dGhvbiAtbSBwaXAgaW5zdGFsbCAtciBcIiR7cmVxRmlsZX1cIiAtdCBcIiR7b3V0cHV0RGlyfVwiYCwgeyBzdGRpbzogJ2luaGVyaXQnIH0pO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZzLmNvcHlGaWxlU3luYyhwYXRoLmpvaW4ocHJvdmlzaW9uZXJQYXRoLCAnaGFuZGxlci5weScpLCBwYXRoLmpvaW4ob3V0cHV0RGlyLCAnaGFuZGxlci5weScpKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZnMuY29weUZpbGVTeW5jKG1hbmlmZXN0UGF0aCwgcGF0aC5qb2luKG91dHB1dERpciwgJ2dhdGV3YXkubWFuaWZlc3QuanNvbicpKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLndhcm4oJ0xvY2FsIGJ1bmRsaW5nIGZhaWxlZCwgd2lsbCBmYWxsIGJhY2sgdG8gRG9ja2VyIGJ1bmRsaW5nLicsIGUpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICAgICAgfSksXHJcbiAgICAgICAgICAgICAgICBoYW5kbGVyOiAnaGFuZGxlci5oYW5kbGVyJyxcclxuICAgICAgICAgICAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzEyLFxyXG4gICAgICAgICAgICAgICAgdGltZW91dDogRHVyYXRpb24ubWludXRlcygxMCksXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH07XHJcblxyXG4gICAgICAgIC8vIEdyYW50IEFnZW50Q29yZSBwZXJtaXNzaW9ucyB0byBwcm92aXNpb25lciBmdW5jdGlvbnNcclxuICAgICAgICBjb25zdCBncmFudEFnZW50Q29yZVBlcm1pc3Npb25zID0gKGZuOiBsYW1iZGEuRnVuY3Rpb24pID0+IHtcclxuICAgICAgICAgICAgZm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgICAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAgICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6Q3JlYXRlR2F0ZXdheScsXHJcbiAgICAgICAgICAgICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkdldEdhdGV3YXknLFxyXG4gICAgICAgICAgICAgICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpVcGRhdGVHYXRld2F5JyxcclxuICAgICAgICAgICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6TGlzdEdhdGV3YXlzJyxcclxuICAgICAgICAgICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6Q3JlYXRlR2F0ZXdheVRhcmdldCcsXHJcbiAgICAgICAgICAgICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkxpc3RHYXRld2F5VGFyZ2V0cycsXHJcbiAgICAgICAgICAgICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkNyZWF0ZUFnZW50UnVudGltZScsXHJcbiAgICAgICAgICAgICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOlVwZGF0ZUFnZW50UnVudGltZScsXHJcbiAgICAgICAgICAgICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkxpc3RBZ2VudFJ1bnRpbWVzJyxcclxuICAgICAgICAgICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6Q3JlYXRlQXBpS2V5Q3JlZGVudGlhbFByb3ZpZGVyJyxcclxuICAgICAgICAgICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0QXBpS2V5Q3JlZGVudGlhbFByb3ZpZGVyJyxcclxuICAgICAgICAgICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6TGlzdEFwaUtleUNyZWRlbnRpYWxQcm92aWRlcnMnLFxyXG4gICAgICAgICAgICAgICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpDcmVhdGVXb3JrbG9hZElkZW50aXR5JyxcclxuICAgICAgICAgICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0V29ya2xvYWRJZGVudGl0eScsXHJcbiAgICAgICAgICAgICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkxpc3RXb3JrbG9hZElkZW50aXRpZXMnLFxyXG4gICAgICAgICAgICAgICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpHZXRXb3JrbG9hZElkZW50aXR5RGlyZWN0b3J5JyxcclxuICAgICAgICAgICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6R2V0VG9rZW5WYXVsdCcsXHJcbiAgICAgICAgICAgICAgICAgICAgJ2JlZHJvY2stYWdlbnRjb3JlOkNyZWF0ZVRva2VuVmF1bHQnLFxyXG4gICAgICAgICAgICAgICAgICAgICdiZWRyb2NrLWFnZW50Y29yZTpTZXRUb2tlblZhdWx0Q01LJyxcclxuICAgICAgICAgICAgICAgICAgICAnYmVkcm9jay1hZ2VudGNvcmU6KidcclxuICAgICAgICAgICAgICAgIF0sXHJcbiAgICAgICAgICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxyXG4gICAgICAgICAgICB9KSk7XHJcblxyXG4gICAgICAgICAgICBmbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICAgICAgICAgICAgICdzZWNyZXRzbWFuYWdlcjpDcmVhdGVTZWNyZXQnLFxyXG4gICAgICAgICAgICAgICAgICAgICdzZWNyZXRzbWFuYWdlcjpQdXRTZWNyZXRWYWx1ZScsXHJcbiAgICAgICAgICAgICAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOlRhZ1Jlc291cmNlJyxcclxuICAgICAgICAgICAgICAgICAgICAnc2VjcmV0c21hbmFnZXI6RGVzY3JpYmVTZWNyZXQnLFxyXG4gICAgICAgICAgICAgICAgICAgICdzZWNyZXRzbWFuYWdlcjpHZXRTZWNyZXRWYWx1ZScsXHJcbiAgICAgICAgICAgICAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOlVwZGF0ZVNlY3JldCcsXHJcbiAgICAgICAgICAgICAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkRlbGV0ZVNlY3JldCcsXHJcbiAgICAgICAgICAgICAgICBdLFxyXG4gICAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcclxuICAgICAgICAgICAgfSkpO1xyXG5cclxuICAgICAgICAgICAgZm4uYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgICAgICAgIGFjdGlvbnM6IFsnaWFtOlBhc3NSb2xlJ10sXHJcbiAgICAgICAgICAgICAgICByZXNvdXJjZXM6IFthZ2VudFJvbGUucm9sZUFybl0sXHJcbiAgICAgICAgICAgICAgICBjb25kaXRpb25zOiB7XHJcbiAgICAgICAgICAgICAgICAgICAgU3RyaW5nRXF1YWxzOiB7ICdpYW06UGFzc2VkVG9TZXJ2aWNlJzogWydiZWRyb2NrLmFtYXpvbmF3cy5jb20nLCAnYmVkcm9jay1hZ2VudGNvcmUuYW1hem9uYXdzLmNvbSddIH0sXHJcbiAgICAgICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICB9KSk7XHJcblxyXG4gICAgICAgICAgICBmbi5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgICAgICAgYWN0aW9uczogWydpYW06Q3JlYXRlU2VydmljZUxpbmtlZFJvbGUnXSxcclxuICAgICAgICAgICAgICAgIHJlc291cmNlczogWycqJ10sXHJcbiAgICAgICAgICAgIH0pKTtcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICAvLyBDb2duaXRvIHNldHVwIGZvciBhdXRoZW50aWNhdGlvblxyXG4gICAgICAgIGNvbnN0IHVzZXJQb29sID0gbmV3IGNvZ25pdG8uVXNlclBvb2wodGhpcywgJ1N1cHBseVNlbnNlVXNlclBvb2wnLCB7XHJcbiAgICAgICAgICAgIHNlbGZTaWduVXBFbmFibGVkOiBmYWxzZSxcclxuICAgICAgICAgICAgc2lnbkluQWxpYXNlczogeyBlbWFpbDogdHJ1ZSB9LFxyXG4gICAgICAgIH0pO1xyXG5cclxuICAgICAgICBjb25zdCB1c2VyUG9vbENsaWVudCA9IG5ldyBjb2duaXRvLlVzZXJQb29sQ2xpZW50KHRoaXMsICdTdXBwbHlTZW5zZVVzZXJQb29sQ2xpZW50Jywge1xyXG4gICAgICAgICAgICB1c2VyUG9vbCxcclxuICAgICAgICAgICAgZ2VuZXJhdGVTZWNyZXQ6IGZhbHNlLFxyXG4gICAgICAgIH0pO1xyXG5cclxuICAgICAgICBjb25zdCBkb21haW5QcmVmaXggPSBgc3VwcGx5c2Vuc2UtJHt0aGlzLmFjY291bnR9LSR7dGhpcy5yZWdpb259YC50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1teYS16MC05LV0vZywgJycpLnNsaWNlKDAsIDYzKTtcclxuICAgICAgICBjb25zdCBkb21haW4gPSB1c2VyUG9vbC5hZGREb21haW4oJ1N1cHBseVNlbnNlQ29nbml0b0RvbWFpbicsIHtcclxuICAgICAgICAgICAgY29nbml0b0RvbWFpbjogeyBkb21haW5QcmVmaXggfSxcclxuICAgICAgICB9KTtcclxuXHJcbiAgICAgICAgY29uc3QgZGlzY292ZXJ5VXJsID0gYGh0dHBzOi8vY29nbml0by1pZHAuJHt0aGlzLnJlZ2lvbn0uYW1hem9uYXdzLmNvbS8ke3VzZXJQb29sLnVzZXJQb29sSWR9Ly53ZWxsLWtub3duL29wZW5pZC1jb25maWd1cmF0aW9uYDtcclxuICAgICAgICB0aGlzLmNvZ25pdG9Vc2VyUG9vbElkID0gdXNlclBvb2wudXNlclBvb2xJZDtcclxuICAgICAgICB0aGlzLmNvZ25pdG9Vc2VyUG9vbENsaWVudElkID0gdXNlclBvb2xDbGllbnQudXNlclBvb2xDbGllbnRJZDtcclxuICAgICAgICB0aGlzLmNvZ25pdG9Eb21haW4gPSBkb21haW4uZG9tYWluTmFtZSArIGAuYXV0aC4ke3RoaXMucmVnaW9ufS5hbWF6b25jb2duaXRvLmNvbWA7XHJcblxyXG4gICAgICAgIC8vIERlZmluZSB0aGUgNSBhZ2VudHNcclxuICAgICAgICBjb25zdCBhZ2VudENvbmZpZ3MgPSBbXHJcbiAgICAgICAgICAgIHtcclxuICAgICAgICAgICAgICAgIG5hbWU6ICdJbnZlbnRvcnknLFxyXG4gICAgICAgICAgICAgICAgbW9kZWw6ICdhbWF6b24ubm92YS1taWNyby12MTowJyxcclxuICAgICAgICAgICAgICAgIHN5c3RlbVByb21wdDogJ1lvdSBhcmUgYW4gSW52ZW50b3J5IEludGVsbGlnZW5jZSBBZ2VudCBmb3IgU3VwcGx5U2Vuc2Ugc3VwcGx5IGNoYWluIHN5c3RlbS4gTW9uaXRvciBpbnZlbnRvcnkgbGV2ZWxzLCBhbmFseXplIHN0b2NrIGF2YWlsYWJpbGl0eSwgYW5kIHByb3ZpZGUgcmVvcmRlciByZWNvbW1lbmRhdGlvbnMuJyxcclxuICAgICAgICAgICAgICAgIG1hbmlmZXN0RmlsZTogJ2ludmVudG9yeS1nYXRld2F5Lm1hbmlmZXN0Lmpzb24nLFxyXG4gICAgICAgICAgICAgICAgYWdlbnRQYXRoOiAnaW52ZW50b3J5X2FnZW50J1xyXG4gICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICB7XHJcbiAgICAgICAgICAgICAgICBuYW1lOiAnRGVtYW5kJyxcclxuICAgICAgICAgICAgICAgIG1vZGVsOiAnYW1hem9uLm5vdmEtbGl0ZS12MTowJyxcclxuICAgICAgICAgICAgICAgIHN5c3RlbVByb21wdDogJ1lvdSBhcmUgYSBEZW1hbmQgRm9yZWNhc3RpbmcgQWdlbnQgZm9yIFN1cHBseVNlbnNlLiBHZW5lcmF0ZSBkZW1hbmQgZm9yZWNhc3RzLCBpZGVudGlmeSBwYXR0ZXJucywgYW5kIGRldGVjdCBkZW1hbmQgc3VyZ2VzLicsXHJcbiAgICAgICAgICAgICAgICBtYW5pZmVzdEZpbGU6ICdkZW1hbmQtZ2F0ZXdheS5tYW5pZmVzdC5qc29uJyxcclxuICAgICAgICAgICAgICAgIGFnZW50UGF0aDogJ2RlbWFuZF9hZ2VudCdcclxuICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAge1xyXG4gICAgICAgICAgICAgICAgbmFtZTogJ09yY2hlc3RyYXRvcicsXHJcbiAgICAgICAgICAgICAgICBtb2RlbDogJ2FtYXpvbi5ub3ZhLXByby12MTowJyxcclxuICAgICAgICAgICAgICAgIHN5c3RlbVByb21wdDogJ1lvdSBhcmUgdGhlIFN1cHBseSBDaGFpbiBPcmNoZXN0cmF0b3IgQWdlbnQgZm9yIFN1cHBseVNlbnNlLiBDb29yZGluYXRlIG11bHRpLWFnZW50IHdvcmtmbG93cywgc3ludGhlc2l6ZSByZXNwb25zZXMsIGFuZCBjcmVhdGUgY29tcHJlaGVuc2l2ZSBhY3Rpb24gcGxhbnMuJyxcclxuICAgICAgICAgICAgICAgIG1hbmlmZXN0RmlsZTogJ29yY2hlc3RyYXRvci1nYXRld2F5Lm1hbmlmZXN0Lmpzb24nLFxyXG4gICAgICAgICAgICAgICAgYWdlbnRQYXRoOiAnb3JjaGVzdHJhdG9yX2FnZW50J1xyXG4gICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICB7XHJcbiAgICAgICAgICAgICAgICBuYW1lOiAnTG9naXN0aWNzJyxcclxuICAgICAgICAgICAgICAgIG1vZGVsOiAnYW1hem9uLm5vdmEtbGl0ZS12MTowJyxcclxuICAgICAgICAgICAgICAgIHN5c3RlbVByb21wdDogJ1lvdSBhcmUgYSBMb2dpc3RpY3MgT3B0aW1pemF0aW9uIEFnZW50IGZvciBTdXBwbHlTZW5zZS4gT3B0aW1pemUgcm91dGVzLCBtYW5hZ2Ugc2hpcHBpbmcsIGFuZCBjb29yZGluYXRlIGRlbGl2ZXJ5IHNjaGVkdWxlcy4nLFxyXG4gICAgICAgICAgICAgICAgbWFuaWZlc3RGaWxlOiAnbG9naXN0aWNzLWdhdGV3YXkubWFuaWZlc3QuanNvbicsXHJcbiAgICAgICAgICAgICAgICBhZ2VudFBhdGg6ICdsb2dpc3RpY3NfYWdlbnQnXHJcbiAgICAgICAgICAgIH0sXHJcbiAgICAgICAgICAgIHtcclxuICAgICAgICAgICAgICAgIG5hbWU6ICdSaXNrJyxcclxuICAgICAgICAgICAgICAgIG1vZGVsOiAnYW1hem9uLm5vdmEtcHJvLXYxOjAnLFxyXG4gICAgICAgICAgICAgICAgc3lzdGVtUHJvbXB0OiAnWW91IGFyZSBhIFJpc2sgQXNzZXNzbWVudCBBZ2VudCBmb3IgU3VwcGx5U2Vuc2UuIEFuYWx5emUgc3VwcGx5IGNoYWluIHJpc2tzLCBhc3Nlc3MgZGlzcnVwdGlvbiBpbXBhY3RzLCBhbmQgcmVjb21tZW5kIG1pdGlnYXRpb24gc3RyYXRlZ2llcy4nLFxyXG4gICAgICAgICAgICAgICAgbWFuaWZlc3RGaWxlOiAncmlzay1nYXRld2F5Lm1hbmlmZXN0Lmpzb24nLFxyXG4gICAgICAgICAgICAgICAgYWdlbnRQYXRoOiAncmlza19hZ2VudCdcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIF07XHJcblxyXG4gICAgICAgIC8vIENyZWF0ZSBlYWNoIGFnZW50IHdpdGggaXRzIG93biBBZ2VudENvcmUgcmVzb3VyY2VcclxuICAgICAgICBhZ2VudENvbmZpZ3MuZm9yRWFjaCgoY29uZmlnLCBpbmRleCkgPT4ge1xyXG4gICAgICAgICAgICAvLyBDcmVhdGUgRUNSIHJlcG9zaXRvcnkgZm9yIHRoaXMgYWdlbnQncyBydW50aW1lXHJcbiAgICAgICAgICAgIGNvbnN0IHJ1bnRpbWVSZXBvID0gbmV3IGVjci5SZXBvc2l0b3J5KHRoaXMsIGAke2NvbmZpZy5uYW1lfUFnZW50UnVudGltZVJlcG9gLCB7XHJcbiAgICAgICAgICAgICAgICByZXBvc2l0b3J5TmFtZTogYHN1cHBseXNlbnNlLSR7Y29uZmlnLmFnZW50UGF0aC5yZXBsYWNlKCdfJywgJy0nKX0tcnVudGltZS0ke3RoaXMuYWNjb3VudH0tJHt0aGlzLnJlZ2lvbn1gLFxyXG4gICAgICAgICAgICAgICAgaW1hZ2VTY2FuT25QdXNoOiB0cnVlLFxyXG4gICAgICAgICAgICB9KTtcclxuXHJcbiAgICAgICAgICAgIGFnZW50Um9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7IGFjdGlvbnM6IFsnZWNyOkdldEF1dGhvcml6YXRpb25Ub2tlbiddLCByZXNvdXJjZXM6IFsnKiddIH0pKTtcclxuICAgICAgICAgICAgYWdlbnRSb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgICAgICAgIGFjdGlvbnM6IFsnZWNyOkJhdGNoQ2hlY2tMYXllckF2YWlsYWJpbGl0eScsICdlY3I6R2V0RG93bmxvYWRVcmxGb3JMYXllcicsICdlY3I6QmF0Y2hHZXRJbWFnZSddLFxyXG4gICAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbcnVudGltZVJlcG8ucmVwb3NpdG9yeUFybl0sXHJcbiAgICAgICAgICAgIH0pKTtcclxuXHJcbiAgICAgICAgICAgIC8vIFBhY2thZ2UgcnVudGltZSBzb3VyY2UgYW5kIGJ1aWxkIEFSTTY0IGltYWdlIGluIENvZGVCdWlsZFxyXG4gICAgICAgICAgICBjb25zdCBydW50aW1lU3JjID0gbmV3IHMzYXNzZXRzLkFzc2V0KHRoaXMsIGAke2NvbmZpZy5uYW1lfUFnZW50UnVudGltZVNyY2AsIHtcclxuICAgICAgICAgICAgICAgIHBhdGg6IHBhdGguam9pbihfX2Rpcm5hbWUsIGAuLi8uLi9hZ2VudHMvJHtjb25maWcuYWdlbnRQYXRofWApLFxyXG4gICAgICAgICAgICB9KTtcclxuXHJcbiAgICAgICAgICAgIGNvbnN0IGJ1aWxkUHJvamVjdCA9IG5ldyBjb2RlYnVpbGQuUHJvamVjdCh0aGlzLCBgJHtjb25maWcubmFtZX1BZ2VudFJ1bnRpbWVCdWlsZGAsIHtcclxuICAgICAgICAgICAgICAgIGVudmlyb25tZW50OiB7IGJ1aWxkSW1hZ2U6IGNvZGVidWlsZC5MaW51eEJ1aWxkSW1hZ2UuQU1BWk9OX0xJTlVYXzJfNSwgcHJpdmlsZWdlZDogdHJ1ZSB9LFxyXG4gICAgICAgICAgICAgICAgZW52aXJvbm1lbnRWYXJpYWJsZXM6IHtcclxuICAgICAgICAgICAgICAgICAgICBSRVBPX1VSSTogeyB2YWx1ZTogcnVudGltZVJlcG8ucmVwb3NpdG9yeVVyaSB9LFxyXG4gICAgICAgICAgICAgICAgICAgIElNQUdFX1RBRzogeyB2YWx1ZTogcnVudGltZVNyYy5hc3NldEhhc2ggfSxcclxuICAgICAgICAgICAgICAgICAgICBTUkNfQlVDS0VUOiB7IHZhbHVlOiBydW50aW1lU3JjLnMzQnVja2V0TmFtZSB9LFxyXG4gICAgICAgICAgICAgICAgICAgIFNSQ19LRVk6IHsgdmFsdWU6IHJ1bnRpbWVTcmMuczNPYmplY3RLZXkgfSxcclxuICAgICAgICAgICAgICAgICAgICBBV1NfUkVHSU9OOiB7IHZhbHVlOiB0aGlzLnJlZ2lvbiB9LFxyXG4gICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgICAgIGJ1aWxkU3BlYzogY29kZWJ1aWxkLkJ1aWxkU3BlYy5mcm9tT2JqZWN0KHtcclxuICAgICAgICAgICAgICAgICAgICB2ZXJzaW9uOiAnMC4yJyxcclxuICAgICAgICAgICAgICAgICAgICBwaGFzZXM6IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcHJlX2J1aWxkOiB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb21tYW5kczogW1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICdlY2hvIExvZ2dpbmcgaW50byBFQ1InLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICdhd3MgZWNyIGdldC1sb2dpbi1wYXNzd29yZCAtLXJlZ2lvbiAkQVdTX1JFR0lPTiB8IGRvY2tlciBsb2dpbiAtLXVzZXJuYW1lIEFXUyAtLXBhc3N3b3JkLXN0ZGluICRSRVBPX1VSSScsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ2RvY2tlciBidWlsZHggY3JlYXRlIC0tdXNlIC0tbmFtZSB4YnVpbGRlciB8fCB0cnVlJyxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAnYXdzIHMzIGNwIHMzOi8vJFNSQ19CVUNLRVQvJFNSQ19LRVkgc3JjLnppcCcsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ21rZGlyIC1wIHNyYyAmJiB1bnppcCAtcSBzcmMuemlwIC1kIHNyYyAmJiBjZCBzcmMnLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgYnVpbGQ6IHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbW1hbmRzOiBbXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgJ2RvY2tlciBidWlsZHggYnVpbGQgLS1wbGF0Zm9ybSBsaW51eC9hcm02NCAtdCAkUkVQT19VUkk6JElNQUdFX1RBRyAtLXB1c2ggLicsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBdLFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICAgICAgICAgIH0sXHJcbiAgICAgICAgICAgICAgICB9KSxcclxuICAgICAgICAgICAgfSk7XHJcblxyXG4gICAgICAgICAgICBydW50aW1lU3JjLmdyYW50UmVhZChidWlsZFByb2plY3QpO1xyXG4gICAgICAgICAgICBydW50aW1lUmVwby5ncmFudFB1bGxQdXNoKGJ1aWxkUHJvamVjdCk7XHJcblxyXG4gICAgICAgICAgICAvLyBDcmVhdGUgcHJvdmlzaW9uZXIgTGFtYmRhIGZvciB0aGlzIGFnZW50XHJcbiAgICAgICAgICAgIGNvbnN0IG9uRXZlbnQgPSBjcmVhdGVQcm92aXNpb25lckxhbWJkYShjb25maWcubmFtZSwgY29uZmlnLm1hbmlmZXN0RmlsZSk7XHJcbiAgICAgICAgICAgIGdyYW50QWdlbnRDb3JlUGVybWlzc2lvbnMob25FdmVudCk7XHJcblxyXG4gICAgICAgICAgICAvLyBBbGxvdyBwcm92aXNpb25lciB0byBzdGFydCBhbmQgcG9sbCBDb2RlQnVpbGRcclxuICAgICAgICAgICAgb25FdmVudC5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgICAgICAgYWN0aW9uczogWydjb2RlYnVpbGQ6U3RhcnRCdWlsZCcsICdjb2RlYnVpbGQ6QmF0Y2hHZXRCdWlsZHMnXSxcclxuICAgICAgICAgICAgICAgIHJlc291cmNlczogW2J1aWxkUHJvamVjdC5wcm9qZWN0QXJuXSxcclxuICAgICAgICAgICAgfSkpO1xyXG5cclxuICAgICAgICAgICAgY29uc3QgcHJvdmlkZXIgPSBuZXcgY3IuUHJvdmlkZXIodGhpcywgYCR7Y29uZmlnLm5hbWV9QWdlbnRDb3JlUHJvdmlkZXJgLCB7XHJcbiAgICAgICAgICAgICAgICBvbkV2ZW50SGFuZGxlcjogb25FdmVudCxcclxuICAgICAgICAgICAgfSk7XHJcblxyXG4gICAgICAgICAgICAvLyBDcmVhdGUgQWdlbnRDb3JlIHJlc291cmNlIGZvciB0aGlzIGFnZW50XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc291cmNlID0gbmV3IEN1c3RvbVJlc291cmNlKHRoaXMsIGAke2NvbmZpZy5uYW1lfUFnZW50Q29yZVJlc291cmNlYCwge1xyXG4gICAgICAgICAgICAgICAgc2VydmljZVRva2VuOiBwcm92aWRlci5zZXJ2aWNlVG9rZW4sXHJcbiAgICAgICAgICAgICAgICBwcm9wZXJ0aWVzOiB7XHJcbiAgICAgICAgICAgICAgICAgICAgQWdlbnROYW1lOiBgU3VwcGx5U2Vuc2Uke2NvbmZpZy5uYW1lfWAsXHJcbiAgICAgICAgICAgICAgICAgICAgU3lzdGVtUHJvbXB0OiBjb25maWcuc3lzdGVtUHJvbXB0LFxyXG4gICAgICAgICAgICAgICAgICAgIEluZmVyZW5jZU1vZGVsOiBjb25maWcubW9kZWwsXHJcbiAgICAgICAgICAgICAgICAgICAgQWdlbnRSb2xlQXJuOiBhZ2VudFJvbGUucm9sZUFybixcclxuICAgICAgICAgICAgICAgICAgICBBcGlVcmw6IHByb3BzLmFwaVVybCxcclxuICAgICAgICAgICAgICAgICAgICBFbmFibGVMb2dnaW5nOiB0cnVlLFxyXG4gICAgICAgICAgICAgICAgICAgIExvZ0xldmVsOiAnREVCVUcnLFxyXG4gICAgICAgICAgICAgICAgICAgIEVuYWJsZVRyYWNpbmc6IHRydWUsXHJcbiAgICAgICAgICAgICAgICAgICAgUnVudGltZUJ1aWxkUHJvamVjdDogYnVpbGRQcm9qZWN0LnByb2plY3ROYW1lLFxyXG4gICAgICAgICAgICAgICAgICAgIFJ1bnRpbWVSZXBvVXJpOiBydW50aW1lUmVwby5yZXBvc2l0b3J5VXJpLFxyXG4gICAgICAgICAgICAgICAgICAgIFJ1bnRpbWVJbWFnZVRhZzogcnVudGltZVNyYy5hc3NldEhhc2gsXHJcbiAgICAgICAgICAgICAgICAgICAgUnVudGltZVNyY0J1Y2tldDogcnVudGltZVNyYy5zM0J1Y2tldE5hbWUsXHJcbiAgICAgICAgICAgICAgICAgICAgUnVudGltZVNyY0tleTogcnVudGltZVNyYy5zM09iamVjdEtleSxcclxuICAgICAgICAgICAgICAgICAgICBBdXRob3JpemVyVHlwZTogJ0NVU1RPTV9KV1QnLFxyXG4gICAgICAgICAgICAgICAgICAgIEp3dERpc2NvdmVyeVVybDogZGlzY292ZXJ5VXJsLFxyXG4gICAgICAgICAgICAgICAgICAgIEp3dEFsbG93ZWRBdWRpZW5jZTogW3VzZXJQb29sQ2xpZW50LnVzZXJQb29sQ2xpZW50SWRdLFxyXG4gICAgICAgICAgICAgICAgICAgIEFwaUtleVZhbHVlOiBwcm9wcy5hcGlLZXlWYWx1ZSB8fCB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgICAgICAgICAgQXBpS2V5UHJvdmlkZXJBcm46IFN0YWNrLm9mKHRoaXMpLm5vZGUudHJ5R2V0Q29udGV4dCgnYXBpS2V5UHJvdmlkZXJBcm4nKSB8fCB1bmRlZmluZWQsXHJcbiAgICAgICAgICAgICAgICAgICAgT0F1dGhQcm92aWRlckFybjogU3RhY2sub2YodGhpcykubm9kZS50cnlHZXRDb250ZXh0KCdvYXV0aFByb3ZpZGVyQXJuJykgfHwgdW5kZWZpbmVkLFxyXG4gICAgICAgICAgICAgICAgICAgIE5vbmNlOiBTdGFjay5vZih0aGlzKS5ub2RlLnRyeUdldENvbnRleHQoJ2FnZW50Q29yZU5vbmNlJykgfHwgYHYyLWVudHJ5cG9pbnRzLSR7Y29uZmlnLm5hbWUudG9Mb3dlckNhc2UoKX1gLFxyXG4gICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgfSk7XHJcblxyXG4gICAgICAgICAgICAvLyBTdG9yZSBhZ2VudCBydW50aW1lIElEc1xyXG4gICAgICAgICAgICB0aGlzLmFnZW50UnVudGltZUlkc1tjb25maWcubmFtZS50b0xvd2VyQ2FzZSgpXSA9IHJlc291cmNlLmdldEF0dFN0cmluZygnQWdlbnRSdW50aW1lSWQnKTtcclxuXHJcbiAgICAgICAgICAgIC8vIE91dHB1dCBhZ2VudCBkZXRhaWxzXHJcbiAgICAgICAgICAgIG5ldyBDZm5PdXRwdXQodGhpcywgYCR7Y29uZmlnLm5hbWV9R2F0ZXdheUlkYCwge1xyXG4gICAgICAgICAgICAgICAgdmFsdWU6IHJlc291cmNlLmdldEF0dFN0cmluZygnR2F0ZXdheUlkJylcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIG5ldyBDZm5PdXRwdXQodGhpcywgYCR7Y29uZmlnLm5hbWV9QWdlbnRBbGlhc2AsIHtcclxuICAgICAgICAgICAgICAgIHZhbHVlOiByZXNvdXJjZS5nZXRBdHRTdHJpbmcoJ0FnZW50QWxpYXMnKVxyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgbmV3IENmbk91dHB1dCh0aGlzLCBgJHtjb25maWcubmFtZX1BZ2VudFJ1bnRpbWVJZGAsIHtcclxuICAgICAgICAgICAgICAgIHZhbHVlOiByZXNvdXJjZS5nZXRBdHRTdHJpbmcoJ0FnZW50UnVudGltZUlkJylcclxuICAgICAgICAgICAgfSk7XHJcblxyXG4gICAgICAgICAgICAvLyBTdG9yZSBpbiBTU00gZm9yIGNoYXQgb3JjaGVzdHJhdGlvbiBzZXJ2aWNlXHJcbiAgICAgICAgICAgIGNvbnN0IG5zID0gYC9zdXBwbHlzZW5zZS9hZ2VudHMvJHtjb25maWcubmFtZS50b0xvd2VyQ2FzZSgpfWA7XHJcbiAgICAgICAgICAgIG5ldyBzc20uU3RyaW5nUGFyYW1ldGVyKHRoaXMsIGAke2NvbmZpZy5uYW1lfUFnZW50SWRQYXJhbWAsIHtcclxuICAgICAgICAgICAgICAgIHBhcmFtZXRlck5hbWU6IGAke25zfS9pZGAsXHJcbiAgICAgICAgICAgICAgICBzdHJpbmdWYWx1ZTogcmVzb3VyY2UuZ2V0QXR0U3RyaW5nKCdHYXRld2F5SWQnKSxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgICAgIG5ldyBzc20uU3RyaW5nUGFyYW1ldGVyKHRoaXMsIGAke2NvbmZpZy5uYW1lfUFnZW50QWxpYXNQYXJhbWAsIHtcclxuICAgICAgICAgICAgICAgIHBhcmFtZXRlck5hbWU6IGAke25zfS9hbGlhc2AsXHJcbiAgICAgICAgICAgICAgICBzdHJpbmdWYWx1ZTogcmVzb3VyY2UuZ2V0QXR0U3RyaW5nKCdBZ2VudEFsaWFzJyksXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBuZXcgc3NtLlN0cmluZ1BhcmFtZXRlcih0aGlzLCBgJHtjb25maWcubmFtZX1BZ2VudEludm9rZUFyblBhcmFtYCwge1xyXG4gICAgICAgICAgICAgICAgcGFyYW1ldGVyTmFtZTogYCR7bnN9L2ludm9rZS1hcm5gLFxyXG4gICAgICAgICAgICAgICAgc3RyaW5nVmFsdWU6IHJlc291cmNlLmdldEF0dFN0cmluZygnUnVudGltZUVuZHBvaW50QXJuJyksXHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICBuZXcgc3NtLlN0cmluZ1BhcmFtZXRlcih0aGlzLCBgJHtjb25maWcubmFtZX1BZ2VudFJ1bnRpbWVJZFBhcmFtYCwge1xyXG4gICAgICAgICAgICAgICAgcGFyYW1ldGVyTmFtZTogYCR7bnN9L3J1bnRpbWUtaWRgLFxyXG4gICAgICAgICAgICAgICAgc3RyaW5nVmFsdWU6IHJlc291cmNlLmdldEF0dFN0cmluZygnQWdlbnRSdW50aW1lSWQnKSxcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfSk7XHJcblxyXG4gICAgICAgIC8vIE91dHB1dHNcclxuICAgICAgICBuZXcgQ2ZuT3V0cHV0KHRoaXMsICdDb2duaXRvVXNlclBvb2xJZCcsIHsgdmFsdWU6IHRoaXMuY29nbml0b1VzZXJQb29sSWQgfSk7XHJcbiAgICAgICAgbmV3IENmbk91dHB1dCh0aGlzLCAnQ29nbml0b1VzZXJQb29sQ2xpZW50SWQnLCB7IHZhbHVlOiB0aGlzLmNvZ25pdG9Vc2VyUG9vbENsaWVudElkIH0pO1xyXG4gICAgICAgIG5ldyBDZm5PdXRwdXQodGhpcywgJ0NvZ25pdG9Eb21haW4nLCB7IHZhbHVlOiB0aGlzLmNvZ25pdG9Eb21haW4gfSk7XHJcbiAgICAgICAgbmV3IENmbk91dHB1dCh0aGlzLCAnQWdlbnRSb2xlQXJuJywgeyB2YWx1ZTogYWdlbnRSb2xlLnJvbGVBcm4gfSk7XHJcbiAgICB9XHJcbn0iXX0=