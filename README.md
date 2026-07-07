# Email Delivery Service

A production-pattern email service built with Node.js, MongoDB, Redis, and Resend. The goal was not just to send emails but to send them *reliably* — handling duplicate requests, provider failures, retries, and real-world delivery tracking through webhooks.

## Why This Exists

Direct email sending is fragile. If your server crashes after calling the provider but before logging the result, you have no idea what happened. If a client retries a failed request, you might send the same email twice. If the provider is temporarily down, the email is lost.

This service solves all three problems: every email request is persisted to MongoDB before anything is sent, a queue decouples accepting work from doing it, and idempotency keys make duplicate requests safe by design.

## Architecture

The service runs as two separate processes. The API server accepts requests, writes a pending job to MongoDB, and pushes the job ID into a BullMQ queue — returning 202 immediately without waiting for the send. The worker process independently consumes the queue, calls Resend, and updates the job status. Either process can crash without the other losing work.

Resend webhooks handle the final layer. A 200 from the send API only means Resend accepted the email, not that it was delivered. The webhook endpoint listens for actual delivery events — delivered, bounced, complained — and reconciles the job status in MongoDB accordingly.

## Key Concepts Implemented

**Idempotency** — every request requires a caller-generated key. If the same key arrives twice, the second request returns the existing result without re-sending. A unique index on MongoDB plus 11000 error handling covers concurrent duplicate requests at the millisecond level.

**Write-intent before acting** — the MongoDB job is created with status `pending` before Resend is ever called. If the worker crashes mid-execution, the job record exists and can be recovered. This ordering is deliberate.

**Queue-based decoupling** — the API and worker are independent processes. The API's job is to accept and persist. The worker's job is to process. Neither blocks the other.

**Exponential backoff with jitter** — failed send attempts retry with BullMQ's built-in exponential backoff plus jitter to avoid thundering herd against the provider on shared failure windows.

**Dead letter handling** — after five failed attempts BullMQ exhausts retries and the job is marked permanently failed in MongoDB. A dedicated endpoint surfaces these for manual inspection and a retry endpoint re-queues them as fresh jobs.

**Rate limiting** — the worker is configured to process a maximum of 10 jobs per second so the service never exceeds Resend's throughput limits regardless of queue depth.

## Tech Stack

- Node.js and Express for the API layer
- MongoDB and Mongoose for durable job storage
- Redis and BullMQ for the job queue and retry scheduling
- Resend for email delivery and webhook events
- ioredis for the Redis connection
- dotenv for environment configuration
- ngrok for webhooks testing

## API Reference

`POST /emails` — submit a new email job. Requires `email`, `subject`, `body`, and `idempotencyKey` in the request body. Returns 202 immediately.

`GET /emails/failed` — list all jobs that exhausted their retries, sorted by most recent failure.

`POST /emails/retry/:jobId` — re-queue a failed job as a fresh attempt with reset status and attempt count.

`GET /emails/stats` — aggregated metrics including total jobs, counts by status, and average attempts across all jobs.

`POST /webhooks/resend` — receives signed delivery events from Resend and updates job delivery status in MongoDB.

## Environment Variables

```
PORT
MONGODB_URI
REDIS_HOST
REDIS_PORT
RESEND_API_KEY
RESEND_WEBHOOK_SECRET
```

## Running Locally

```bash
npm install
node src/index.js or npm run dev    # API server
node src/worker.js      # Queue worker — run in a separate terminal
npx ngrok http 3000  # to get the url for resend webhook testing 
```

Redis must be running locally before starting either process through docker.
I used redis:7-alpine which is light weight container image
For webhooks testing I used ngrok , firstly create a account get a auth token from ngrok and save it via terminal and then run command given above

## Project Structure

```
src/
  index.js          entry point, starts the Express server
  server.js         route definitions
  worker.js         BullMQ worker process
  queue.js          queue and Redis connection setup
  db/index.js       Mongoose connection
  models/
    EmailJob.js     job schema and model
  lib/
    resend.js       Resend client initialisation
```

## Failure Modes Considered

- Server crash after job persisted but before queue push — job stays pending in MongoDB, can be manually re-queued.
- Worker crash mid-send — BullMQ marks the job as failed and retries according to backoff config.
- Provider throttling — rate limiter on the worker prevents exceeding Resend's throughput limits.
- Duplicate requests — idempotency key check plus unique index prevents double sends even under concurrent load.
- Provider accepts email but delivery fails — Resend webhook reconciles the actual delivery outcome separately from the send API response.