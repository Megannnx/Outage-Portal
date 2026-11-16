import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { login } from "@/server/auth/session";
import { errorResponse } from "@/server/api";
export async function POST(req: NextRequest) {
  try {
    const b = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }).parse(await req.json());
    return NextResponse.json(await login(b.email, b.password));
  } catch (e) { return errorResponse(e); }
}
