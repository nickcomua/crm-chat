import type { Document } from "@langchain/core/documents";
import { OpenAIEmbeddings } from "@langchain/openai";
import { QdrantVectorStore } from "@langchain/qdrant";
import { QdrantClient } from "@qdrant/qdrant-js";

let vectorStore: QdrantVectorStore | null = null;
let embeddings: OpenAIEmbeddings | null = null;
let client: QdrantClient | null = null;

/**
 * Initialize Qdrant client and vector store
 */
async function getVectorStore(): Promise<QdrantVectorStore> {
	if (vectorStore) {
		return vectorStore;
	}

	const qdrantUrl = import.meta.env.VITE_QDRANT_URL;
	const qdrantApiKey = import.meta.env.VITE_QDRANT_API_KEY;

	if (!(qdrantUrl && qdrantApiKey)) {
		throw new Error(
			"Qdrant configuration missing. Please set VITE_QDRANT_URL and VITE_QDRANT_API_KEY environment variables."
		);
	}

    
	client = new QdrantClient({
		url: qdrantUrl,
		apiKey: qdrantApiKey,
        port: 443
	});
	const openaiApiKey = import.meta.env.VITE_OPENAI_API_KEY;
	if (!openaiApiKey) {
		throw new Error(
			"OpenAI API key missing. Please set VITE_OPENAI_API_KEY environment variable."
		);
	}

	embeddings = new OpenAIEmbeddings({
		openAIApiKey: openaiApiKey,
        model: "text-embedding-3-large",
	});

	vectorStore = await QdrantVectorStore.fromExistingCollection(embeddings, {
		client,
		collectionName: "messages",
		contentPayloadKey: "id"
	});

	return vectorStore;
}

/**
 * Search for messages within a specific chat using semantic search
 * @param query - The search query string
 * @param chatIdRangeStart - The chat ID range start (extracted from chat.id)
 * @param limit - Maximum number of results to return (default: 10)
 * @returns Array of matching document results
 */
export async function searchMessages(
	query: string,
	chatIdRangeStart: string,
	limit = 10
): Promise<Document[]> {
	if (!query.trim()) {
		return [];
	}

	try {
		const vs = await getVectorStore();

		// Create filter to match messages where id starts with message:⟨${chatIdRangeStart}⟩
		// Using Qdrant's filter format for prefix matching
		const filter = {
			must: [
				{
					key: "id",
					match: {
						text: `message:⟨${chatIdRangeStart}`,
					},
				},
			],
		};

		// Perform semantic search with the filter
		const results = await vs.similaritySearchWithScore(query, limit, filter);

		// Return just the documents (without scores)
		return results.map(([doc]) => doc);
	} catch (error) {
		console.error("Error searching messages:", error);
		throw error;
	}
}
