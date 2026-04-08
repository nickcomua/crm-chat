import { v } from "convex/values";

export const mediaKind = v.union(
  v.literal("Photo"),
  v.literal("Video"),
  v.literal("VideoNote"),
  v.literal("Audio"),
  v.literal("Voice"),
  v.literal("Sticker"),
  v.literal("Animation"),
  v.literal("Document")
);

export const mediaStatus = v.union(
  v.literal("Pending"),
  v.literal("Downloading"),
  v.literal("Stored"),
  v.literal("Failed"),
  v.literal("Skipped")
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

/** Reusable work-item shape for per-table `pendingWork` queries. */
export const workItem = v.object({
  service: v.string(),
  key: v.string(),
  handler: v.string(),
});

// =============================================================================
// Contact-domain validators (used by contacts, chatContactLinks, contactPins)
// =============================================================================

/** Custom field entry on a contact. Freeform key/value with an optional type
 *  hint that the UI uses to pick the right input widget. */
export const customFieldValidator = v.object({
  key: v.string(),
  value: v.string(),
  type: v.optional(
    v.union(
      v.literal("text"),
      v.literal("number"),
      v.literal("date"),
      v.literal("email"),
      v.literal("phone"),
      v.literal("url")
    )
  ),
});

/** Stable identity tuple for a contact ↔ conversation link.
 *  chatId is the app-level string FK (matches messages.chatId / media.chatId),
 *  senderId is the opaque sender identifier from messages.senderId. */
export const senderLinkValidator = v.object({
  chatId: v.string(),
  senderId: v.string(),
});

/** Everything needed to render a pinned interaction WITHOUT reading the
 *  messages table. Pins are snapshotted so they survive hard-delete cascades
 *  (e.g. updateScanEnabled(false)). See model/contactPins.ts for context. */
export const contactPinSnapshotValidator = v.object({
  text: v.optional(v.string()),
  timestamp: v.number(),
  senderId: v.string(),
  outgoing: v.boolean(),
  mediaKind: v.optional(mediaKind),
  mediaExternalId: v.optional(v.string()),
  chatDisplayNameAtPinTime: v.optional(v.string()),
});
