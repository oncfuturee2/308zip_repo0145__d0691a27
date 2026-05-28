import * as crypto from 'crypto';

export interface SignaturePayload {
  timestamp: number;
  eventType: string;
  eventId: string;
  payload: string;
}

export class SignatureGenerator {
  private readonly algorithm = 'sha256';
  private readonly encoding: crypto.BinaryToTextEncoding = 'hex';

  generate(secret: string, payload: SignaturePayload): string {
    const timestamp = payload.timestamp.toString();
    const data = `${timestamp}.${payload.eventId}.${payload.eventType}.${payload.payload}`;
    const hmac = crypto.createHmac(this.algorithm, secret);
    hmac.update(data);
    return hmac.digest(this.encoding);
  }

  verify(secret: string, signature: string, payload: SignaturePayload): boolean {
    const expectedSignature = this.generate(secret, payload);
    if (signature.length !== expectedSignature.length) {
      return false;
    }
    return crypto.timingSafeEqual(
      Buffer.from(signature, this.encoding),
      Buffer.from(expectedSignature, this.encoding)
    );
  }

  generateHeader(secret: string, payload: SignaturePayload): string {
    const timestamp = payload.timestamp;
    const signature = this.generate(secret, payload);
    return `t=${timestamp},v1=${signature}`;
  }

  parseHeader(header: string): { timestamp: number; signature: string } | null {
    const parts = header.split(',');
    let timestamp: number | null = null;
    let signature: string | null = null;

    for (const part of parts) {
      const [key, value] = part.split('=');
      if (key === 't') {
        timestamp = parseInt(value, 10);
      } else if (key === 'v1') {
        signature = value;
      }
    }

    if (timestamp !== null && signature !== null && !isNaN(timestamp)) {
      return { timestamp, signature };
    }

    return null;
  }
}
