import { createHandler } from "../src/handler.js";

// Every method goes through one handler, so no method or path is exempt from
// signature verification (vercel.json rewrites every path to this function).
const handle = createHandler();

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

export async function PUT(request: Request): Promise<Response> {
  return handle(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handle(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handle(request);
}

export async function OPTIONS(request: Request): Promise<Response> {
  return handle(request);
}
