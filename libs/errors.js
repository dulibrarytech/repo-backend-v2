'use strict';

// Typed error classes. Routes/services throw these; the central
// error handler in config/express.js maps them to HTTP responses.
//
// Use `AppError` when none of the typed variants fit. Use `code` for
// machine-readable identifiers; UI surfaces `message`.

class AppError extends Error {
    constructor(message, status = 500, code = 'INTERNAL_ERROR') {
        super(message);
        this.name = this.constructor.name;
        this.status = status;
        this.code = code;
        Error.captureStackTrace(this, this.constructor);
    }
}

class ValidationError extends AppError {
    constructor(message, details = null) {
        super(message, 400, 'VALIDATION_ERROR');
        this.details = details;
    }
}

class UnauthorizedError extends AppError {
    constructor(message = 'Unauthorized') {
        super(message, 401, 'UNAUTHORIZED');
    }
}

class ForbiddenError extends AppError {
    constructor(message = 'Forbidden') {
        super(message, 403, 'FORBIDDEN');
    }
}

class NotFoundError extends AppError {
    constructor(message = 'Resource not found') {
        super(message, 404, 'NOT_FOUND');
    }
}

class ConflictError extends AppError {
    constructor(message = 'Conflict') {
        super(message, 409, 'CONFLICT');
    }
}

class PayloadTooLargeError extends AppError {
    constructor(message = 'Payload too large') {
        super(message, 413, 'PAYLOAD_TOO_LARGE');
    }
}

class RateLimitError extends AppError {
    constructor(message = 'Too many requests') {
        super(message, 429, 'RATE_LIMITED');
    }
}

class UpstreamError extends AppError {
    constructor(message = 'Upstream service error') {
        super(message, 502, 'UPSTREAM_ERROR');
    }
}

class ServiceUnavailableError extends AppError {
    constructor(message = 'Service unavailable') {
        super(message, 503, 'SERVICE_UNAVAILABLE');
    }
}

module.exports = {
    AppError,
    ValidationError,
    UnauthorizedError,
    ForbiddenError,
    NotFoundError,
    ConflictError,
    PayloadTooLargeError,
    RateLimitError,
    UpstreamError,
    ServiceUnavailableError,
};
