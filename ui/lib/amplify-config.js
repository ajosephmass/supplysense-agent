"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const aws_amplify_1 = require("aws-amplify");
const amplifyConfig = {
    Auth: {
        Cognito: {
            userPoolId: process.env.NEXT_PUBLIC_USER_POOL_ID || '',
            userPoolClientId: process.env.NEXT_PUBLIC_USER_POOL_CLIENT_ID || '',
            identityPoolId: process.env.NEXT_PUBLIC_IDENTITY_POOL_ID || '',
            loginWith: {
                email: true,
                username: true,
            },
            signUpVerificationMethod: 'code',
            userAttributes: {
                email: {
                    required: true,
                },
                given_name: {
                    required: true,
                },
                family_name: {
                    required: true,
                },
            },
            allowGuestAccess: false,
            passwordFormat: {
                minLength: 8,
                requireLowercase: true,
                requireUppercase: true,
                requireNumbers: true,
                requireSpecialCharacters: true,
            },
        },
    },
    API: {
        REST: {
            SupplySenseAPI: {
                endpoint: process.env.NEXT_PUBLIC_API_ENDPOINT || '',
                region: process.env.NEXT_PUBLIC_AWS_REGION || 'us-east-1',
            },
        },
    },
};
aws_amplify_1.Amplify.configure(amplifyConfig);
exports.default = amplifyConfig;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYW1wbGlmeS1jb25maWcuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJhbXBsaWZ5LWNvbmZpZy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLDZDQUFzQztBQUV0QyxNQUFNLGFBQWEsR0FBRztJQUNwQixJQUFJLEVBQUU7UUFDSixPQUFPLEVBQUU7WUFDUCxVQUFVLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyx3QkFBd0IsSUFBSSxFQUFFO1lBQ3RELGdCQUFnQixFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsK0JBQStCLElBQUksRUFBRTtZQUNuRSxjQUFjLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyw0QkFBNEIsSUFBSSxFQUFFO1lBQzlELFNBQVMsRUFBRTtnQkFDVCxLQUFLLEVBQUUsSUFBSTtnQkFDWCxRQUFRLEVBQUUsSUFBSTthQUNmO1lBQ0Qsd0JBQXdCLEVBQUUsTUFBZTtZQUN6QyxjQUFjLEVBQUU7Z0JBQ2QsS0FBSyxFQUFFO29CQUNMLFFBQVEsRUFBRSxJQUFJO2lCQUNmO2dCQUNELFVBQVUsRUFBRTtvQkFDVixRQUFRLEVBQUUsSUFBSTtpQkFDZjtnQkFDRCxXQUFXLEVBQUU7b0JBQ1gsUUFBUSxFQUFFLElBQUk7aUJBQ2Y7YUFDRjtZQUNELGdCQUFnQixFQUFFLEtBQUs7WUFDdkIsY0FBYyxFQUFFO2dCQUNkLFNBQVMsRUFBRSxDQUFDO2dCQUNaLGdCQUFnQixFQUFFLElBQUk7Z0JBQ3RCLGdCQUFnQixFQUFFLElBQUk7Z0JBQ3RCLGNBQWMsRUFBRSxJQUFJO2dCQUNwQix3QkFBd0IsRUFBRSxJQUFJO2FBQy9CO1NBQ0Y7S0FDRjtJQUNELEdBQUcsRUFBRTtRQUNILElBQUksRUFBRTtZQUNKLGNBQWMsRUFBRTtnQkFDZCxRQUFRLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyx3QkFBd0IsSUFBSSxFQUFFO2dCQUNwRCxNQUFNLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxzQkFBc0IsSUFBSSxXQUFXO2FBQzFEO1NBQ0Y7S0FDRjtDQUNGLENBQUM7QUFFRixxQkFBTyxDQUFDLFNBQVMsQ0FBQyxhQUFhLENBQUMsQ0FBQztBQUVqQyxrQkFBZSxhQUFhLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBBbXBsaWZ5IH0gZnJvbSAnYXdzLWFtcGxpZnknO1xyXG5cclxuY29uc3QgYW1wbGlmeUNvbmZpZyA9IHtcclxuICBBdXRoOiB7XHJcbiAgICBDb2duaXRvOiB7XHJcbiAgICAgIHVzZXJQb29sSWQ6IHByb2Nlc3MuZW52Lk5FWFRfUFVCTElDX1VTRVJfUE9PTF9JRCB8fCAnJyxcclxuICAgICAgdXNlclBvb2xDbGllbnRJZDogcHJvY2Vzcy5lbnYuTkVYVF9QVUJMSUNfVVNFUl9QT09MX0NMSUVOVF9JRCB8fCAnJyxcclxuICAgICAgaWRlbnRpdHlQb29sSWQ6IHByb2Nlc3MuZW52Lk5FWFRfUFVCTElDX0lERU5USVRZX1BPT0xfSUQgfHwgJycsXHJcbiAgICAgIGxvZ2luV2l0aDoge1xyXG4gICAgICAgIGVtYWlsOiB0cnVlLFxyXG4gICAgICAgIHVzZXJuYW1lOiB0cnVlLFxyXG4gICAgICB9LFxyXG4gICAgICBzaWduVXBWZXJpZmljYXRpb25NZXRob2Q6ICdjb2RlJyBhcyBjb25zdCxcclxuICAgICAgdXNlckF0dHJpYnV0ZXM6IHtcclxuICAgICAgICBlbWFpbDoge1xyXG4gICAgICAgICAgcmVxdWlyZWQ6IHRydWUsXHJcbiAgICAgICAgfSxcclxuICAgICAgICBnaXZlbl9uYW1lOiB7XHJcbiAgICAgICAgICByZXF1aXJlZDogdHJ1ZSxcclxuICAgICAgICB9LFxyXG4gICAgICAgIGZhbWlseV9uYW1lOiB7XHJcbiAgICAgICAgICByZXF1aXJlZDogdHJ1ZSxcclxuICAgICAgICB9LFxyXG4gICAgICB9LFxyXG4gICAgICBhbGxvd0d1ZXN0QWNjZXNzOiBmYWxzZSxcclxuICAgICAgcGFzc3dvcmRGb3JtYXQ6IHtcclxuICAgICAgICBtaW5MZW5ndGg6IDgsXHJcbiAgICAgICAgcmVxdWlyZUxvd2VyY2FzZTogdHJ1ZSxcclxuICAgICAgICByZXF1aXJlVXBwZXJjYXNlOiB0cnVlLFxyXG4gICAgICAgIHJlcXVpcmVOdW1iZXJzOiB0cnVlLFxyXG4gICAgICAgIHJlcXVpcmVTcGVjaWFsQ2hhcmFjdGVyczogdHJ1ZSxcclxuICAgICAgfSxcclxuICAgIH0sXHJcbiAgfSxcclxuICBBUEk6IHtcclxuICAgIFJFU1Q6IHtcclxuICAgICAgU3VwcGx5U2Vuc2VBUEk6IHtcclxuICAgICAgICBlbmRwb2ludDogcHJvY2Vzcy5lbnYuTkVYVF9QVUJMSUNfQVBJX0VORFBPSU5UIHx8ICcnLFxyXG4gICAgICAgIHJlZ2lvbjogcHJvY2Vzcy5lbnYuTkVYVF9QVUJMSUNfQVdTX1JFR0lPTiB8fCAndXMtZWFzdC0xJyxcclxuICAgICAgfSxcclxuICAgIH0sXHJcbiAgfSxcclxufTtcclxuXHJcbkFtcGxpZnkuY29uZmlndXJlKGFtcGxpZnlDb25maWcpO1xyXG5cclxuZXhwb3J0IGRlZmF1bHQgYW1wbGlmeUNvbmZpZzsiXX0=