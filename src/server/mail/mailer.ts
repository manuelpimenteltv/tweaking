/**
 * Email integration boundary. Development and tests use the console mailer,
 * which logs messages instead of sending them. A production adapter (SMTP,
 * Postmark, Resend) implements `Mailer` and is selected via MAIL_PROVIDER —
 * not yet implemented. Until then, invitation links are shown in the UI for
 * the inviter to share. See docs/CONFIGURATION.md.
 */
export type MailMessage = { to: string; subject: string; text: string };

export interface Mailer {
  readonly configured: boolean;
  send(message: MailMessage): Promise<void>;
}

class ConsoleMailer implements Mailer {
  readonly configured = false;
  async send(m: MailMessage) {
    if (process.env.NODE_ENV !== "test") {
      console.info(`[mail:console] to=${m.to} subject="${m.subject}"\n${m.text}`);
    }
  }
}

let mailer: Mailer | undefined;
export function getMailer(): Mailer {
  return (mailer ??= new ConsoleMailer());
}
