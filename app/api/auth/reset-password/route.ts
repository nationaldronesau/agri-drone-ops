import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db/prisma";
import { z } from "zod";

const resetSchema = z.object({
  email: z.string().email(),
  newPassword: z.string().min(6),
  resetToken: z.string(),
});

// One-time reset token - remove this endpoint after use
const RESET_TOKEN = "agridrone-reset-2026-04-09";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, newPassword, resetToken } = resetSchema.parse(body);

    if (resetToken !== RESET_TOKEN) {
      return NextResponse.json({ error: "Invalid reset token" }, { status: 403 });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { email },
      data: { password: hashedPassword },
    });

    return NextResponse.json({
      success: true,
      message: "Password reset successfully",
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid input", details: error.errors }, { status: 400 });
    }
    console.error("Password reset error:", error);
    return NextResponse.json({ error: "Failed to reset password" }, { status: 500 });
  }
}
