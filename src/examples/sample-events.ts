export const sampleEvents = {
  orderCreated: {
    eventType: 'order.created',
    payload: {
      orderId: 'ORD-2024-00001',
      customerId: 'CUST-12345',
      createdAt: '2024-01-01T10:00:00Z',
      amount: 299.99,
      currency: 'CNY',
      items: [
        {
          id: 'PROD-001',
          name: '商品A',
          quantity: 2,
          unitPrice: 99.99
        },
        {
          id: 'PROD-002',
          name: '商品B',
          quantity: 1,
          unitPrice: 99.99
        }
      ],
      shipping: {
        address: '北京市朝阳区xxx路xxx号',
        phone: '13800138000',
        name: '张三'
      }
    }
  },

  orderUpdated: {
    eventType: 'order.updated',
    payload: {
      orderId: 'ORD-2024-00001',
      updatedAt: '2024-01-01T10:30:00Z',
      changes: {
        status: {
          old: 'pending',
          new: 'paid'
        },
        paymentMethod: {
          old: null,
          new: 'alipay'
        }
      }
    }
  },

  orderCancelled: {
    eventType: 'order.cancelled',
    payload: {
      orderId: 'ORD-2024-00002',
      cancelledAt: '2024-01-01T11:00:00Z',
      reason: 'customer_requested',
      refundAmount: 199.99
    }
  },

  paymentFailed: {
    eventType: 'payment.failed',
    payload: {
      paymentId: 'PAY-2024-00001',
      orderId: 'ORD-2024-00003',
      failedAt: '2024-01-01T10:05:00Z',
      amount: 299.99,
      errorCode: 'INSUFFICIENT_FUNDS',
      errorMessage: '余额不足',
      paymentMethod: {
        type: 'alipay',
        account: 'user@example.com'
      }
    }
  },

  paymentSucceeded: {
    eventType: 'payment.succeeded',
    payload: {
      paymentId: 'PAY-2024-00002',
      orderId: 'ORD-2024-00004',
      succeededAt: '2024-01-01T10:10:00Z',
      amount: 599.00,
      transactionId: 'TRX-2024-88888',
      paymentMethod: {
        type: 'wechat_pay',
        openId: 'wx_xxx123'
      }
    }
  },

  userRegistered: {
    eventType: 'user.registered',
    payload: {
      userId: 'USER-00001',
      email: 'newuser@example.com',
      phone: '13800138001',
      registeredAt: '2024-01-01T11:00:00Z',
      source: 'mobile_app',
      referrer: 'campaign_2024_newyear',
      ip: '192.168.1.100',
      device: {
        type: 'mobile',
        os: 'ios',
        appVersion: '2.1.0'
      }
    }
  },

  userUpdated: {
    eventType: 'user.updated',
    payload: {
      userId: 'USER-00001',
      updatedAt: '2024-01-02T09:00:00Z',
      changes: {
        email: {
          old: 'oldemail@example.com',
          new: 'newemail@example.com'
        },
        profile: {
          avatar: 'new_avatar_url'
        }
      }
    }
  },

  inventoryLow: {
    eventType: 'inventory.low',
    payload: {
      productId: 'PROD-001',
      productName: '热销商品',
      sku: 'SKU-001-RED',
      currentStock: 5,
      threshold: 10,
      warehouseId: 'WH-BJ-001'
    }
  },

  productCreated: {
    eventType: 'product.created',
    payload: {
      productId: 'PROD-003',
      name: '新品发布',
      description: '这是一款全新的产品',
      price: 399.00,
      category: 'electronics',
      createdAt: '2024-01-01T12:00:00Z',
      tags: ['new', 'featured', 'electronics']
    }
  },

  refundInitiated: {
    eventType: 'refund.initiated',
    payload: {
      refundId: 'REF-2024-00001',
      orderId: 'ORD-2024-00001',
      amount: 299.99,
      reason: 'product_defect',
      initiatedAt: '2024-01-03T14:00:00Z',
      customerNote: '产品有瑕疵'
    }
  }
};

export const endpointExamples = {
  subscribeAll: {
    url: 'https://your-service.com/webhook/all-events',
    eventTypes: '*',
    isActive: true
  },

  subscribeOrders: {
    url: 'https://your-service.com/webhook/orders',
    eventTypes: 'order.*',
    isActive: true
  },

  subscribePayments: {
    url: 'https://your-service.com/webhook/payments',
    eventTypes: 'payment.*',
    isActive: true
  },

  subscribeSpecific: {
    url: 'https://your-service.com/webhook/important',
    eventTypes: 'order.created, payment.failed, user.registered',
    isActive: true
  },

  subscribeWithWildcards: {
    url: 'https://your-service.com/webhook/critical',
    eventTypes: '*.failed, order.cancelled, refund.*',
    isActive: true
  }
};

export const signatureVerificationExample = `
// 接收方如何验证签名
import { SignatureGenerator } from './core';

const generator = new SignatureGenerator();
const SECRET = 'your-endpoint-secret-from-database';

// Express 示例
app.post('/webhook', express.json(), (req, res) => {
  const signatureHeader = req.headers['x-webhook-signature'];
  const eventType = req.headers['x-webhook-event'];
  const eventId = req.headers['x-webhook-event-id'];

  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return res.status(401).send('Missing signature');
  }

  const parsed = generator.parseHeader(signatureHeader);
  if (!parsed) {
    return res.status(401).send('Invalid signature format');
  }

  // 可选：检查时间戳防止重放攻击
  const now = Math.floor(Date.now() / 1000);
  if (now - parsed.timestamp > 300) {
    return res.status(401).send('Signature expired');
  }

  const isValid = generator.verify(
    SECRET,
    parsed.signature,
    {
      timestamp: parsed.timestamp,
      eventType: eventType as string,
      eventId: eventId as string,
      payload: JSON.stringify(req.body)
    }
  );

  if (!isValid) {
    return res.status(401).send('Invalid signature');
  }

  // 签名验证通过，处理事件
  console.log('Received event:', eventType, req.body);
  res.sendStatus(200);
});
`;

export default sampleEvents;
