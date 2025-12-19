#!/bin/bash

# Setup AWS AgentCore SDK for SupplySense
echo "Setting up AWS AgentCore SDK..."

# Create vendor directory
mkdir -p vendor

# Clone AWS AgentCore SDK from GitHub
cd vendor
if [ -d "bedrock-agentcore-sdk-python" ]; then
    echo "AgentCore SDK already exists, updating..."
    cd bedrock-agentcore-sdk-python
    git pull
    cd ..
else
    echo "Cloning AWS AgentCore SDK..."
    git clone https://github.com/aws/bedrock-agentcore-sdk-python.git
fi

# Return to project root
cd ..

echo "✅ AgentCore SDK setup complete!"
echo "SDK location: vendor/bedrock-agentcore-sdk-python"