import { proxyLocalOpenAiRequest } from "../../../../../../server/local-openai-proxy";

export function POST(request: Request): Promise<Response> {
  return proxyLocalOpenAiRequest(request, "/chat/completions");
}
