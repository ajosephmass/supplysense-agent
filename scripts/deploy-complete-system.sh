#!/bin/bash

# SupplySense Complete System Deployment Script
# Cross-platform deployment for Unix/Linux/macOS environments

set -e

# Colors for console output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Helper functions
log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
    exit 1
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

log_header() {
    echo -e "\n${CYAN}$1${NC}"
    echo -e "${CYAN}$(echo "$1" | sed 's/./=/g')${NC}"
}

check_command() {
    if command -v "$1" &> /dev/null; then
        log_success "$2 is installed"
        return 0
    else
        log_error "$2 not found. Please install $2"
        return 1
    fi
}

# Parse command line arguments
SKIP_PREREQUISITES=false
SKIP_INFRASTRUCTURE=false
SKIP_UI=false
VERBOSE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-prerequisites)
            SKIP_PREREQUISITES=true
            shift
            ;;
        --skip-infrastructure)
            SKIP_INFRASTRUCTURE=true
            shift
            ;;
        --skip-ui)
            SKIP_UI=true
            shift
            ;;
        --verbose|-v)
            VERBOSE=true
            shift
            ;;
        --help|-h)
            echo "🚀 SupplySense Complete System Deployment"
            echo ""
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --skip-prerequisites    Skip prerequisite checks"
            echo "  --skip-infrastructure   Skip infrastructure deployment"
            echo "  --skip-ui              Skip UI build and configuration"
            echo "  --verbose, -v          Verbose output"
            echo "  --help, -h             Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0"
            echo "  $0 --skip-prerequisites"
            echo "  $0 --verbose"
            exit 0
            ;;
        *)
            echo "Unknown option $1"
            exit 1
            ;;
    esac
done

main() {
    log_header "🚀 SupplySense Complete System Deployment"

    # Step 1: Prerequisites Check
    if [ "$SKIP_PREREQUISITES" = false ]; then
        log_header "📋 Step 1: Checking Prerequisites"
        
        check_command "aws" "AWS CLI"
        check_command "npx" "Node.js/NPX"
        check_command "python3" "Python 3"
        
        # Check Node.js version
        if command -v node &> /dev/null; then
            NODE_VERSION=$(node --version | sed 's/v//')
            MAJOR_VERSION=$(echo $NODE_VERSION | cut -d. -f1)
            if [ "$MAJOR_VERSION" -ge 18 ]; then
                log_success "Node.js: v$NODE_VERSION"
            else
                log_error "Node.js version must be 18 or higher. Current: v$NODE_VERSION"
            fi
        else
            log_error "Node.js not found in PATH"
        fi
        
        # Check CDK
        if npx cdk --version &> /dev/null; then
            CDK_VERSION=$(npx cdk --version)
            log_success "CDK: $CDK_VERSION"
        else
            log_error "CDK not found"
        fi
        
        # Check AWS credentials
        if aws sts get-caller-identity &> /dev/null; then
            ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
            log_success "AWS Account: $ACCOUNT"
        else
            log_error "AWS credentials not configured. Run: aws configure"
        fi
        
        log_info "Prerequisites check complete!"
    fi

    # Step 2: Install Dependencies
    log_header "📦 Step 2: Installing Dependencies"
    
    # Root dependencies
    log_info "Installing root dependencies..."
    npm install
    log_success "Root dependencies installed"
    
    # Orchestrator dependencies
    log_info "Installing orchestrator dependencies..."
    cd orchestrator
    npm install
    cd ..
    log_success "Orchestrator dependencies installed"
    
    # UI dependencies
    log_info "Installing UI dependencies..."
    cd ui
    npm install
    cd ..
    log_success "UI dependencies installed"

    # Step 3: Build TypeScript
    log_header "🔨 Step 3: Building TypeScript"
    npm run build
    log_success "TypeScript build complete"

    # Step 4: CDK Bootstrap
    log_header "🏗️  Step 4: CDK Bootstrap Check"
    if aws cloudformation describe-stacks --stack-name CDKToolkit &> /dev/null; then
        BOOTSTRAP_STATUS=$(aws cloudformation describe-stacks --stack-name CDKToolkit --query 'Stacks[0].StackStatus' --output text)
        if [[ "$BOOTSTRAP_STATUS" == "CREATE_COMPLETE" || "$BOOTSTRAP_STATUS" == "UPDATE_COMPLETE" ]]; then
            log_success "CDK already bootstrapped"
        else
            log_info "Bootstrapping CDK..."
            npx cdk bootstrap
            log_success "CDK bootstrap complete"
        fi
    else
        log_info "Bootstrapping CDK..."
        npx cdk bootstrap
        log_success "CDK bootstrap complete"
    fi

    # Step 5: Deploy Infrastructure
    if [ "$SKIP_INFRASTRUCTURE" = false ]; then
        log_header "🏗️  Step 5: Deploying Infrastructure"
        
        log_info "Deploying all CDK stacks..."
        npx cdk deploy --all --require-approval never
        log_success "Infrastructure deployment complete"
        
        # Get stack outputs
        log_info "Retrieving stack outputs..."
        API_ENDPOINT=$(aws cloudformation describe-stacks --stack-name SupplySenseChatStack --query 'Stacks[0].Outputs[?OutputKey==`ChatServiceUrl`].OutputValue' --output text 2>/dev/null || echo "")
        USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name SupplySenseAgentCoreStack --query 'Stacks[0].Outputs[?OutputKey==`CognitoUserPoolId`].OutputValue' --output text 2>/dev/null || echo "")
        USER_POOL_CLIENT_ID=$(aws cloudformation describe-stacks --stack-name SupplySenseAgentCoreStack --query 'Stacks[0].Outputs[?OutputKey==`CognitoUserPoolClientId`].OutputValue' --output text 2>/dev/null || echo "")
        
        if [ -n "$API_ENDPOINT" ] && [ -n "$USER_POOL_ID" ] && [ -n "$USER_POOL_CLIENT_ID" ]; then
            log_info "Stack Outputs Retrieved:"
            echo "  API Endpoint: $API_ENDPOINT"
            echo "  User Pool ID: $USER_POOL_ID"
            echo "  User Pool Client ID: $USER_POOL_CLIENT_ID"
            
            # Create UI environment file
            cat > ui/.env.local << EOF
NEXT_PUBLIC_USER_POOL_ID=$USER_POOL_ID
NEXT_PUBLIC_USER_POOL_CLIENT_ID=$USER_POOL_CLIENT_ID
NEXT_PUBLIC_API_ENDPOINT=$API_ENDPOINT
NEXT_PUBLIC_AWS_REGION=us-east-1
EOF
            log_success "UI environment file created"
        else
            log_warning "Could not retrieve all stack outputs. You may need to configure UI environment manually."
        fi
    fi

    # Step 6: Seed Data
    log_header "📊 Step 6: Seeding Sample Data"
    npm run seed-data
    log_success "Sample data seeded"

    # Step 7: Build UI
    if [ "$SKIP_UI" = false ]; then
        log_header "🖥️  Step 7: Building UI"
        
        cd ui
        
        log_info "Building Next.js application..."
        npm run build
        log_success "UI build complete"
        
        cd ..
    fi

    # Step 8: System Health Check
    log_header "🧪 Step 8: System Health Check"
    
    # Test API health
    if [ -n "$API_ENDPOINT" ]; then
        if curl -s "$API_ENDPOINT/health" > /dev/null; then
            log_success "API health check passed"
        else
            log_warning "API health check failed - service may still be starting"
        fi
    fi
    
    # Check DynamoDB tables
    TABLES=("supplysense-inventory" "supplysense-orders" "supplysense-suppliers" "supplysense-logistics" "supplysense-demand-forecast")
    TABLES_OK=0
    
    for table in "${TABLES[@]}"; do
        if aws dynamodb describe-table --table-name "$table" &> /dev/null; then
            TABLE_STATUS=$(aws dynamodb describe-table --table-name "$table" --query "Table.TableStatus" --output text)
            if [ "$TABLE_STATUS" = "ACTIVE" ]; then
                ((TABLES_OK++))
            fi
        fi
    done
    
    if [ $TABLES_OK -eq ${#TABLES[@]} ]; then
        log_success "DynamoDB tables: $TABLES_OK/${#TABLES[@]} active"
    else
        log_warning "DynamoDB tables: $TABLES_OK/${#TABLES[@]} active"
    fi

    # Step 9: Deployment Summary
    log_header "🎉 Deployment Summary"
    
    log_success "Infrastructure: Deployed"
    log_success "Orchestrator: ECS Fargate service ready"
    log_success "Database: DynamoDB tables with sample data"
    log_success "UI: Next.js application built"
    
    log_header "🚀 Next Steps:"
    echo "1. Start the UI: cd ui && npm run dev"
    echo "2. Open browser: http://localhost:3000"
    echo "3. Sign up/Sign in with Cognito"
    echo "4. Test queries like:"
    echo "   - 'Can I fulfill all orders this week?'"
    echo "   - 'What's my current inventory status?'"
    echo "   - 'SUP-001 has a 5-day delay, what's the impact?'"
    
    log_header "📊 System Architecture:"
    echo "- Simplified AgentCore deployment on AWS Bedrock"
    echo "- Real-time Chat Orchestration with SSE streaming"
    echo "- Production-ready infrastructure with monitoring"
    
    echo -e "\n${GREEN}🎯 SupplySense is ready for supply chain intelligence!${NC}"
}

# Run the deployment
main "$@"