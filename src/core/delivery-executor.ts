import { SignatureGenerator, SignaturePayload } from './signature-generator';

export interface HttpRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export interface HttpResponse {
  statusCode: number;
  durationMs: number;
  errorMessage?: string;
}

export interface HttpClient {
  post(request: HttpRequest): Promise<HttpResponse>;
}

export interface DeliveryRequest {
  eventId: string;
  eventType: string;
  payload: string;
  endpointId: string;
  endpointUrl: string;
  endpointSecret: string;
  attemptNumber: number;
}

export interface DeliveryResult {
  statusCode: number;
  durationMs: number;
  isSuccess: boolean;
  errorMessage?: string;
}

export class MockHttpClient implements HttpClient {
  private readonly defaultSuccessRate: number;
  private readonly defaultStatusCode: number;
  private readonly defaultDelayMs: number;
  private forcedError?: { statusCode: number; message: string };

  constructor(
    defaultSuccessRate: number = 1.0,
    defaultStatusCode: number = 200,
    defaultDelayMs: number = 100
  ) {
    this.defaultSuccessRate = defaultSuccessRate;
    this.defaultStatusCode = defaultStatusCode;
    this.defaultDelayMs = defaultDelayMs;
  }

  forceError(statusCode: number, message: string): void {
    this.forcedError = { statusCode, message };
  }

  clearForcedError(): void {
    this.forcedError = undefined;
  }

  async post(request: HttpRequest): Promise<HttpResponse> {
    const startTime = Date.now();
    
    await new Promise(resolve => setTimeout(resolve, this.defaultDelayMs));
    
    const durationMs = Date.now() - startTime;

    if (this.forcedError) {
      return {
        statusCode: this.forcedError.statusCode,
        durationMs,
        errorMessage: this.forcedError.message
      };
    }

    const isSuccess = Math.random() < this.defaultSuccessRate;
    
    if (isSuccess) {
      return {
        statusCode: this.defaultStatusCode,
        durationMs
      };
    }

    return {
      statusCode: 500,
      durationMs,
      errorMessage: 'Internal Server Error (simulated)'
    };
  }
}

export class DeliveryExecutor {
  private readonly httpClient: HttpClient;
  private readonly signatureGenerator: SignatureGenerator;

  constructor(httpClient: HttpClient, signatureGenerator: SignatureGenerator) {
    this.httpClient = httpClient;
    this.signatureGenerator = signatureGenerator;
  }

  async execute(deliveryRequest: DeliveryRequest): Promise<DeliveryResult> {
    const timestamp = Math.floor(Date.now() / 1000);
    
    const signaturePayload: SignaturePayload = {
      timestamp,
      eventType: deliveryRequest.eventType,
      eventId: deliveryRequest.eventId,
      payload: deliveryRequest.payload
    };

    const signatureHeader = this.signatureGenerator.generateHeader(
      deliveryRequest.endpointSecret,
      signaturePayload
    );

    const httpRequest: HttpRequest = {
      url: deliveryRequest.endpointUrl,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Event': deliveryRequest.eventType,
        'X-Webhook-Event-Id': deliveryRequest.eventId,
        'X-Webhook-Signature': signatureHeader,
        'X-Webhook-Attempt': deliveryRequest.attemptNumber.toString()
      },
      body: deliveryRequest.payload
    };

    try {
      const response = await this.httpClient.post(httpRequest);
      const isSuccess = this.isSuccessStatusCode(response.statusCode);

      return {
        statusCode: response.statusCode,
        durationMs: response.durationMs,
        isSuccess,
        errorMessage: isSuccess ? undefined : response.errorMessage || `HTTP ${response.statusCode}`
      };
    } catch (error) {
      return {
        statusCode: 0,
        durationMs: 0,
        isSuccess: false,
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  private isSuccessStatusCode(statusCode: number): boolean {
    return statusCode >= 200 && statusCode < 300;
  }
}
