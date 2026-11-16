import { NextResponse } from "next/server";
import { logout } from "@/server/auth/session";
export async function POST() { await logout(); return NextResponse.json({ ok: true }); }
