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
