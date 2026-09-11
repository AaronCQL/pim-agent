import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";

function textOf(
  content: UserMessage["content"] | AssistantMessage["content"],
  kind: "text" | "thinking" = "text"
): string {
  if (typeof content === "string") {
    return kind === "text" ? content : "";
  }
  let out = "";
  for (const part of content) {
    if (kind === "text" && part.type === "text") {
      out += part.text;
    } else if (kind === "thinking" && part.type === "thinking") {
      out += part.thinking;
    }
  }
  return out;
}

export const MessageText = { textOf };
