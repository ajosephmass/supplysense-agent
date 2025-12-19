# SupplySense UI

Next.js React application for the SupplySense chat interface.

## Features

- Real-time streaming responses via Server-Sent Events (SSE)
- Agent highlights and detailed insights display
- Action execution with status tracking
- Approval workflow (approve/reject)
- Cognito authentication

## Technology Stack

- **Framework**: Next.js 14 (static export)
- **Styling**: Tailwind CSS
- **Authentication**: AWS Amplify (Cognito)
- **Hosting**: S3 + CloudFront

## Local Development

```bash
cd ui
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Environment Variables

Create `.env.local` for local development:

```
NEXT_PUBLIC_USER_POOL_ID=us-east-1_xxxxx
NEXT_PUBLIC_USER_POOL_CLIENT_ID=xxxxx
NEXT_PUBLIC_API_ENDPOINT=/api
NEXT_PUBLIC_AWS_REGION=us-east-1
```

## Building for Production

```bash
npm run build
```

This creates a static export in the `out/` directory.

## Deployment

The UI is deployed via CDK/CodeBuild:

```bash
npx cdk deploy SupplySenseChatStack
```

Or manually:

```bash
npm run build
aws s3 sync out/ s3://<UI_BUCKET_NAME> --delete
aws cloudfront create-invalidation --distribution-id <DIST_ID> --paths "/*"
```

## Project Structure

```
ui/
├── pages/
│   └── index.tsx        # Main chat interface
├── lib/
│   └── amplify-config.ts # Cognito configuration
├── styles/
│   └── globals.css      # Tailwind styles
├── public/              # Static assets
├── next.config.js       # Next.js configuration
└── package.json
```

## Key Components

### Chat Interface
- Message input and send functionality
- Streaming response display
- Agent status indicators

### Analysis Results
- Summary section with key metrics
- Agent highlights (2-3 sentence summaries)
- Agent insights (detailed analysis)
- Blockers and recommendations

### Workflow Actions
- Action items with "Mark Complete" buttons
- Approval requests with Approve/Reject buttons
- Status tracking and notifications

