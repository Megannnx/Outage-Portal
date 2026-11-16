import bcrypt from "bcryptjs";
export const hashPasswordRaw = (pw: string) => bcrypt.hash(pw, 12);
