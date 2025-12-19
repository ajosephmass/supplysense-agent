import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
export interface SupplySenseChatProps extends StackProps {
    cognitoUserPoolId: string;
    cognitoUserPoolClientId: string;
}
export declare class SupplySenseChatStack extends Stack {
    readonly chatServiceUrl: string;
    constructor(scope: Construct, id: string, props: SupplySenseChatProps);
}
