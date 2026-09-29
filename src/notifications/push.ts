import { Logger } from '@nestjs/common';

export const PUSH = Symbol('PUSH');

export interface PushMessage {
  to: string; // device push token
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushSender {
  send(messages: PushMessage[]): Promise<void>;
}

/** Development: prints pushes to the API log instead of sending them. */
export class LogPushSender implements PushSender {
  private readonly log = new Logger('Push');
  async send(messages: PushMessage[]) {
    for (const m of messages) this.log.log(`to ${m.to.slice(0, 18)}…: ${m.title}: ${m.body}`);
  }
}

/**
 * Expo push service, which delivers through Firebase Cloud Messaging and Apple Push (spec 2). Works for apps built
 * with EAS; EXPO_ACCESS_TOKEN is only needed when "enhanced push security" is turned on for the Expo project.
 */
export class ExpoPushSender implements PushSender {
  private readonly log = new Logger('Push');
  constructor(private readonly accessToken?: string) {}

  async send(messages: PushMessage[]) {
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100).map((m) => ({ ...m, sound: 'default' }));
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify(chunk),
      });
      if (!res.ok) this.log.warn(`Expo push failed: ${res.status} ${await res.text()}`);
    }
  }
}
