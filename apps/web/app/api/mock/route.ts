import { handleMockModelRequest } from "@researchbox/mock-provider";

export async function POST(request: Request): Promise<Response> {
  return handleMockModelRequest(request);
}
