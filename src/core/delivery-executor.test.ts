import { describe, it, expect, vi, beforeEach } from 'vitest';
import { 
  DeliveryExecutor, 
  DeliveryRequest, 
  MockHttpClient,
  HttpRequest,
  HttpResponse
} from './delivery-executor';
import { SignatureGenerator } from './signature-generator';

describe('MockHttpClient', () => {
  describe('post', () => {
    it('should return success response by default', async () => {
      const client = new MockHttpClient(1.0, 200, 10);
      const request: HttpRequest = {
        url: 'https://example.com/webhook',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: 'data' })
      };

      const response = await client.post(request);
      expect(response.statusCode).toBe(200);
      expect(response.durationMs).toBeGreaterThanOrEqual(0);
      expect(response.errorMessage).toBeUndefined();
    });

    it('should return failure when successRate is 0', async () => {
      const client = new MockHttpClient(0, 200, 10);
      const request: HttpRequest = {
        url: 'https://example.com/webhook',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: 'data' })
      };

      const response = await client.post(request);
      expect(response.statusCode).toBe(500);
      expect(response.errorMessage).toBeDefined();
    });

    it('should return forced error when forceError is called', async () => {
      const client = new MockHttpClient(1.0, 200, 10);
      const customStatusCode = 503;
      const customMessage = 'Service Unavailable';
      
      client.forceError(customStatusCode, customMessage);
      
      const request: HttpRequest = {
        url: 'https://example.com/webhook',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: 'data' })
      };

      const response = await client.post(request);
      expect(response.statusCode).toBe(customStatusCode);
      expect(response.errorMessage).toBe(customMessage);
    });

    it('should clear forced error when clearForcedError is called', async () => {
      const client = new MockHttpClient(1.0, 200, 10);
      
      client.forceError(503, 'Service Unavailable');
      client.clearForcedError();
      
      const request: HttpRequest = {
        url: 'https://example.com/webhook',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: 'data' })
      };

      const response = await client.post(request);
      expect(response.statusCode).toBe(200);
      expect(response.errorMessage).toBeUndefined();
    });

    it('should use custom defaultStatusCode', async () => {
      const client = new MockHttpClient(1.0, 201, 10);
      const request: HttpRequest = {
        url: 'https://example.com/webhook',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: 'data' })
      };

      const response = await client.post(request);
      expect(response.statusCode).toBe(201);
    });
  });
});

describe('DeliveryExecutor', () => {
  let signatureGenerator: SignatureGenerator;
  let mockHttpClient: MockHttpClient;
  let executor: DeliveryExecutor;

  beforeEach(() => {
    signatureGenerator = new SignatureGenerator();
    mockHttpClient = new MockHttpClient(1.0, 200, 5);
    executor = new DeliveryExecutor(mockHttpClient, signatureGenerator);
  });

  describe('execute', () => {
    it('should execute successful delivery and return success result', async () => {
      const deliveryRequest: DeliveryRequest = {
        eventId: 'event-123',
        eventType: 'order.created',
        payload: JSON.stringify({ orderId: 'ORD-001' }),
        endpointId: 'ep-1',
        endpointUrl: 'https://example.com/webhook',
        endpointSecret: 'test-secret',
        attemptNumber: 1
      };

      const result = await executor.execute(deliveryRequest);

      expect(result.isSuccess).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.errorMessage).toBeUndefined();
    });

    it('should execute failed delivery and return failure result', async () => {
      mockHttpClient.forceError(500, 'Internal Server Error');

      const deliveryRequest: DeliveryRequest = {
        eventId: 'event-456',
        eventType: 'payment.failed',
        payload: JSON.stringify({ paymentId: 'PAY-001' }),
        endpointId: 'ep-2',
        endpointUrl: 'https://example.com/webhook',
        endpointSecret: 'test-secret',
        attemptNumber: 1
      };

      const result = await executor.execute(deliveryRequest);

      expect(result.isSuccess).toBe(false);
      expect(result.statusCode).toBe(500);
      expect(result.errorMessage).toBe('Internal Server Error');
    });

    it('should return failure result when http client throws error', async () => {
      const throwingClient = {
        post: vi.fn().mockRejectedValue(new Error('Connection refused'))
      };

      const executorWithThrowingClient = new DeliveryExecutor(
        throwingClient,
        signatureGenerator
      );

      const deliveryRequest: DeliveryRequest = {
        eventId: 'event-789',
        eventType: 'user.updated',
        payload: JSON.stringify({ userId: 'user-001' }),
        endpointId: 'ep-3',
        endpointUrl: 'https://example.com/webhook',
        endpointSecret: 'test-secret',
        attemptNumber: 1
      };

      const result = await executorWithThrowingClient.execute(deliveryRequest);

      expect(result.isSuccess).toBe(false);
      expect(result.statusCode).toBe(0);
      expect(result.errorMessage).toBe('Connection refused');
    });

    it('should treat 2xx status codes as success', async () => {
      const testCases = [
        { statusCode: 200, isSuccess: true },
        { statusCode: 201, isSuccess: true },
        { statusCode: 202, isSuccess: true },
        { statusCode: 204, isSuccess: true },
        { statusCode: 299, isSuccess: true }
      ];

      for (const tc of testCases) {
        mockHttpClient.forceError(tc.statusCode, '');
        const deliveryRequest: DeliveryRequest = {
          eventId: `event-${tc.statusCode}`,
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' }),
          endpointId: 'ep-1',
          endpointUrl: 'https://example.com/webhook',
          endpointSecret: 'test-secret',
          attemptNumber: 1
        };

        const result = await executor.execute(deliveryRequest);
        expect(result.statusCode).toBe(tc.statusCode);
        expect(result.isSuccess).toBe(tc.isSuccess);
      }
    });

    it('should treat non-2xx status codes as failure', async () => {
      const testCases = [
        { statusCode: 400, errorMessage: 'Bad Request' },
        { statusCode: 404, errorMessage: 'Not Found' },
        { statusCode: 500, errorMessage: 'Internal Server Error' },
        { statusCode: 503, errorMessage: 'Service Unavailable' }
      ];

      for (const tc of testCases) {
        mockHttpClient.forceError(tc.statusCode, tc.errorMessage);
        const deliveryRequest: DeliveryRequest = {
          eventId: `event-${tc.statusCode}`,
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' }),
          endpointId: 'ep-1',
          endpointUrl: 'https://example.com/webhook',
          endpointSecret: 'test-secret',
          attemptNumber: 1
        };

        const result = await executor.execute(deliveryRequest);
        expect(result.statusCode).toBe(tc.statusCode);
        expect(result.isSuccess).toBe(false);
      }
    });

    it('should pass correct headers to HTTP client', async () => {
      const httpClientSpy = {
        post: vi.fn().mockResolvedValue({
          statusCode: 200,
          durationMs: 10
        })
      };

      const executorWithSpy = new DeliveryExecutor(
        httpClientSpy,
        signatureGenerator
      );

      const deliveryRequest: DeliveryRequest = {
        eventId: 'event-123',
        eventType: 'order.created',
        payload: JSON.stringify({ orderId: 'ORD-001' }),
        endpointId: 'ep-1',
        endpointUrl: 'https://example.com/webhook',
        endpointSecret: 'test-secret',
        attemptNumber: 1
      };

      await executorWithSpy.execute(deliveryRequest);

      expect(httpClientSpy.post).toHaveBeenCalledOnce();
      const callArg = httpClientSpy.post.mock.calls[0][0] as HttpRequest;
      
      expect(callArg.url).toBe('https://example.com/webhook');
      expect(callArg.method).toBe('POST');
      expect(callArg.headers['Content-Type']).toBe('application/json');
      expect(callArg.headers['X-Webhook-Event']).toBe('order.created');
      expect(callArg.headers['X-Webhook-Event-Id']).toBe('event-123');
      expect(callArg.headers['X-Webhook-Attempt']).toBe('1');
      expect(callArg.headers['X-Webhook-Signature']).toBeDefined();
      expect(callArg.headers['X-Webhook-Signature']).toMatch(/^t=\d+,v1=[a-f0-9]+$/);
    });
  });
});
