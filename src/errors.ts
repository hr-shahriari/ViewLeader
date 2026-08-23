// Every error ViewLeader throws is a `ViewLeaderError` carrying a `code`. Catching code is what
// lets a host tell "the user typed something impossible" apart from "the viewer went away", and
// react differently — one deserves a message in the UI, the other a reload.
export type ViewLeaderErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_INPUT'
  | 'INVALID_DEFINITION'
  | 'IMMUTABLE_DEFINITION'
  | 'DEFINITION_IN_USE'
  | 'INVALID_ROUTE'
  | 'INVALID_IMAGE'
  | 'INVALID_PLUGIN'
  | 'INVALID_GEOMETRY'
  | 'INVALID_DOCUMENT'
  | 'DOCUMENT_TOO_LARGE'
  | 'DUPLICATE_ID'
  | 'NOT_FOUND'
  | 'INVARIANT_VIOLATION'
  | 'ADAPTER_ERROR'
  | 'DISPOSED';

/** Base class for every error thrown here. Match on `code`, not on the message text. */
export class ViewLeaderError extends Error {
  public readonly code: ViewLeaderErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: ViewLeaderErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export class InvalidConfigurationError extends ViewLeaderError {
  public constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('INVALID_CONFIGURATION', message, details);
  }
}

export class InvalidInputError extends ViewLeaderError {
  public constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('INVALID_INPUT', message, details);
  }
}

/**
 * Builds an error for the narrower failures — a bad style, a route that cannot exist, an image that
 * will not load. These share one class because a host almost always handles them the same way; the
 * `code` is there for the cases where it does not.
 */
export function domainError(
  code: Extract<
    ViewLeaderErrorCode,
    | 'INVALID_DEFINITION'
    | 'IMMUTABLE_DEFINITION'
    | 'DEFINITION_IN_USE'
    | 'INVALID_ROUTE'
    | 'INVALID_IMAGE'
    | 'INVALID_PLUGIN'
    | 'INVALID_GEOMETRY'
    | 'INVARIANT_VIOLATION'
  >,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ViewLeaderError {
  return new ViewLeaderError(code, message, details);
}

export class InvalidDocumentError extends ViewLeaderError {
  public constructor(
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super('INVALID_DOCUMENT', message, details, options);
  }
}

export class DocumentTooLargeError extends ViewLeaderError {
  public constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('DOCUMENT_TOO_LARGE', message, details);
  }
}

export class DuplicateIdError extends ViewLeaderError {
  public constructor(id: string) {
    super('DUPLICATE_ID', `An annotation with id "${id}" already exists`, { id });
  }
}

export class NotFoundError extends ViewLeaderError {
  public constructor(resource: string, id: string) {
    super('NOT_FOUND', `Unknown ${resource}: ${id}`, { resource, id });
  }
}

export class InvariantViolationError extends ViewLeaderError {
  public constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('INVARIANT_VIOLATION', message, details);
  }
}

export class AdapterError extends ViewLeaderError {
  public constructor(
    operation: string,
    cause?: unknown,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(
      'ADAPTER_ERROR',
      `Host adapter failed during ${operation}`,
      { operation, ...details },
      cause === undefined ? undefined : { cause },
    );
  }
}

export class DisposedError extends ViewLeaderError {
  public constructor() {
    super('DISPOSED', 'This ViewLeader instance has been disposed');
  }
}
