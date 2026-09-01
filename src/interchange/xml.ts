import type { XmlDocumentLike, XmlParserFactory } from './types.js';

export function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface XmlParseResult {
  readonly valid: boolean;
  readonly document?: XmlDocumentLike;
  readonly errors: readonly string[];
}

function platformFactory(xml: string): XmlDocumentLike {
  const Parser = globalThis.DOMParser;
  if (!Parser) throw new Error('XML parser unavailable in this environment');
  return new Parser().parseFromString(xml, 'application/xml') as unknown as XmlDocumentLike;
}

export function parseXmlGuarded(xml: unknown, factory?: XmlParserFactory): XmlParseResult {
  if (typeof xml !== 'string') return { valid: false, errors: ['XML input must be a string'] };
  try {
    const document = (factory ?? platformFactory)(xml);
    if (!document.documentElement) return { valid: false, errors: ['XML document has no root element'] };
    const parseErrors = document.getElementsByTagName('parsererror');
    if (parseErrors.length > 0) {
      return {
        valid: false,
        errors: [`Malformed XML: ${parseErrors[0]?.textContent?.trim() || 'parse error'}`],
      };
    }
    return { valid: true, document, errors: [] };
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : 'XML parsing failed'],
    };
  }
}
