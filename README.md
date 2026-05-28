# Webhook 投递与重试中心

一个功能完整的 Webhook 投递系统，支持事件订阅、自动投递、失败重试和签名校验。

## 技术栈

- **运行时**: Node.js 20
- **语言**: TypeScript
- **Web 框架**: Fastify
- **ORM**: Prisma
- **数据库**: SQLite
- **测试框架**: Vitest

## Docker 启动（唯一启动方式）

### 构建镜像

```bash
docker build -t webhook-system .
```

### 运行容器

```bash
docker run -d -p 18076:3000 --name docker-question-076 webhook-system
```

### 验证服务

```bash
curl http://127.0.0.1:18076/health
```

预期响应：
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 运行测试

```bash
docker exec docker-question-076 npm test
```

### 验证 Git Baseline

```bash
docker exec docker-question-076 git status --short
```

预期输出为空。

## 数据模型

### 模型关系图

```
┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐
│  WebhookEndpoint │         │  WebhookEvent    │         │  DeliveryAttempt │
│  (订阅者配置)      │         │  (业务事件)       │         │  (投递记录)       │
├──────────────────┤         ├──────────────────┤         ├──────────────────┤
│ id               │◄────────┤                  │         │                  │
│ url              │         │ id (PK)          │         │ id (PK)          │
│ eventTypes       │         │ eventType        │         │ eventId (FK)     ├─────┐
│ secret           │         │ payload          │         │ endpointId (FK)  ├──┐  │
│ isActive         │         │ createdAt        │         │ statusCode        │  │  │
│ createdAt        │         └────────┬─────────┘         │ durationMs        │  │  │
│ updatedAt        │                  │                   │ isSuccess         │  │  │
└────────┬─────────┘                  │                   │ errorMessage      │  │  │
         │                            │                   │ attemptNumber     │  │  │
         │                            │                   │ createdAt         │  │  │
         │                            │                   └────────┬────────┘  │  │
         │                            │                            │           │  │
         │                            │                            │           │  │
         │                            └────────────────────────────┼───────────┘  │
         └─────────────────────────────────────────────────────────┼──────────────┘
                                                                   │
                                                       一个事件可投递到多个端点
                                                       同一 (event, endpoint) 组合
                                                       可多次重试 (attemptNumber 递增)
```

### 模型说明

| 模型 | 说明 |
|------|------|
| **WebhookEndpoint** | 存储订阅者配置，包括接收 URL、订阅的事件类型、签名密钥 |
| **WebhookEvent** | 独立存储业务事件，不绑定任何 endpoint。一条事件可投递到多个匹配的 endpoint |
| **DeliveryAttempt** | 记录每次投递尝试。通过 `eventId` 和 `endpointId` 关联事件和端点。同一组合可多次重试，通过 `attemptNumber` 区分 |

### 关键关系

- **WebhookEvent 1:N DeliveryAttempt**: 一条业务事件可以有多次投递尝试（投递给不同的 endpoint）
- **WebhookEndpoint 1:N DeliveryAttempt**: 一个订阅者可以有多次投递尝试
- **同一 (eventId, endpointId, attemptNumber) 唯一**: 确保同一组合的尝试号不重复

## 完整验收流程

### 场景 1: 创建 Webhook 端点

#### 创建端点（自动生成 secret）

```bash
curl -X POST http://127.0.0.1:18076/api/endpoints \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/webhook/orders",
    "eventTypes": "order.*, payment.failed",
    "isActive": true
  }'
```

#### 查看所有端点

```bash
curl http://127.0.0.1:18076/api/endpoints
```

### 场景 2: 创建业务事件并触发投递

```bash
curl -X POST http://127.0.0.1:18076/api/events \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "order.created",
    "payload": {
      "orderId": "ORD-2024-00001",
      "customerId": "CUST-12345",
      "amount": 299.99
    }
  }'
```

### 场景 3: 查询投递历史

```bash
curl http://127.0.0.1:18076/api/deliveries/failed
```

### 场景 4: 手动重试投递

```bash
curl -X POST http://127.0.0.1:18076/api/deliveries/<delivery-id>/retry
```

## 事件类型匹配规则

| 模式 | 说明 | 匹配示例 | 不匹配示例 |
|------|------|----------|------------|
| `order.created` | 精确匹配 | `order.created` | `order.updated`, `payment.created` |
| `*` | 匹配所有 | 任何事件类型 | 无 |
| `order.*` | 前缀匹配 | `order.created`, `order.updated` | `payment.created` |
| `*.created` | 后缀匹配 | `order.created`, `payment.created` | `order.updated` |
| `order.*.v2` | 中间匹配 | `order.created.v2` | `order.created` |
| `order.created, payment.failed` | 多类型（逗号分隔） | `order.created`, `payment.failed` | `order.updated` |

## 签名机制

### 投递请求头

| Header | 说明 | 示例 |
|--------|------|------|
| `Content-Type` | 请求体类型 | `application/json` |
| `X-Webhook-Event` | 事件类型 | `order.created` |
| `X-Webhook-Event-Id` | 事件唯一标识 | `c3d4e5f6-3456-7890-12cd-ef0123456789` |
| `X-Webhook-Signature` | HMAC 签名 | `t=1704067200,v1=a1b2c3d4e5f6...` |
| `X-Webhook-Attempt` | 尝试次数 | `1`, `2`, `3`... |

## 重试策略

### 默认配置

```typescript
{
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  backoffMultiplier: 2
}
```

## API 完整参考

### 端点管理

- `POST /api/endpoints` - 创建端点
- `GET /api/endpoints` - 获取所有端点
- `GET /api/endpoints/:id` - 获取单个端点
- `PUT /api/endpoints/:id` - 更新端点
- `POST /api/endpoints/:id/regenerate-secret` - 重新生成密钥
- `DELETE /api/endpoints/:id` - 删除端点

### 事件管理

- `POST /api/events` - 创建事件
- `GET /api/events` - 获取所有事件
- `GET /api/events/:id` - 获取单个事件
- `GET /api/events/:id/attempts` - 获取事件的投递尝试

### 投递管理

- `GET /api/deliveries` - 获取所有投递尝试
- `GET /api/deliveries/failed` - 获取失败的投递
- `GET /api/deliveries/:id` - 获取单个投递尝试
- `POST /api/deliveries/:id/retry` - 手动重试投递
- `GET /api/endpoints/:endpointId/deliveries` - 按端点查询投递历史
- `GET /api/endpoints/:endpointId/deliveries/failed` - 按端点查询失败投递

### 统计分析

- `GET /api/statistics` - 获取完整统计
- `GET /api/statistics/summary` - 仅获取统计摘要
- `GET /api/statistics/breakdown/endpoint` - 获取按端点聚合的统计
- `GET /api/statistics/breakdown/event-type` - 获取按事件类型聚合的统计

所有统计接口支持 `startTime` 和 `endTime` 查询参数。

## 许可证

MIT
