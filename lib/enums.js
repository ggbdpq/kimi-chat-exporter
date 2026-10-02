// Proto enum tables extracted from Kimi's own bundled FileDescriptorProto blobs,
// so both the numeric and the string wire form of every enum decode correctly.

export const ROLE = { 0: "unspecified", 1: "system", 2: "user", 3: "assistant" };

export const MESSAGE_STATUS = {
  0: "unspecified",
  1: "generating",
  2: "completed",
  3: "cancelled",
  4: "truncated",
  5: "error",
  6: "pending",
};

export const MESSAGE_STATUS_NAMES = {
  MESSAGE_STATUS_UNSPECIFIED: "unspecified",
  MESSAGE_STATUS_GENERATING: "generating",
  MESSAGE_STATUS_COMPLETED: "completed",
  MESSAGE_STATUS_CANCELLED: "cancelled",
  MESSAGE_STATUS_TRUNCATED: "truncated",
  MESSAGE_STATUS_ERROR: "error",
  MESSAGE_STATUS_PENDING: "pending",
};

export const VOTE = { 0: "unspecified", 1: "up", 2: "down" };
export const VOTE_NAMES = { VOTE_UNSPECIFIED: "unspecified", VOTE_UP: "up", VOTE_DOWN: "down" };

export const FILE_TYPE = {
  0: "unspecified",
  1: "url",
  2: "document",
  3: "image",
  4: "video",
  5: "audio",
  6: "aippt",
  7: "slides",
};
export const FILE_TYPE_NAMES = {
  FILE_TYPE_UNSPECIFIED: "unspecified",
  FILE_TYPE_URL: "url",
  FILE_TYPE_DOCUMENT: "document",
  FILE_TYPE_IMAGE: "image",
  FILE_TYPE_VIDEO: "video",
  FILE_TYPE_AUDIO: "audio",
  FILE_TYPE_AIPPT: "aippt",
  FILE_TYPE_SLIDES: "slides",
};

export const PROCESS_STATUS = {
  0: "unspecified",
  1: "pending",
  2: "processing",
  3: "success",
  4: "failed",
};
export const PROCESS_STATUS_NAMES = {
  PROCESS_STATUS_UNSPECIFIED: "unspecified",
  PROCESS_STATUS_PENDING: "pending",
  PROCESS_STATUS_PROCESSING: "processing",
  PROCESS_STATUS_SUCCESS: "success",
  PROCESS_STATUS_FAILED: "failed",
};

export const ARTIFACT_TYPE = {
  0: "unspecified",
  1: "markdown",
  2: "code",
  3: "slides_json",
  4: "slides_html",
  5: "slides_banana",
  6: "document",
  7: "sheet",
  8: "slides",
  9: "image",
  10: "design",
};
export const ARTIFACT_TYPE_NAMES = {
  ARTIFACT_TYPE_UNSPECIFIED: "unspecified",
  ARTIFACT_TYPE_MARKDOWN: "markdown",
  ARTIFACT_TYPE_CODE: "code",
  ARTIFACT_TYPE_SLIDES_JSON: "slides_json",
  ARTIFACT_TYPE_SLIDES_HTML: "slides_html",
  ARTIFACT_TYPE_SLIDES_BANANA: "slides_banana",
  ARTIFACT_TYPE_DOCUMENT: "document",
  ARTIFACT_TYPE_SHEET: "sheet",
  ARTIFACT_TYPE_SLIDES: "slides",
  ARTIFACT_TYPE_IMAGE: "image",
  ARTIFACT_TYPE_DESIGN: "design",
};

export const LOAD_TYPE = { 0: "unspecified", 1: "external" };

export const SEVERITY = { 0: "unspecified", 1: "info", 2: "block_retract", 3: "message_retract" };

export const REASON = {
  0: "unspecified",
  1: "content_filter",
  2: "token_length_too_long",
  3: "completion_overloaded",
  4: "request_error",
  5: "inconsistent_file_type",
  6: "text_usage_exceeded",
  7: "think_usage_exceeded",
  8: "k2_usage_exceeded",
  9: "request_rate_exceeded",
  10: "research_task_concurrent_limit",
  11: "deep_research_usage_exceeded",
  12: "anonymous_usage_exceeded",
  13: "abnormal_user_usage_exceeded",
  14: "abnormal_user_survey_required",
  15: "exceed_tool_call_max_rounds",
  16: "rate_limit_exceeded",
  17: "chat_interrupted",
  18: "chat_fatal_error",
  19: "llm_unavailable",
};

export const STAGE_NAME = {
  0: "unspecified",
  1: "research",
  2: "report",
  3: "outline",
  4: "part_report",
  5: "final_report",
  6: "html_report",
  7: "clarify",
  11: "thinking",
  21: "okc_react",
  31: "summary",
};
export const STAGE_STATUS = { 0: "unspecified", 1: "start", 2: "end" };

export const REFERENCE_TYPE = {
  0: "unspecified",
  1: "invalid",
  2: "cite",
  3: "image",
  4: "file",
  5: "article",
  6: "im_mention",
  7: "extension",
};

export const URL_REF_STATUS = {
  0: "unspecified",
  1: "waiting",
  2: "parsing",
  3: "parsed",
  4: "failed",
  5: "timeout",
};

export const IMAGE_STATE = {
  0: "unspecified",
  1: "init",
  2: "failure",
  3: "success",
  4: "generation",
  5: "cancellation",
};
export const IMAGE_SOURCE = { 0: "unspecified", 1: "gen", 2: "search" };

// Every member of the Block.content oneof, in proto order.
export const BLOCK_KINDS = [
  "text",
  "search",
  "file",
  "think",
  "exception",
  "memory",
  "contractReview",
  "tool",
  "artifact",
  "slidesView",
  "stage",
  "multiStage",
  "elemeMenuCard",
  "elemeOrderCard",
  "videoCards",
  "visualEdit",
  "websitesTemplate",
  "slidesAnnotation",
  "fileAnnotation",
  "model3dAnnotation",
  "make3dTypeSelection",
  "websiteSelector",
  "inspirationTemplate",
  "editorContext",
  "explorerResearch",
  "explorerResearchReanswer",
  "aippt",
  "contentViewZhidemaiCard",
  "resourceLink",
  "imRoomSystem",
  "agentMessage",
  "imMessage",
  "error",
];

// Kimi serialises proto enums as their symbolic names (ROLE_USER,
// STAGE_NAME_RESEARCH, MESSAGE_STATUS_COMPLETED, ...). Every name is
// "<qualifier tokens>_<value>", so dropping the leading qualifier tokens yields
// the readable value. This also covers enums added by a future Kimi release,
// which a fixed per-enum table could not.
const QUALIFIER = new Set([
  "ROLE",
  "NAME",
  "TYPE",
  "TYPES",
  "STATUS",
  "STATE",
  "SOURCE",
  "LEVEL",
  "KIND",
  "MODE",
  "ORDER",
  "DIRECTION",
  "EFFORT",
  "SEVERITY",
  "REASON",
  "VOTE",
  "LOAD",
  "SCOPE",
  "FORMAT",
  "CATEGORY",
  "ORIENTATION",
  "PERIOD",
]);

function shortEnumName(value) {
  const raw = String(value);
  const parts = raw.split("_");
  if (parts.length <= 1) return raw.toLowerCase();
  const upper = parts.map((p) => p.toUpperCase());
  // Drop the longest leading run of qualifier tokens, but never the last part.
  let cut = 0;
  while (cut < parts.length - 1 && QUALIFIER.has(upper[cut])) cut++;
  if (cut === 0) {
    // No leading qualifier: keep the tail after the final qualifier token,
    // which handles ARTIFACT_TYPE_SLIDES_JSON and FILE_TYPE_IMAGE.
    for (let i = parts.length - 2; i > 0; i--) {
      if (QUALIFIER.has(upper[i])) {
        cut = i + 1;
        break;
      }
    }
  }
  return parts.slice(cut).join("_").toLowerCase();
}
/**
 * Decode a proto-JSON enum: accepts number, "NUMBER_NAME" string, or bare number string.
 * @param {Record<number,string>|Record<string,string>|undefined} table
 */
export function decodeEnum(value, byNumber, byName) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number" && byNumber) return byNumber[value] ?? `num:${value}`;
  if (typeof value === "number") return `num:${value}`;
  if (byName && byName[value]) return byName[value];
  if (/^\d+$/.test(value) && byNumber) return byNumber[Number(value)] ?? `num:${value}`;
  return shortEnumName(value);
}
