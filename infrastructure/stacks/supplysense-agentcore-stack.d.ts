import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
export interface SupplySenseAgentCoreProps extends StackProps {
    apiUrl: string;
    apiKeyValue?: string;
}
export declare class SupplySenseAgentCoreStack extends Stack {
    readonly cognitoUserPoolId: string;
    readonly cognitoUserPoolClientId: string;
    readonly cognitoDomain: string;
    readonly agentRuntimeIds: {
        [key: string]: string;
    };
    constructor(scope: Construct, id: string, props: SupplySenseAgentCoreProps);
}
