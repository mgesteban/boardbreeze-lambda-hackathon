#!/bin/bash

# BoardBreeze Audio Splitter Lambda Deployment Script
# This script deploys the Lambda function to AWS

set -e

# Configuration
FUNCTION_NAME="boardbreeze-audio-splitter"
RUNTIME="nodejs18.x"
HANDLER="index.handler"
MEMORY_SIZE=3008
TIMEOUT=900
DESCRIPTION="BoardBreeze audio splitter for large files exceeding AWS Transcribe limits"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting BoardBreeze Lambda deployment...${NC}"

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo -e "${RED}Error: AWS CLI is not installed${NC}"
    exit 1
fi

# Check if AWS credentials are configured
if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}Error: AWS credentials not configured${NC}"
    exit 1
fi

# Get AWS account ID and region
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region)

if [ -z "$REGION" ]; then
    REGION="us-east-2"
    echo -e "${YELLOW}No region configured, using default: $REGION${NC}"
fi

echo -e "${GREEN}Deploying to account: $ACCOUNT_ID in region: $REGION${NC}"

# Install dependencies
echo -e "${GREEN}Installing dependencies...${NC}"
npm install

# Create deployment package
echo -e "${GREEN}Creating deployment package...${NC}"
zip -r ${FUNCTION_NAME}.zip index.js node_modules/ package.json

# Check if function exists
FUNCTION_EXISTS=$(aws lambda get-function --function-name $FUNCTION_NAME --region $REGION 2>/dev/null || echo "false")

if [ "$FUNCTION_EXISTS" != "false" ]; then
    echo -e "${YELLOW}Function exists, updating code...${NC}"
    
    # Update function code
    aws lambda update-function-code \
        --function-name $FUNCTION_NAME \
        --zip-file fileb://${FUNCTION_NAME}.zip \
        --region $REGION
    
    # Update function configuration
    aws lambda update-function-configuration \
        --function-name $FUNCTION_NAME \
        --runtime $RUNTIME \
        --handler $HANDLER \
        --memory-size $MEMORY_SIZE \
        --timeout $TIMEOUT \
        --description "$DESCRIPTION" \
        --region $REGION
        
    echo -e "${GREEN}Function updated successfully!${NC}"
else
    echo -e "${GREEN}Creating new function...${NC}"
    
    # Create IAM role if it doesn't exist
    ROLE_NAME="${FUNCTION_NAME}-execution-role"
    ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"
    
    # Check if role exists
    if ! aws iam get-role --role-name $ROLE_NAME &> /dev/null; then
        echo -e "${GREEN}Creating IAM role...${NC}"
        
        # Create trust policy
        cat > trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

        # Create role
        aws iam create-role \
            --role-name $ROLE_NAME \
            --assume-role-policy-document file://trust-policy.json
        
        # Attach basic execution policy
        aws iam attach-role-policy \
            --role-name $ROLE_NAME \
            --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
        
        # Create and attach S3 and Transcribe policy
        cat > lambda-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::*/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "transcribe:StartTranscriptionJob",
        "transcribe:GetTranscriptionJob",
        "transcribe:ListTranscriptionJobs"
      ],
      "Resource": "*"
    }
  ]
}
EOF

        aws iam put-role-policy \
            --role-name $ROLE_NAME \
            --policy-name "${FUNCTION_NAME}-policy" \
            --policy-document file://lambda-policy.json
        
        # Wait for role to be available
        echo -e "${YELLOW}Waiting for IAM role to be available...${NC}"
        sleep 10
        
        # Clean up policy files
        rm trust-policy.json lambda-policy.json
    fi
    
    # Create Lambda function
    aws lambda create-function \
        --function-name $FUNCTION_NAME \
        --runtime $RUNTIME \
        --role $ROLE_ARN \
        --handler $HANDLER \
        --zip-file fileb://${FUNCTION_NAME}.zip \
        --memory-size $MEMORY_SIZE \
        --timeout $TIMEOUT \
        --description "$DESCRIPTION" \
        --region $REGION
        
    echo -e "${GREEN}Function created successfully!${NC}"
fi

# Clean up
rm ${FUNCTION_NAME}.zip

# Get function information
echo -e "${GREEN}Function details:${NC}"
aws lambda get-function --function-name $FUNCTION_NAME --region $REGION --query 'Configuration.[FunctionName,Runtime,MemorySize,Timeout,LastModified]' --output table

echo -e "${GREEN}Deployment completed successfully!${NC}"
echo -e "${YELLOW}Function ARN: arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}${NC}"

# Test function (optional)
read -p "Do you want to test the function with a sample event? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${GREEN}Testing function...${NC}"
    
    # Create test event
    cat > test-event.json << EOF
{
  "s3Key": "test-audio.mp3",
  "bucketName": "your-test-bucket"
}
EOF

    aws lambda invoke \
        --function-name $FUNCTION_NAME \
        --payload file://test-event.json \
        --region $REGION \
        response.json
    
    echo -e "${GREEN}Test response:${NC}"
    cat response.json
    echo
    
    # Clean up test files
    rm test-event.json response.json
fi

echo -e "${GREEN}All done! Your Lambda function is ready to process audio files.${NC}"
