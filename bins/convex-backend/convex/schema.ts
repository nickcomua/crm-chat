import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// =============================================================================
// Enum-like validators (Convex uses v.union(v.literal(...)) for enums)
// =============================================================================

export const clientKind = v.literal("Telegram");

export const clientStatus = v.union(
	v.object({ type: v.literal("Authenticating") }),
	v.object({ type: v.literal("Connected") }),
	v.object({ type: v.literal("Error"), message: v.string() }),
);

export const chatType = v.union(v.literal("Dialog"), v.literal("Group"));

export const messageSeverity = v.union(
	v.literal("Info"),
	v.literal("Warning"),
	v.literal("Error"),
);

export const phoneAuthStep = v.union(
	v.literal("SendingCode"),
	v.literal("WaitingCode"),
	v.literal("VerifyingCode"),
	v.literal("WaitingPassword"),
	v.literal("VerifyingPassword"),
	v.literal("Connected"),
	v.literal("Failed"),
	v.literal("Cancelled"),
);

export const qrAuthStep = v.union(
	v.literal("Pending"),
	v.literal("Generating"),
	v.literal("Token"),
	v.literal("Authorized"),
	v.literal("AlreadyAuthorized"),
	v.literal("Failed"),
	v.literal("Cancelled"),
);

export const mediaKind = v.union(
	v.literal("Photo"),
	v.literal("Video"),
	v.literal("VideoNote"),
	v.literal("Audio"),
	v.literal("Voice"),
	v.literal("Sticker"),
	v.literal("Animation"),
	v.literal("Document"),
);

export const mediaStatus = v.union(
	v.literal("Pending"),
	v.literal("Downloading"),
	v.literal("Stored"),
	v.literal("Failed"),
	v.literal("Skipped"),
);

export const mediaSettingsValidator = v.object({
	savePhotos: v.optional(v.boolean()),
	saveVideos: v.optional(v.boolean()),
	saveAudio: v.optional(v.boolean()),
	saveVoice: v.optional(v.boolean()),
	saveStickers: v.optional(v.boolean()),
	saveDocuments: v.optional(v.boolean()),
	saveAnimations: v.optional(v.boolean()),
	saveVideoNotes: v.optional(v.boolean()),
});

export const scanPhase = v.union(
	v.literal("ScanningMessages"),
	v.literal("DownloadingMedia"),
	v.literal("Listening"),
);

export const workerTaskStatus = v.union(
	v.literal("Pending"),
	v.literal("Dispatched"),
);

// =============================================================================
// Worker task discriminated union — fully typed, no payload strings
// =============================================================================

const authTaskBase = { authId: v.string() };
const authTaskWithDoc = { ...authTaskBase, doc: v.string() };
const clientTaskBase = {
	clientId: v.id("clients" as const),
	userId: v.string(),
	telegramId: v.string(),
};

export const workerTask = v.union(
	// Auth flows
	v.object({ type: v.literal("PhoneAuth:run"), ...authTaskWithDoc }),
	v.object({ type: v.literal("PhoneAuth:submitCode"), ...authTaskBase }),
	v.object({ type: v.literal("PhoneAuth:submitPassword"), ...authTaskBase }),
	v.object({ type: v.literal("PhoneAuth:cancel"), ...authTaskBase }),
	v.object({ type: v.literal("QrAuth:run"), ...authTaskWithDoc }),
	v.object({ type: v.literal("QrAuth:cancel"), authId: v.string() }),

	// Client lifecycle
	v.object({ type: v.literal("DialogSync:sync"), ...clientTaskBase }),
	v.object({ type: v.literal("UpdateListener:listen"), ...clientTaskBase }),
	v.object({
		type: v.literal("UpdateListener:stop"),
		clientId: v.id("clients"),
	}),
	v.object({ type: v.literal("ProfilePhotoSync:sync"), ...clientTaskBase }),
	v.object({
		type: v.literal("ProfilePhotoSync:stop"),
		clientId: v.id("clients"),
	}),

	// Chat scanning
	v.object({
		type: v.literal("ChatScanner:scan"),
		chatId: v.string(),
		clientId: v.id("clients"),
		userId: v.string(),
	}),

	// Per-file media download
	v.object({
		type: v.literal("MediaDownloader:download"),
		telegramFileId: v.string(),
		userId: v.string(),
		clientId: v.id("clients"),
		telegramId: v.string(),
		chatId: v.string(),
		kind: mediaKind,
		mimeType: v.optional(v.string()),
		fileSize: v.optional(v.number()),
	}),
);

// =============================================================================
// Document validators — single source of truth for table fields.
// Include _id/_creationTime for use as return types; .omit() strips them
// before passing to defineTable() (which re-adds them automatically).
// =============================================================================

export const clientDoc = v.object({
	_id: v.id("clients"),
	_creationTime: v.number(),
	userId: v.string(),
	kind: clientKind,
	telegramId: v.string(),
	phoneNumber: v.optional(v.string()),
	scanningChatIds: v.array(v.string()),
	status: clientStatus,
	mediaSettings: v.optional(mediaSettingsValidator),
});

export const chatDoc = v.object({
	_id: v.id("chats"),
	_creationTime: v.number(),
	chatId: v.string(),
	userId: v.string(),
	clientId: v.id("clients"),
	chatType: chatType,
	isPinned: v.boolean(),
	pinnedName: v.optional(v.string()),
	lastMessageTimestamp: v.number(),
	scanEnabled: v.optional(v.boolean()),
	fullScanned: v.optional(v.boolean()),
	mediaSettings: v.optional(mediaSettingsValidator),
	totalMessages: v.optional(v.number()),
	syncedMessages: v.optional(v.number()),
	scanPhase: v.optional(scanPhase),
	photoStorageId: v.optional(v.id("_storage")),
	photoExternalId: v.optional(v.string()),
});

/** chatDoc fields + resolved photoUrl for the frontend chat list. */
export const chatListItem = v.object({
	_id: v.id("chats"),
	_creationTime: v.number(),
	chatId: v.string(),
	userId: v.string(),
	clientId: v.id("clients"),
	chatType: chatType,
	isPinned: v.boolean(),
	pinnedName: v.optional(v.string()),
	lastMessageTimestamp: v.number(),
	scanEnabled: v.optional(v.boolean()),
	fullScanned: v.optional(v.boolean()),
	mediaSettings: v.optional(mediaSettingsValidator),
	totalMessages: v.optional(v.number()),
	syncedMessages: v.optional(v.number()),
	scanPhase: v.optional(scanPhase),
	photoStorageId: v.optional(v.id("_storage")),
	photoExternalId: v.optional(v.string()),
	photoUrl: v.optional(v.string()),
});

export const messageDoc = v.object({
	_id: v.id("messages"),
	_creationTime: v.number(),
	messageId: v.string(),
	externalId: v.string(),
	userId: v.string(),
	clientId: v.id("clients"),
	chatId: v.string(),
	senderId: v.string(),
	text: v.optional(v.string()),
	outgoing: v.boolean(),
	deleted: v.boolean(),
	timestamp: v.number(),
	mediaExternalId: v.optional(v.string()),
	mediaKind: v.optional(mediaKind),
});

export const mediaDoc = v.object({
	_id: v.id("media"),
	_creationTime: v.number(),
	telegramFileId: v.string(),
	userId: v.string(),
	clientId: v.id("clients"),
	chatId: v.string(),
	messageId: v.string(),
	status: mediaStatus,
	storageId: v.optional(v.id("_storage")),
	kind: mediaKind,
	mimeType: v.optional(v.string()),
	fileName: v.optional(v.string()),
	fileSize: v.optional(v.number()),
	bytesDownloaded: v.optional(v.number()),
	downloadedAt: v.optional(v.number()),
	width: v.optional(v.number()),
	height: v.optional(v.number()),
	duration: v.optional(v.number()),
	error: v.optional(v.string()),
});

export const phoneAuthDoc = v.object({
	_id: v.id("phoneAuths"),
	_creationTime: v.number(),
	userId: v.string(),
	clientId: v.id("clients"),
	phone: v.string(),
	step: phoneAuthStep,
	phoneCodeHash: v.optional(v.string()),
	loginCode: v.optional(v.string()),
	passwordToken: v.optional(v.string()),
	password: v.optional(v.string()),
	passwordHint: v.optional(v.string()),
	error: v.optional(v.string()),
	claimedByWorkerId: v.optional(v.string()),
	updatedAt: v.number(),
});

/** phoneAuthDoc without secrets — safe for human-facing queries. */
export const phoneAuthPublicDoc = v.object({
	_id: v.id("phoneAuths"),
	_creationTime: v.number(),
	userId: v.string(),
	clientId: v.id("clients"),
	phone: v.string(),
	step: phoneAuthStep,
	passwordHint: v.optional(v.string()),
	error: v.optional(v.string()),
	updatedAt: v.number(),
});

export const qrAuthDoc = v.object({
	_id: v.id("qrAuths"),
	_creationTime: v.number(),
	userId: v.string(),
	step: qrAuthStep,
	qrUrl: v.optional(v.string()),
	qrExpires: v.optional(v.number()),
	telegramUserId: v.optional(v.int64()),
	error: v.optional(v.string()),
	claimedByWorkerId: v.optional(v.string()),
	updatedAt: v.number(),
});

export const notificationDoc = v.object({
	_id: v.id("notifications"),
	_creationTime: v.number(),
	userId: v.string(),
	severity: messageSeverity,
	message: v.string(),
	dismissed: v.boolean(),
});

export const workerTaskDoc = v.object({
	_id: v.id("workerTasks"),
	_creationTime: v.number(),
	task: workerTask,
	status: workerTaskStatus,
	createdAt: v.number(),
	dispatchedAt: v.optional(v.number()),
});

// =============================================================================
// Schema — .omit() strips _id/_creationTime before defineTable (it re-adds them)
// =============================================================================

export default defineSchema({
	clients: defineTable(clientDoc.omit("_id", "_creationTime"))
		.index("by_userId", ["userId"])
		.index("by_userId_telegramId", ["userId", "telegramId"]),

	chats: defineTable(chatDoc.omit("_id", "_creationTime"))
		.index("by_chatId", ["chatId"])
		.index("by_userId", ["userId"])
		.index("by_clientId", ["clientId"])
		.index("by_userId_lastMessageTimestamp", ["userId", "lastMessageTimestamp"])
		.index("by_userId_scanEnabled_lastMessageTimestamp", [
			"userId",
			"scanEnabled",
			"lastMessageTimestamp",
		])
		.index("by_clientId_userId", ["clientId", "userId"]),

	messages: defineTable(messageDoc.omit("_id", "_creationTime"))
		.index("by_messageId", ["messageId"])
		.index("by_externalId", ["externalId"])
		.index("by_userId", ["userId"])
		.index("by_chatId_timestamp", ["chatId", "timestamp"]),

	media: defineTable(mediaDoc.omit("_id", "_creationTime"))
		.index("by_telegramFileId", ["telegramFileId"])
		.index("by_messageId", ["messageId"])
		.index("by_clientId_status", ["clientId", "status"])
		.index("by_chatId", ["chatId"])
		.index("by_userId_status", ["userId", "status"])
		.index("by_userId_downloadedAt", ["userId", "downloadedAt"])
		.index("by_userId_status_downloadedAt", [
			"userId",
			"status",
			"downloadedAt",
		]),

	phoneAuths: defineTable(phoneAuthDoc.omit("_id", "_creationTime"))
		.index("by_userId", ["userId"])
		.index("by_step", ["step"])
		.index("by_claimedByWorkerId", ["claimedByWorkerId"])
		.index("by_clientId", ["clientId"]),

	qrAuths: defineTable(qrAuthDoc.omit("_id", "_creationTime"))
		.index("by_userId", ["userId"])
		.index("by_step", ["step"])
		.index("by_claimedByWorkerId", ["claimedByWorkerId"]),

	notifications: defineTable(notificationDoc.omit("_id", "_creationTime"))
		.index("by_userId", ["userId"])
		.index("by_userId_dismissed", ["userId", "dismissed"]),

	workerTasks: defineTable(workerTaskDoc.omit("_id", "_creationTime"))
		.index("by_status", ["status"]),
});
