import { Stack, StackProps, CfnOutput, Duration, CustomResource } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as fs from 'fs';
import { execSync } from 'child_process';

export interface SupplySenseAgentCoreProps extends StackProps {
    apiUrl: string;
    apiKeyValue?: string;
}

export class SupplySenseAgentCoreStack extends Stack {
    public readonly cognitoUserPoolId: string;
    public readonly cognitoUserPoolClientId: string;
    public readonly cognitoDomain: string;
    public readonly agentRuntimeIds: { [key: string]: string } = {};

    constructor(scope: Construct, id: string, props: SupplySenseAgentCoreProps) {
        super(scope, id, props);

        // Common IAM role for all SupplySense agents
        const agentRole = new iam.Role(this, 'SupplySenseAgentCoreRole', {
            assumedBy: new iam.CompositePrincipal(
                new iam.ServicePrincipal('bedrock.amazonaws.com'),
                new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
            ),
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

        const createProvisionerLambda = (agentName: string, manifestFile: string) => {
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
                            tryBundle: (outputDir: string) => {
                                try {
                                    const reqFile = path.join(provisionerPath, 'requirements.txt');
                                    const hasReq = fs.existsSync(reqFile) && fs.readFileSync(reqFile, 'utf-8').trim().length > 0;
                                    if (hasReq) {
                                        execSync(`python -m pip install -r "${reqFile}" -t "${outputDir}"`, { stdio: 'inherit' });
                                    }
                                    fs.copyFileSync(path.join(provisionerPath, 'handler.py'), path.join(outputDir, 'handler.py'));
                                    fs.copyFileSync(manifestPath, path.join(outputDir, 'gateway.manifest.json'));
                                    return true;
                                } catch (e) {
                                    console.warn('Local bundling failed, will fall back to Docker bundling.', e);
                                    return false;
                                }
                            },
                        },
                    },
                }),
                handler: 'handler.handler',
                runtime: lambda.Runtime.PYTHON_3_12,
                timeout: Duration.minutes(10),
            });
        };

        // Grant AgentCore permissions to provisioner functions
        const grantAgentCorePermissions = (fn: lambda.Function) => {
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
            const resource = new CustomResource(this, `${config.name}AgentCoreResource`, {
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
                    ApiKeyProviderArn: Stack.of(this).node.tryGetContext('apiKeyProviderArn') || undefined,
                    OAuthProviderArn: Stack.of(this).node.tryGetContext('oauthProviderArn') || undefined,
                    Nonce: Stack.of(this).node.tryGetContext('agentCoreNonce') || `v2-entrypoints-${config.name.toLowerCase()}`,
                    // Force re-run of custom resource when provisioner code changes
                    ProvisionerVersion: 'v2-fix-endpoint-detection',
                },
            });

            // Store agent runtime IDs
            this.agentRuntimeIds[config.name.toLowerCase()] = resource.getAttString('AgentRuntimeId');

            // Output agent details
            new CfnOutput(this, `${config.name}GatewayId`, {
                value: resource.getAttString('GatewayId')
            });
            new CfnOutput(this, `${config.name}AgentAlias`, {
                value: resource.getAttString('AgentAlias')
            });
            new CfnOutput(this, `${config.name}AgentRuntimeId`, {
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
        new CfnOutput(this, 'CognitoUserPoolId', { value: this.cognitoUserPoolId });
        new CfnOutput(this, 'CognitoUserPoolClientId', { value: this.cognitoUserPoolClientId });
        new CfnOutput(this, 'CognitoDomain', { value: this.cognitoDomain });
        new CfnOutput(this, 'AgentRoleArn', { value: agentRole.roleArn });
    }
}