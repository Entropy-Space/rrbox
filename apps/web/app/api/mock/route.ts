import { handleMockModelRequest } from "@researchbox/mock-server";

export async function POST(request: Request): Promise<Response> {
  return handleMockModelRequest(request);
}
