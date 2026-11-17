import nodemailer from "nodemailer";
import type { Config } from "./config";

export interface Mailer {
  sendOtp(to: string, code: string): Promise<void>;
}

/** SMTP mailer; in dev (TENAI_DEV_PRINT_OTP=1, no SMTP host) the code is written to the server log. */
export function createMailer(cfg: Config): Mailer {
  if (!cfg.smtp.host) {
    if (!cfg.devPrintOtp) throw new Error("TENAI_SMTP_HOST is not set (set TENAI_DEV_PRINT_OTP=1 for local dev)");
    return {
      async sendOtp(to, code) {
        console.log(`[dev-otp] ${to} → ${code}`);
      },
    };
  }
  const transport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.port === 465,
    auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined,
  });
  return {
    async sendOtp(to, code) {
      await transport.sendMail({
        from: cfg.smtp.from,
        to,
        subject: `Your TenAI sign-in code: ${code}`,
        text: `Your TenAI sign-in code is ${code}. It expires in 10 minutes.\n\nIf you did not try to sign in to the OpenWallet Terminal, ignore this email.`,
      });
    },
  };
}
