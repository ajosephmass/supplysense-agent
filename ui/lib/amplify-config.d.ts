declare const amplifyConfig: {
    Auth: {
        Cognito: {
            userPoolId: string;
            userPoolClientId: string;
            identityPoolId: string;
            loginWith: {
                email: boolean;
                username: boolean;
            };
            signUpVerificationMethod: "code";
            userAttributes: {
                email: {
                    required: boolean;
                };
                given_name: {
                    required: boolean;
                };
                family_name: {
                    required: boolean;
                };
            };
            allowGuestAccess: boolean;
            passwordFormat: {
                minLength: number;
                requireLowercase: boolean;
                requireUppercase: boolean;
                requireNumbers: boolean;
                requireSpecialCharacters: boolean;
            };
        };
    };
    API: {
        REST: {
            SupplySenseAPI: {
                endpoint: string;
                region: string;
            };
        };
    };
};
export default amplifyConfig;
