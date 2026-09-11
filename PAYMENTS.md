# Payments Foundation

Shared payment-security contract for the webshop prototype.

Use verified idempotent provider webhooks as the payment source of truth. Never store provider secrets or crypto private keys in Git. Production orders, payment intents, events, refunds and audit entries must be persisted transactionally. Client-side success must never confirm payment.
