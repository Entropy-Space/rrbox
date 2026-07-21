import { proxyLocalOpenAiRequest } from "../../../../../server/local-openai-proxy";

export function GET(request: Request): Promise<Response> {
  return proxyLocalOpenAiRequest(request, "/models");
}
