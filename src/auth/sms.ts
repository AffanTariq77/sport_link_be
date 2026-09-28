export const SMS = Symbol('SMS');
/** Optional fixed OTP for development (DEV_OTP_CODE). */
export const DEV_OTP = Symbol('DEV_OTP');

export interface SmsSender {
  send(phone: string, text: string): Promise<void>;
}

/** Development only: prints the message instead of sending it. Config refuses it in production. */
export class FakeSmsSender implements SmsSender {
  async send(phone: string, text: string) {
    console.log(`[fake sms] to ${phone}: ${text}`);
  }
}
