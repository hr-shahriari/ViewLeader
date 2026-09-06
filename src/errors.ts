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

/**
 * Builds a `ViewLeaderError` for everything that has no dedicated class. Hosts almost always handle
 * these the same way (show the message), so one class serves them all; the `code` is there for the
 * cases where one does not. Only the errors a host reasonably branches on by class remain classes:
 * `InvalidDocumentError`, `DocumentTooLargeError`, `AdapterError`.
 */
export function domainError(
  code: ViewLeaderErrorCode,
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
