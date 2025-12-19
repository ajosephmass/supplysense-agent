#!/usr/bin/env node
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
require("source-map-support/register");
const cdk = __importStar(require("aws-cdk-lib"));
const supplysense_stack_1 = require("./stacks/supplysense-stack");
const supplysense_agentcore_stack_1 = require("./stacks/supplysense-agentcore-stack");
const supplysense_chat_stack_1 = require("./stacks/supplysense-chat-stack");
const supplysense_tables_stack_1 = require("./stacks/supplysense-tables-stack");
const app = new cdk.App();
const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
};
// Data layer (DynamoDB tables, Cognito, API Gateway)
const dataStack = new supplysense_stack_1.SupplySenseStack(app, 'SupplySenseStack', { env });
// DynamoDB Tables
const tablesStack = new supplysense_tables_stack_1.SupplySenseTablesStack(app, 'SupplySenseTablesStack', { env });
// AgentCore layer (Real Bedrock Agents)
const agentCoreStack = new supplysense_agentcore_stack_1.SupplySenseAgentCoreStack(app, 'SupplySenseAgentCoreStack', {
    env,
    apiUrl: 'https://api.supplysense.com',
});
// Chat orchestration layer (ECS Fargate service)
const chatStack = new supplysense_chat_stack_1.SupplySenseChatStack(app, 'SupplySenseChatStack', {
    env,
    cognitoUserPoolId: agentCoreStack.cognitoUserPoolId,
    cognitoUserPoolClientId: agentCoreStack.cognitoUserPoolClientId,
});
// Add dependencies
agentCoreStack.addDependency(dataStack);
agentCoreStack.addDependency(tablesStack);
chatStack.addDependency(agentCoreStack);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYXBwLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUNBLHVDQUFxQztBQUNyQyxpREFBbUM7QUFDbkMsa0VBQThEO0FBQzlELHNGQUFpRjtBQUNqRiw0RUFBdUU7QUFDdkUsZ0ZBQTJFO0FBRTNFLE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO0FBRTFCLE1BQU0sR0FBRyxHQUFHO0lBQ1YsT0FBTyxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW1CO0lBQ3hDLE1BQU0sRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLGtCQUFrQjtDQUN2QyxDQUFDO0FBRUYscURBQXFEO0FBQ3JELE1BQU0sU0FBUyxHQUFHLElBQUksb0NBQWdCLENBQUMsR0FBRyxFQUFFLGtCQUFrQixFQUFFLEVBQUUsR0FBRyxFQUFFLENBQUMsQ0FBQztBQUV6RSxrQkFBa0I7QUFDbEIsTUFBTSxXQUFXLEdBQUcsSUFBSSxpREFBc0IsQ0FBQyxHQUFHLEVBQUUsd0JBQXdCLEVBQUUsRUFBRSxHQUFHLEVBQUUsQ0FBQyxDQUFDO0FBRXZGLHdDQUF3QztBQUN4QyxNQUFNLGNBQWMsR0FBRyxJQUFJLHVEQUF5QixDQUFDLEdBQUcsRUFBRSwyQkFBMkIsRUFBRTtJQUNyRixHQUFHO0lBQ0gsTUFBTSxFQUFFLDZCQUE2QjtDQUN0QyxDQUFDLENBQUM7QUFFSCxpREFBaUQ7QUFDakQsTUFBTSxTQUFTLEdBQUcsSUFBSSw2Q0FBb0IsQ0FBQyxHQUFHLEVBQUUsc0JBQXNCLEVBQUU7SUFDdEUsR0FBRztJQUNILGlCQUFpQixFQUFFLGNBQWMsQ0FBQyxpQkFBaUI7SUFDbkQsdUJBQXVCLEVBQUUsY0FBYyxDQUFDLHVCQUF1QjtDQUNoRSxDQUFDLENBQUM7QUFFSCxtQkFBbUI7QUFDbkIsY0FBYyxDQUFDLGFBQWEsQ0FBQyxTQUFTLENBQUMsQ0FBQztBQUN4QyxjQUFjLENBQUMsYUFBYSxDQUFDLFdBQVcsQ0FBQyxDQUFDO0FBQzFDLFNBQVMsQ0FBQyxhQUFhLENBQUMsY0FBYyxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIjIS91c3IvYmluL2VudiBub2RlXHJcbmltcG9ydCAnc291cmNlLW1hcC1zdXBwb3J0L3JlZ2lzdGVyJztcclxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcclxuaW1wb3J0IHsgU3VwcGx5U2Vuc2VTdGFjayB9IGZyb20gJy4vc3RhY2tzL3N1cHBseXNlbnNlLXN0YWNrJztcclxuaW1wb3J0IHsgU3VwcGx5U2Vuc2VBZ2VudENvcmVTdGFjayB9IGZyb20gJy4vc3RhY2tzL3N1cHBseXNlbnNlLWFnZW50Y29yZS1zdGFjayc7XHJcbmltcG9ydCB7IFN1cHBseVNlbnNlQ2hhdFN0YWNrIH0gZnJvbSAnLi9zdGFja3Mvc3VwcGx5c2Vuc2UtY2hhdC1zdGFjayc7XHJcbmltcG9ydCB7IFN1cHBseVNlbnNlVGFibGVzU3RhY2sgfSBmcm9tICcuL3N0YWNrcy9zdXBwbHlzZW5zZS10YWJsZXMtc3RhY2snO1xyXG5cclxuY29uc3QgYXBwID0gbmV3IGNkay5BcHAoKTtcclxuXHJcbmNvbnN0IGVudiA9IHtcclxuICBhY2NvdW50OiBwcm9jZXNzLmVudi5DREtfREVGQVVMVF9BQ0NPVU5ULFxyXG4gIHJlZ2lvbjogcHJvY2Vzcy5lbnYuQ0RLX0RFRkFVTFRfUkVHSU9OLFxyXG59O1xyXG5cclxuLy8gRGF0YSBsYXllciAoRHluYW1vREIgdGFibGVzLCBDb2duaXRvLCBBUEkgR2F0ZXdheSlcclxuY29uc3QgZGF0YVN0YWNrID0gbmV3IFN1cHBseVNlbnNlU3RhY2soYXBwLCAnU3VwcGx5U2Vuc2VTdGFjaycsIHsgZW52IH0pO1xyXG5cclxuLy8gRHluYW1vREIgVGFibGVzXHJcbmNvbnN0IHRhYmxlc1N0YWNrID0gbmV3IFN1cHBseVNlbnNlVGFibGVzU3RhY2soYXBwLCAnU3VwcGx5U2Vuc2VUYWJsZXNTdGFjaycsIHsgZW52IH0pO1xyXG5cclxuLy8gQWdlbnRDb3JlIGxheWVyIChSZWFsIEJlZHJvY2sgQWdlbnRzKVxyXG5jb25zdCBhZ2VudENvcmVTdGFjayA9IG5ldyBTdXBwbHlTZW5zZUFnZW50Q29yZVN0YWNrKGFwcCwgJ1N1cHBseVNlbnNlQWdlbnRDb3JlU3RhY2snLCB7XHJcbiAgZW52LFxyXG4gIGFwaVVybDogJ2h0dHBzOi8vYXBpLnN1cHBseXNlbnNlLmNvbScsXHJcbn0pO1xyXG5cclxuLy8gQ2hhdCBvcmNoZXN0cmF0aW9uIGxheWVyIChFQ1MgRmFyZ2F0ZSBzZXJ2aWNlKVxyXG5jb25zdCBjaGF0U3RhY2sgPSBuZXcgU3VwcGx5U2Vuc2VDaGF0U3RhY2soYXBwLCAnU3VwcGx5U2Vuc2VDaGF0U3RhY2snLCB7XHJcbiAgZW52LFxyXG4gIGNvZ25pdG9Vc2VyUG9vbElkOiBhZ2VudENvcmVTdGFjay5jb2duaXRvVXNlclBvb2xJZCxcclxuICBjb2duaXRvVXNlclBvb2xDbGllbnRJZDogYWdlbnRDb3JlU3RhY2suY29nbml0b1VzZXJQb29sQ2xpZW50SWQsXHJcbn0pO1xyXG5cclxuLy8gQWRkIGRlcGVuZGVuY2llc1xyXG5hZ2VudENvcmVTdGFjay5hZGREZXBlbmRlbmN5KGRhdGFTdGFjayk7XHJcbmFnZW50Q29yZVN0YWNrLmFkZERlcGVuZGVuY3kodGFibGVzU3RhY2spO1xyXG5jaGF0U3RhY2suYWRkRGVwZW5kZW5jeShhZ2VudENvcmVTdGFjayk7Il19