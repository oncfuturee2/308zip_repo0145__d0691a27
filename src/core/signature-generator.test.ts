import { describe, it, expect } from 'vitest';
import { SignatureGenerator, SignaturePayload } from './signature-generator';

describe('SignatureGenerator', () => {
  const generator = new SignatureGenerator();
  const secret = 'test-secret-key-12345';

  describe('generate', () => {
    it('should generate a consistent HMAC signature', () => {
      const payload: SignaturePayload = {
        timestamp: Date.now(),
        eventType: 'order.created',
        eventId: 'event-123',
        payload: JSON.stringify({ orderId: 'ORD-001' })
      };

      const signature1 = generator.generate(secret, payload);
      const signature2 = generator.generate(secret, payload);

      expect(signature1).toBe(signature2);
      expect(signature1).toHaveLength(64);
    });

    it('should generate different signatures for different secrets', () => {
      const payload: SignaturePayload = {
        timestamp: Date.now(),
        eventType: 'order.created',
        eventId: 'event-123',
        payload: JSON.stringify({ orderId: 'ORD-001' })
      };

      const signature1 = generator.generate('secret-1', payload);
      const signature2 = generator.generate('secret-2', payload);

      expect(signature1).not.toBe(signature2);
    });

    it('should generate different signatures for different payloads', () => {
      const basePayload = {
        timestamp: Date.now(),
        eventType: 'order.created',
        eventId: 'event-123'
      };

      const payload1: SignaturePayload = {
        ...basePayload,
        payload: JSON.stringify({ orderId: 'ORD-001' })
      };

      const payload2: SignaturePayload = {
        ...basePayload,
        payload: JSON.stringify({ orderId: 'ORD-002' })
      };

      const signature1 = generator.generate(secret, payload1);
      const signature2 = generator.generate(secret, payload2);

      expect(signature1).not.toBe(signature2);
    });
  });

  describe('verify', () => {
    it('should verify a valid signature', () => {
      const payload: SignaturePayload = {
        timestamp: Date.now(),
        eventType: 'payment.failed',
        eventId: 'event-456',
        payload: JSON.stringify({ paymentId: 'PAY-001' })
      };

      const signature = generator.generate(secret, payload);
      const isValid = generator.verify(secret, signature, payload);

      expect(isValid).toBe(true);
    });

    it('should reject an invalid signature', () => {
      const payload: SignaturePayload = {
        timestamp: Date.now(),
        eventType: 'payment.failed',
        eventId: 'event-456',
        payload: JSON.stringify({ paymentId: 'PAY-001' })
      };

      const signature = generator.generate(secret, payload);
      const tamperedSignature = 'a' + signature.slice(1);
      const isValid = generator.verify(secret, tamperedSignature, payload);

      expect(isValid).toBe(false);
    });

    it('should reject a signature generated with a different secret', () => {
      const payload: SignaturePayload = {
        timestamp: Date.now(),
        eventType: 'payment.failed',
        eventId: 'event-456',
        payload: JSON.stringify({ paymentId: 'PAY-001' })
      };

      const signature = generator.generate('different-secret', payload);
      const isValid = generator.verify(secret, signature, payload);

      expect(isValid).toBe(false);
    });
  });

  describe('generateHeader', () => {
    it('should generate a valid webhook signature header', () => {
      const payload: SignaturePayload = {
        timestamp: 1704067200,
        eventType: 'order.created',
        eventId: 'event-789',
        payload: JSON.stringify({ orderId: 'ORD-003' })
      };

      const header = generator.generateHeader(secret, payload);

      expect(header).toMatch(/^t=\d+,v1=[a-f0-9]+$/);
      expect(header).toContain('t=1704067200');
      expect(header).toContain('v1=');
    });
  });

  describe('parseHeader', () => {
    it('should parse a valid signature header', () => {
      const timestamp = 1704067200;
      const signature = 'abc123def456';
      const header = `t=${timestamp},v1=${signature}`;

      const parsed = generator.parseHeader(header);

      expect(parsed).not.toBeNull();
      expect(parsed?.timestamp).toBe(timestamp);
      expect(parsed?.signature).toBe(signature);
    });

    it('should return null for an invalid header format', () => {
      const invalidHeaders = [
        'invalid-format',
        't=123456',
        'v1=abc123',
        '',
        't=not-a-number,v1=abc123'
      ];

      for (const header of invalidHeaders) {
        expect(generator.parseHeader(header)).toBeNull();
      }
    });
  });

  describe('integration test: generate and verify', () => {
    it('should complete a full signature generation and verification cycle', () => {
      const payload: SignaturePayload = {
        timestamp: Math.floor(Date.now() / 1000),
        eventType: 'user.registered',
        eventId: 'evt-001-abc',
        payload: JSON.stringify({
          userId: 'user-123',
          email: 'test@example.com',
          timestamp: Date.now()
        })
      };

      const header = generator.generateHeader(secret, payload);
      const parsed = generator.parseHeader(header);

      expect(parsed).not.toBeNull();

      const isValid = generator.verify(
        secret,
        parsed!.signature,
        {
          ...payload,
          timestamp: parsed!.timestamp
        }
      );

      expect(isValid).toBe(true);
    });
  });
});
