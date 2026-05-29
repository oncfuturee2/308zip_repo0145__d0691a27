import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from './prisma-client';
import { DeliveryService, MaxAttemptsExceededError } from './delivery.service';
import { MockHttpClient, DeliveryExecutor, SignatureGenerator, RetryStrategy } from '../core';

describe('DeliveryService', () => {
  let mockHttpClient: MockHttpClient;
  let deliveryExecutor: DeliveryExecutor;
  let retryStrategy: RetryStrategy;
  let deliveryService: DeliveryService;
  let signatureGenerator: SignatureGenerator;

  beforeEach(async () => {
    // Thoroughly clean up tables to guarantee test isolation
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});

    // Instantiate MockHttpClient
    mockHttpClient = new MockHttpClient(1.0, 200, 10);
    
    // Instantiate SignatureGenerator
    signatureGenerator = new SignatureGenerator();
    
    // Build DeliveryExecutor
    deliveryExecutor = new DeliveryExecutor(mockHttpClient, signatureGenerator);
    
    // Custom RetryStrategy (e.g., max 3 attempts)
    retryStrategy = new RetryStrategy({
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      backoffMultiplier: 2
    });
    
    // Instantiate DeliveryService with injected dependencies
    deliveryService = new DeliveryService(deliveryExecutor, retryStrategy);
  });

  afterEach(async () => {
    // Clean up tables after each test
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });

  describe('retryDelivery', () => {
    it('should throw an error when passing a non-existent attemptId', async () => {
      const fakeAttemptId = 'non-existent-id';
      await expect(deliveryService.retryDelivery(fakeAttemptId))
        .rejects
        .toThrow(`Delivery attempt not found: ${fakeAttemptId}`);
    });

    it('should reject retry and throw an error when historical attempt record has a non-retryable statusCode', async () => {
      // Create test data
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test_secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'test.event',
          payload: JSON.stringify({ key: 'value' })
        }
      });

      // Create an attempt with a non-retryable status code (400)
      const attempt = await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          isSuccess: false,
          statusCode: 400,
          durationMs: 50,
          attemptNumber: 1
        }
      });

      await expect(deliveryService.retryDelivery(attempt.id))
        .rejects
        .toThrow(`Cannot retry delivery with status code: 400`);
    });

    it('should throw MaxAttemptsExceededError when the number of attempts reaches the max limit', async () => {
      // Create test data
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test_secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'test.event',
          payload: JSON.stringify({ key: 'value' })
        }
      });

      // The configured max attempts is 3. We simulate 3 existing attempts in the database.
      // 1st attempt
      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          isSuccess: false,
          statusCode: 500, // Retryable status code
          durationMs: 50,
          attemptNumber: 1
        }
      });

      // 2nd attempt
      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          isSuccess: false,
          statusCode: 500,
          durationMs: 50,
          attemptNumber: 2
        }
      });

      // 3rd attempt
      const lastAttempt = await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          isSuccess: false,
          statusCode: 500,
          durationMs: 50,
          attemptNumber: 3
        }
      });

      // Try to retry the 3rd attempt. This should exceed the max limit of 3.
      await expect(deliveryService.retryDelivery(lastAttempt.id))
        .rejects
        .toThrow(MaxAttemptsExceededError);
    });

    it('should correctly execute retry and save a new DeliveryAttempt record with incremented attemptNumber when conditions are met', async () => {
      // Create test data
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test_secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'test.event',
          payload: JSON.stringify({ key: 'value' })
        }
      });

      // Create a single initial attempt with a retryable status code (500)
      const initialAttempt = await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          isSuccess: false,
          statusCode: 500,
          durationMs: 50,
          attemptNumber: 1
        }
      });

      // Mock the HTTP client to simulate a successful response for the retry
      mockHttpClient.clearForcedError();

      // Execute retry
      const newAttempt = await deliveryService.retryDelivery(initialAttempt.id);

      // Verify the returned new attempt record
      expect(newAttempt).toBeDefined();
      expect(newAttempt.eventId).toBe(event.id);
      expect(newAttempt.endpointId).toBe(endpoint.id);
      expect(newAttempt.attemptNumber).toBe(2); // attemptNumber correctly incremented
      expect(newAttempt.statusCode).toBe(200); // the mock returns 200 by default
      expect(newAttempt.isSuccess).toBe(true);

      // Verify it was correctly saved to the database
      const dbAttempts = await prisma.deliveryAttempt.findMany({
        where: {
          eventId: event.id,
          endpointId: endpoint.id
        },
        orderBy: {
          attemptNumber: 'asc'
        }
      });

      // We should have exactly 2 attempts in the database
      expect(dbAttempts.length).toBe(2);
      expect(dbAttempts[0].id).toBe(initialAttempt.id);
      expect(dbAttempts[0].attemptNumber).toBe(1);
      
      expect(dbAttempts[1].id).toBe(newAttempt.id);
      expect(dbAttempts[1].attemptNumber).toBe(2);
      expect(dbAttempts[1].isSuccess).toBe(true);
      expect(dbAttempts[1].statusCode).toBe(200);
    });
  });
});
