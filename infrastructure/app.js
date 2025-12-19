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
const supplysense_agentcore_stack_1 = require("./stacks/supplysense-agentcore-stack");
const supplysense_chat_stack_1 = require("./stacks/supplysense-chat-stack");
const supplysense_tables_stack_1 = require("./stacks/supplysense-tables-stack");
const app = new cdk.App();
const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
};
// DynamoDB Tables
const tablesStack = new supplysense_tables_stack_1.SupplySenseTablesStack(app, 'SupplySenseTablesStack', { env });
// AgentCore layer (Real Bedrock Agents + Cognito)
const agentCoreStack = new supplysense_agentcore_stack_1.SupplySenseAgentCoreStack(app, 'SupplySenseAgentCoreStack', {
    env,
    apiUrl: 'https://api.supplysense.com',
});
// Chat orchestration layer (ECS Fargate service + UI)
const chatStack = new supplysense_chat_stack_1.SupplySenseChatStack(app, 'SupplySenseChatStack', {
    env,
    cognitoUserPoolId: agentCoreStack.cognitoUserPoolId,
    cognitoUserPoolClientId: agentCoreStack.cognitoUserPoolClientId,
});
// Add dependencies
agentCoreStack.addDependency(tablesStack);
chatStack.addDependency(agentCoreStack);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiYXBwLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUNBLHVDQUFxQztBQUNyQyxpREFBbUM7QUFDbkMsc0ZBQWlGO0FBQ2pGLDRFQUF1RTtBQUN2RSxnRkFBMkU7QUFFM0UsTUFBTSxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7QUFFMUIsTUFBTSxHQUFHLEdBQUc7SUFDVixPQUFPLEVBQUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxtQkFBbUI7SUFDeEMsTUFBTSxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsa0JBQWtCO0NBQ3ZDLENBQUM7QUFFRixrQkFBa0I7QUFDbEIsTUFBTSxXQUFXLEdBQUcsSUFBSSxpREFBc0IsQ0FBQyxHQUFHLEVBQUUsd0JBQXdCLEVBQUUsRUFBRSxHQUFHLEVBQUUsQ0FBQyxDQUFDO0FBRXZGLGtEQUFrRDtBQUNsRCxNQUFNLGNBQWMsR0FBRyxJQUFJLHVEQUF5QixDQUFDLEdBQUcsRUFBRSwyQkFBMkIsRUFBRTtJQUNyRixHQUFHO0lBQ0gsTUFBTSxFQUFFLDZCQUE2QjtDQUN0QyxDQUFDLENBQUM7QUFFSCxzREFBc0Q7QUFDdEQsTUFBTSxTQUFTLEdBQUcsSUFBSSw2Q0FBb0IsQ0FBQyxHQUFHLEVBQUUsc0JBQXNCLEVBQUU7SUFDdEUsR0FBRztJQUNILGlCQUFpQixFQUFFLGNBQWMsQ0FBQyxpQkFBaUI7SUFDbkQsdUJBQXVCLEVBQUUsY0FBYyxDQUFDLHVCQUF1QjtDQUNoRSxDQUFDLENBQUM7QUFFSCxtQkFBbUI7QUFDbkIsY0FBYyxDQUFDLGFBQWEsQ0FBQyxXQUFXLENBQUMsQ0FBQztBQUMxQyxTQUFTLENBQUMsYUFBYSxDQUFDLGNBQWMsQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiIyEvdXNyL2Jpbi9lbnYgbm9kZVxyXG5pbXBvcnQgJ3NvdXJjZS1tYXAtc3VwcG9ydC9yZWdpc3Rlcic7XHJcbmltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XHJcbmltcG9ydCB7IFN1cHBseVNlbnNlQWdlbnRDb3JlU3RhY2sgfSBmcm9tICcuL3N0YWNrcy9zdXBwbHlzZW5zZS1hZ2VudGNvcmUtc3RhY2snO1xyXG5pbXBvcnQgeyBTdXBwbHlTZW5zZUNoYXRTdGFjayB9IGZyb20gJy4vc3RhY2tzL3N1cHBseXNlbnNlLWNoYXQtc3RhY2snO1xyXG5pbXBvcnQgeyBTdXBwbHlTZW5zZVRhYmxlc1N0YWNrIH0gZnJvbSAnLi9zdGFja3Mvc3VwcGx5c2Vuc2UtdGFibGVzLXN0YWNrJztcclxuXHJcbmNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XHJcblxyXG5jb25zdCBlbnYgPSB7XHJcbiAgYWNjb3VudDogcHJvY2Vzcy5lbnYuQ0RLX0RFRkFVTFRfQUNDT1VOVCxcclxuICByZWdpb246IHByb2Nlc3MuZW52LkNES19ERUZBVUxUX1JFR0lPTixcclxufTtcclxuXHJcbi8vIER5bmFtb0RCIFRhYmxlc1xyXG5jb25zdCB0YWJsZXNTdGFjayA9IG5ldyBTdXBwbHlTZW5zZVRhYmxlc1N0YWNrKGFwcCwgJ1N1cHBseVNlbnNlVGFibGVzU3RhY2snLCB7IGVudiB9KTtcclxuXHJcbi8vIEFnZW50Q29yZSBsYXllciAoUmVhbCBCZWRyb2NrIEFnZW50cyArIENvZ25pdG8pXHJcbmNvbnN0IGFnZW50Q29yZVN0YWNrID0gbmV3IFN1cHBseVNlbnNlQWdlbnRDb3JlU3RhY2soYXBwLCAnU3VwcGx5U2Vuc2VBZ2VudENvcmVTdGFjaycsIHtcclxuICBlbnYsXHJcbiAgYXBpVXJsOiAnaHR0cHM6Ly9hcGkuc3VwcGx5c2Vuc2UuY29tJyxcclxufSk7XHJcblxyXG4vLyBDaGF0IG9yY2hlc3RyYXRpb24gbGF5ZXIgKEVDUyBGYXJnYXRlIHNlcnZpY2UgKyBVSSlcclxuY29uc3QgY2hhdFN0YWNrID0gbmV3IFN1cHBseVNlbnNlQ2hhdFN0YWNrKGFwcCwgJ1N1cHBseVNlbnNlQ2hhdFN0YWNrJywge1xyXG4gIGVudixcclxuICBjb2duaXRvVXNlclBvb2xJZDogYWdlbnRDb3JlU3RhY2suY29nbml0b1VzZXJQb29sSWQsXHJcbiAgY29nbml0b1VzZXJQb29sQ2xpZW50SWQ6IGFnZW50Q29yZVN0YWNrLmNvZ25pdG9Vc2VyUG9vbENsaWVudElkLFxyXG59KTtcclxuXHJcbi8vIEFkZCBkZXBlbmRlbmNpZXNcclxuYWdlbnRDb3JlU3RhY2suYWRkRGVwZW5kZW5jeSh0YWJsZXNTdGFjayk7XHJcbmNoYXRTdGFjay5hZGREZXBlbmRlbmN5KGFnZW50Q29yZVN0YWNrKTsiXX0=