#!/bin/sh

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Auth credentials
AUTH="-u elastic:${ELASTIC_PASSWORD}"

echo "${GREEN}Starting Elasticsearch setup...${NC}"

# Wait for Elasticsearch to be ready
echo "${YELLOW}Waiting for Elasticsearch...${NC}"
until curl -s ${AUTH} "${ELASTICSEARCH_URL}/_cluster/health" > /dev/null; do
  echo "Waiting for Elasticsearch to be ready..."
  sleep 2
done
echo "${GREEN}Elasticsearch is ready!${NC}"

# Set kibana_system user password for Kibana
echo "${YELLOW}Setting kibana_system password...${NC}"
curl -s -X POST ${AUTH} "${ELASTICSEARCH_URL}/_security/user/kibana_system/_password" \
  -H 'Content-Type: application/json' \
  -d "{\"password\": \"${ELASTIC_PASSWORD}\"}" > /dev/null
echo "${GREEN}kibana_system password set${NC}"

# Function to check if inference endpoint exists
check_inference_endpoint() {
  response=$(curl -s -o /dev/null -w "%{http_code}" ${AUTH} \
    "${ELASTICSEARCH_URL}/_inference/text_embedding/${INFERENCE_ID}")

  if [ "$response" = "200" ]; then
    return 0
  else
    return 1
  fi
}

# Function to check if pipeline exists
check_pipeline() {
  response=$(curl -s -o /dev/null -w "%{http_code}" ${AUTH} \
    "${ELASTICSEARCH_URL}/_ingest/pipeline/${PIPELINE_ID}")

  if [ "$response" = "200" ]; then
    return 0
  else
    return 1
  fi
}

# Function to check if index exists
check_index() {
  response=$(curl -s -o /dev/null -w "%{http_code}" ${AUTH} \
    "${ELASTICSEARCH_URL}/${INDEX_NAME}")

  if [ "$response" = "200" ]; then
    return 0
  else
    return 1
  fi
}

# 1. Create Inference Endpoint
echo "${YELLOW}Checking inference endpoint...${NC}"
if check_inference_endpoint; then
  echo "${GREEN}Inference endpoint '${INFERENCE_ID}' already exists${NC}"
else
  echo "${YELLOW}Creating inference endpoint '${INFERENCE_ID}'...${NC}"

  curl -X PUT ${AUTH} "${ELASTICSEARCH_URL}/_inference/text_embedding/${INFERENCE_ID}" \
    -H 'Content-Type: application/json' \
    -d "{
      \"service\": \"openai\",
      \"service_settings\": {
        \"api_key\": \"${OPENROUTER_API_KEY}\",
        \"url\": \"https://openrouter.ai/api/v1/embeddings\",
        \"model_id\": \"${MODEL_ID}\"
      }
    }"

  if [ $? -eq 0 ]; then
    echo ""
    echo "${GREEN}Inference endpoint created successfully${NC}"
  else
    echo "${RED}Failed to create inference endpoint${NC}"
    exit 1
  fi
fi

# 2. Create Ingest Pipeline
echo "${YELLOW}Checking ingest pipeline...${NC}"
if check_pipeline; then
  echo "${GREEN}Pipeline '${PIPELINE_ID}' already exists${NC}"
else
  echo "${YELLOW}Creating ingest pipeline '${PIPELINE_ID}'...${NC}"

  curl -X PUT ${AUTH} "${ELASTICSEARCH_URL}/_ingest/pipeline/${PIPELINE_ID}" \
    -H 'Content-Type: application/json' \
    -d "{
      \"description\": \"OpenRouter embedding pipeline\",
      \"processors\": [
        {
          \"inference\": {
            \"model_id\": \"${INFERENCE_ID}\",
            \"input_output\": {
              \"input_field\": \"content\",
              \"output_field\": \"content_embedding\"
            }
          }
        }
      ]
    }"

  if [ $? -eq 0 ]; then
    echo ""
    echo "${GREEN}Pipeline created successfully${NC}"
  else
    echo "${RED}Failed to create pipeline${NC}"
    exit 1
  fi
fi

# 3. Create Index
echo "${YELLOW}Checking index...${NC}"
if check_index; then
  echo "${GREEN}Index '${INDEX_NAME}' already exists${NC}"
else
  echo "${YELLOW}Creating index '${INDEX_NAME}'...${NC}"

  curl -X PUT ${AUTH} "${ELASTICSEARCH_URL}/${INDEX_NAME}" \
    -H 'Content-Type: application/json' \
    -d "{
      \"settings\": {
        \"number_of_shards\": 1,
        \"number_of_replicas\": 0
      },
      \"mappings\": {
        \"properties\": {
          \"user_id\": {
            \"type\": \"keyword\"
          },
          \"client_id\": {
            \"type\": \"keyword\"
          },
          \"chat_id\": {
            \"type\": \"keyword\"
          },
          \"message_id\": {
            \"type\": \"keyword\"
          },
          \"sender_id\": {
            \"type\": \"keyword\"
          },
          \"sender_name\": {
            \"type\": \"text\"
          },
          \"content\": {
            \"type\": \"text\"
          },
          \"content_embedding\": {
            \"type\": \"dense_vector\",
            \"dims\": ${EMBEDDING_DIMS},
            \"index\": true,
            \"similarity\": \"cosine\"
          },
          \"created_at\": {
            \"type\": \"date\"
          }
        }
      }
    }"

  if [ $? -eq 0 ]; then
    echo ""
    echo "${GREEN}Index created successfully${NC}"
  else
    echo "${RED}Failed to create index${NC}"
    exit 1
  fi
fi

echo "${GREEN}Setup completed successfully!${NC}"

# Optional: Index test documents
echo "${YELLOW}Indexing test documents...${NC}"
curl -s -X POST ${AUTH} "${ELASTICSEARCH_URL}/${INDEX_NAME}/_doc?pipeline=${PIPELINE_ID}" \
  -H 'Content-Type: application/json' \
  -d '{
    "user_id": "user-123",
    "client_id": "client-456",
    "chat_id": "chat-789",
    "message_id": "msg-001",
    "sender_id": "sender-abc",
    "sender_name": "John Doe",
    "content": "Hey, lets meet tomorrow at 3pm to discuss the project proposal.",
    "created_at": "2024-01-19T12:00:00Z"
  }' > /dev/null

curl -s -X POST ${AUTH} "${ELASTICSEARCH_URL}/${INDEX_NAME}/_doc?pipeline=${PIPELINE_ID}" \
  -H 'Content-Type: application/json' \
  -d '{
    "user_id": "user-123",
    "client_id": "client-456",
    "chat_id": "chat-789",
    "message_id": "msg-002",
    "sender_id": "sender-xyz",
    "sender_name": "Jane Smith",
    "content": "Sure, I will prepare the budget estimates by then.",
    "created_at": "2024-01-19T12:05:00Z"
  }' > /dev/null

curl -s -X POST ${AUTH} "${ELASTICSEARCH_URL}/${INDEX_NAME}/_doc?pipeline=${PIPELINE_ID}" \
  -H 'Content-Type: application/json' \
  -d '{
    "user_id": "user-123",
    "client_id": "client-999",
    "chat_id": "chat-111",
    "message_id": "msg-003",
    "sender_id": "sender-def",
    "sender_name": "Bob Wilson",
    "content": "The server deployment is scheduled for next week Monday.",
    "created_at": "2024-01-19T14:00:00Z"
  }' > /dev/null

echo "${GREEN}Test documents indexed${NC}"

echo ""
echo "${GREEN}All done! You can now use the index.${NC}"
echo ""
echo "Example queries:"
echo "  - Search all messages for a user: POST /${INDEX_NAME}/_search with filter on user_id"
echo "  - Search within a chat: POST /${INDEX_NAME}/_search with filter on chat_id"
echo "  - Semantic search with filter: Use knn query with filter clause"
