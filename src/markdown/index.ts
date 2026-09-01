// A small Markdown plugin, and the worked example of what a ViewLeader plugin looks like.
//
// It supports a deliberately narrow slice of Markdown — bold, italic, code, lists, paragraphs — so
// a note stays a note. Links, tables, headings and raw HTML are not drawn, both to keep annotations
// readable at drawing scale and to keep the plugin from becoming a second rendering engine.
import {
  DEFAULT_FONT_FAMILY,
  domainError,
  measureText,
  type DeclarativePrimitive,
  type JsonObject,
  type JsonValue,
  type PluginDescriptor,
  type PluginToolTransition,
} from '../index.js';
import { isJsonObject } from '../internal/json.js';

type TextPrimitive = Extract<DeclarativePrimitive, { readonly kind: 'text' }>;

/**
 * The width text wraps at, in layout pixels.
 *
 * Fixed rather than measured, because a plugin's render hook is given the content and nothing else
 * — no style, no label box — so there is no width available to read. Without a wrap a long note
 * would draw as one endless line and every overlap check against it would be meaningless.
 *
 * 320 px at 14 px text is about 45 characters: comfortable to read, and narrow enough that a note
 * stays a note instead of becoming a banner across the drawing.
 *
 * ponytail: fixed width. Pass the resolved label box into the render hook if a host ever needs
 * per-annotation control — the wrapping below reads this in one place.
 */
export const MARKDOWN_WRAP_WIDTH = 320;

/** Code is drawn in monospace, so it has to be measured in monospace too, or the wrap is wrong. */
const CODE_FONT_FAMILY = 'monospace';

export const MARKDOWN_PLUGIN_ID = 'viewleader.markdown';
export const MARKDOWN_RECORD_TYPE = 'content';

export interface MarkdownPluginData extends JsonObject {
  readonly source: string;
}

export interface MarkdownTextRun {
  readonly kind: 'text';
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly code?: boolean;
}

export interface MarkdownBreakRun {
  readonly kind: 'break';
  readonly hard: boolean;
}

export type MarkdownInlineRun = MarkdownTextRun | MarkdownBreakRun;

export interface MarkdownParagraph {
  readonly kind: 'paragraph';
  readonly runs: readonly MarkdownInlineRun[];
}

export interface MarkdownListItem {
  readonly depth: number;
  readonly marker: 'ordered' | 'unordered';
  readonly ordinal?: number;
  readonly runs: readonly MarkdownInlineRun[];
}

export interface MarkdownList {
  readonly kind: 'list';
  readonly items: readonly MarkdownListItem[];
}

export type MarkdownBlock = MarkdownParagraph | MarkdownList;

export interface MarkdownAst {
  readonly blocks: readonly MarkdownBlock[];
}

/** A note, not a document. Past these a Markdown annotation has stopped being readable at drawing
 *  scale, and a runaway one would cost every frame its layout. */
const MAXIMUM_CHARACTERS = 20_000;
const MAXIMUM_BLOCKS = 256;
const MAXIMUM_RUNS = 2_048;
const MAXIMUM_LIST_DEPTH = 4;

/**
 * The Markdown this plugin will not draw. Used both when authoring, where it is an error, and when
 * loading a saved file, where it is shown as plain text instead.
 */
const UNSUPPORTED_MARKDOWN_SYNTAX: readonly Readonly<{
  name: string;
  pattern: RegExp;
}>[] = [
  { name: 'raw HTML', pattern: /<\/?[a-z][^>]*>/iu },
  { name: 'links', pattern: /!?\[[^\]]*\]\s*\([^)]*\)|<https?:\/\//iu },
  { name: 'tables', pattern: /^\s*\|.*\|\s*$|^\s*:?-{3,}:?\s*\|/mu },
  { name: 'headings', pattern: /^\s{0,3}#{1,6}\s+/mu },
  { name: 'fenced code', pattern: /^\s{0,3}(?:`{3,}|~{3,})/mu },
];

/**
 * Parses the supported subset of Markdown.
 *
 * Anything outside it is rejected outright rather than quietly removed — silently dropping a link
 * the author typed would lose their work without telling them.
 */
export function parseMarkdownPluginContent(source: string): MarkdownAst {
  validateMarkdownSource(source);
  return { blocks: parseMarkdownBlocks(source, false) };
}

/**
 * The forgiving version, used when opening a saved document rather than authoring one.
 *
 * A file may contain Markdown written by some other tool. Refusing to open it over formatting
 * nobody here typed would be worse than showing it imperfectly, so unsupported syntax is drawn as
 * its own literal text — never as a working link, never as raw HTML.
 *
 * The original text is left untouched, so a later version that does understand the construct can
 * still draw it properly.
 */
export function parseMarkdownPluginContentLoose(source: string): MarkdownAst {
  assertMarkdownCharacterBound(source);
  return { blocks: parseMarkdownBlocks(source, true) };
}

function parseMarkdownBlocks(source: string, lenient: boolean): MarkdownBlock[] {
  const normalized = source.replace(/\r\n?/gu, '\n');
  const lines = normalized.split('\n');
  const blocks: MarkdownBlock[] = [];
  let runCount = 0;
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    if (lenient && UNSUPPORTED_MARKDOWN_SYNTAX.some(({ pattern }) => pattern.test(line))) {
      blocks.push({ kind: 'paragraph', runs: [{ kind: 'text', text: line }] });
      runCount += 1;
      index += 1;
    } else {
      const firstList = parseListLine(line);
      if (firstList !== undefined) {
        const items: MarkdownListItem[] = [];
        while (index < lines.length) {
          const item = parseListLine(lines[index]!);
          if (item === undefined) break;
          const runs = parseInline(item.text);
          runCount += runs.length;
          items.push({
            depth: item.depth,
            marker: item.marker,
            ...(item.ordinal === undefined ? {} : { ordinal: item.ordinal }),
            runs,
          });
          index += 1;
        }
        blocks.push({ kind: 'list', items });
      } else {
        const paragraphLines: string[] = [];
        while (
          index < lines.length
          && lines[index]!.trim().length > 0
          && parseListLine(lines[index]!) === undefined
          && !(lenient
            && UNSUPPORTED_MARKDOWN_SYNTAX.some(({ pattern }) => pattern.test(lines[index]!)))
        ) {
          paragraphLines.push(lines[index]!);
          index += 1;
        }
        const runs: MarkdownInlineRun[] = [];
        paragraphLines.forEach((paragraphLine, lineIndex) => {
          const hard = / {2}$/u.test(paragraphLine);
          runs.push(...parseInline(paragraphLine.replace(/ {2}$/u, '')));
          if (lineIndex < paragraphLines.length - 1) {
            runs.push({ kind: 'break', hard });
          }
        });
        runCount += runs.length;
        blocks.push({ kind: 'paragraph', runs });
      }
    }
    if (blocks.length > MAXIMUM_BLOCKS || runCount > MAXIMUM_RUNS) {
      throw markdownError('Markdown content exceeds block or run bounds', {
        blockCount: blocks.length,
        runCount,
      });
    }
  }
  return blocks;
}

function assertMarkdownCharacterBound(source: string): void {
  if (typeof source !== 'string' || source.length > MAXIMUM_CHARACTERS) {
    throw markdownError('Markdown source exceeds the character bound', {
      maximumCharacters: MAXIMUM_CHARACTERS,
    });
  }
}

export function validateMarkdownSource(source: string): void {
  assertMarkdownCharacterBound(source);
  const normalized = source.replace(/\r\n?/gu, '\n');
  const matched = UNSUPPORTED_MARKDOWN_SYNTAX.filter(({ pattern }) => pattern.test(normalized));
  if (matched.length > 0) {
    const names = matched.map(({ name }) => name);
    throw markdownError(`Unsupported Markdown syntax: ${names.join(', ')}`, {
      syntax: names[0],
      allSyntax: names,
    });
  }
}

/**
 * Turns Markdown into the drawing primitives ViewLeader renders.
 *
 * Uses the forgiving parse and never throws: anything reaching this point has already been checked
 * when it was authored, or was accepted as-is when a file was opened. Failing here would blank out
 * a note the user can see no way to fix.
 */
export function renderMarkdownPluginContent(
  data: MarkdownPluginData,
): readonly DeclarativePrimitive[] {
  const ast = parseMarkdownPluginContentLoose(data.source);
  const lineHeight = 20;
  const fontSize = 14;
  const primitives: TextPrimitive[] = [];
  let y = 0;
  let interactionIndex = 0;

  /**
   * Splits into words, keeping each trailing space attached to the word before it. That way lines
   * only ever break between words, and no space goes missing from the middle of a sentence.
   */
  const tokenize = (text: string): readonly string[] => text.match(/\S+\s*|\s+/gu) ?? [];

  const emitLine = (
    runs: readonly MarkdownInlineRun[],
    prefix = '',
    indent = 0,
  ): void => {
    let x = indent;
    if (prefix.length > 0) {
      primitives.push(textPrimitive(prefix, x, y, fontSize, interactionIndex++));
      x += textWidth(prefix, false, false, fontSize);
    }
    for (const [runIndex, run] of runs.entries()) {
      if (run.kind === 'break') {
        y += lineHeight;
        x = indent;
        continue;
      }
      const isLastRun = runIndex === runs.length - 1;
      const bold = run.bold ?? false;
      const code = run.code ?? false;
      // One drawing primitive per finished line, not per word. Otherwise wrapping a paragraph
      // would multiply the number of SVG nodes by its word count.
      let pending = '';
      let pendingX = x;
      // A trailing space is kept in the middle of a line, where it separates this run from the
      // next, and dropped at the end of one, where it is invisible. Counting an invisible space
      // would report the note as a space wider than the column it just wrapped to.
      const flush = (atLineEnd: boolean): void => {
        const text = atLineEnd ? pending.replace(/\s+$/u, '') : pending;
        pending = '';
        if (text.length === 0) return;
        const width = textWidth(text, bold, code, fontSize);
        primitives.push({
          ...textPrimitive(text, pendingX, y, fontSize, interactionIndex++),
          ...(run.bold === undefined ? {} : { bold: run.bold }),
          ...(run.italic === undefined ? {} : { italic: run.italic }),
          ...(run.code === undefined ? {} : { code: run.code }),
          bounds: { x: pendingX, y, width, height: lineHeight },
        });
      };
      const wrap = (): void => {
        flush(true);
        y += lineHeight;
        x = indent;
        pendingX = indent;
      };
      // Measure the whole candidate line each time rather than adding up word widths. Text is not
      // as wide as the sum of its words — letter pairs are kerned together — so a running total
      // drifts a few pixels and eventually overshoots the column.
      const advance = (candidate: string): number => pendingX + textWidth(candidate.trimEnd(), bold, code, fontSize);
      for (const token of tokenize(run.text)) {
        let word = token;
        // One word wider than the whole column — a URL, a long part number — has no space to
        // break at. Break it mid-word instead, or that single word brings back the endless line
        // this wrapping exists to prevent.
        while (advance(word) > MARKDOWN_WRAP_WIDTH && pending.length === 0 && pendingX <= indent) {
          let fit = 1;
          while (fit < word.length && advance(word.slice(0, fit + 1)) <= MARKDOWN_WRAP_WIDTH) fit += 1;
          pending = word.slice(0, fit);
          word = word.slice(fit);
          if (word.length === 0) break;
          wrap();
        }
        if (word.length === 0) continue;
        // Measure without the trailing space, so an invisible space at the end of a line never
        // pushes the next word down to a new one.
        if ((pending.length > 0 || pendingX > indent) && advance(pending + word) > MARKDOWN_WRAP_WIDTH) {
          wrap();
          // Even alone on a fresh line the word may still not fit. Go back through the loop
          // above, which knows how to break it, instead of drawing something too wide.
          while (advance(word) > MARKDOWN_WRAP_WIDTH && word.length > 1) {
            let fit = 1;
            while (fit < word.length && advance(word.slice(0, fit + 1)) <= MARKDOWN_WRAP_WIDTH) fit += 1;
            pending = word.slice(0, fit);
            word = word.slice(fit);
            if (word.length === 0) break;
            wrap();
          }
          if (word.length === 0) continue;
        }
        pending += word;
      }
      x = pendingX + textWidth(pending, bold, code, fontSize);
      flush(isLastRun);
    }
    y += lineHeight;
  };
  for (const block of ast.blocks) {
    if (block.kind === 'paragraph') {
      emitLine(block.runs);
    } else {
      for (const item of block.items) {
        const prefix = item.marker === 'ordered'
          ? `${item.ordinal ?? 1}. `
          : '• ';
        emitLine(item.runs, prefix, item.depth * 20);
      }
    }
    y += 6;
  }
  return primitives;
}

function assertMarkdownRecordShape(
  recordType: string,
  data: JsonValue,
): asserts data is MarkdownPluginData {
  if (
    recordType !== MARKDOWN_RECORD_TYPE
    || !isJsonObject(data)
    || typeof data.source !== 'string'
    || Object.keys(data).some((key) => key !== 'source')
  ) {
    throw markdownError(
      'Markdown plugin record must contain only a source string',
      { recordType },
    );
  }
}

/**
 * Checks content as it is being authored. Strict on purpose: an author typing a link should be told
 * immediately, at the point they typed it, rather than finding it dropped later.
 */
function markdownValidator(recordType: string, data: JsonValue): void {
  assertMarkdownRecordShape(recordType, data);
  parseMarkdownPluginContent(data.source);
}

function markdownToolTransition(
  state: JsonValue,
  input: Parameters<
    NonNullable<PluginDescriptor['tools']>[number]['transition']
  >[1],
): PluginToolTransition {
  const source = readToolSource(state);
  if (input.kind === 'cancel') {
    return {
      state: { source },
      outcome: 'cancelled',
      status: 'Markdown authoring cancelled',
    };
  }
  if (input.kind === 'programmatic') {
    if (input.action === 'set-source') {
      if (!isJsonObject(input.data) || typeof input.data.source !== 'string') {
        throw markdownError('set-source requires a source string');
      }
      parseMarkdownPluginContent(input.data.source);
      return {
        state: { source: input.data.source },
        preview: renderMarkdownPluginContent({ source: input.data.source }),
        status: 'Markdown updated',
      };
    }
    if (input.action === 'complete') {
      parseMarkdownPluginContent(source);
      return {
        state: { source },
        command: {
          kind: 'create',
          recordType: MARKDOWN_RECORD_TYPE,
          data: { source },
        },
        outcome: 'completed',
        status: 'Markdown ready',
      };
    }
  }
  if (input.kind === 'keyboard' && input.key.length === 1) {
    const next = `${source}${input.key}`;
    validateMarkdownSource(next);
    return {
      state: { source: next },
      preview: renderMarkdownPluginContent({ source: next }),
      status: 'Markdown updated',
    };
  }
  return { state: { source } };
}

/**
 * The plugin itself, in the shape any third-party plugin takes.
 *
 * Written against the same public extension API an outside author would use — nothing here reaches
 * into ViewLeader's internals — so it doubles as the reference example for writing your own.
 */
export const markdownPlugin: PluginDescriptor = Object.freeze({
  id: MARKDOWN_PLUGIN_ID,
  coreApiRange: '^1.0.0',
  schemaVersion: 2,
  migrations: Object.freeze([
    Object.freeze({
      from: 1,
      to: 2,
      migrate: (data: JsonValue): JsonValue => {
        if (!isJsonObject(data) || typeof data.markdown !== 'string') {
          throw markdownError(
            'Legacy Markdown data requires a markdown string',
          );
        }
        return { source: data.markdown };
      },
    }),
  ]),
  validate: markdownValidator,
  // Only checks the shape, not the Markdown itself. Anything arriving here was already validated
  // when it was authored, or was accepted as-is when a file was opened. Re-running the strict check
  // now would reject exactly the content the forgiving path deliberately let through.
  render: (recordType: string, data: JsonValue) => {
    assertMarkdownRecordShape(recordType, data);
    return renderMarkdownPluginContent(data);
  },
  tools: Object.freeze([
    Object.freeze({
      id: 'author',
      initialState: Object.freeze({ source: '' }),
      transition: markdownToolTransition,
    }),
  ]),
});

function parseInline(source: string): readonly MarkdownInlineRun[] {
  const runs: MarkdownTextRun[] = [];
  let index = 0;
  let buffer = '';
  const flush = (): void => {
    if (buffer.length > 0) runs.push({ kind: 'text', text: buffer });
    buffer = '';
  };
  while (index < source.length) {
    if (source[index] === '`') {
      const end = source.indexOf('`', index + 1);
      if (end > index + 1) {
        flush();
        runs.push({
          kind: 'text',
          text: source.slice(index + 1, end),
          code: true,
        });
        index = end + 1;
        continue;
      }
    }
    const boldMarker = source.startsWith('**', index)
      ? '**'
      : source.startsWith('__', index)
        ? '__'
        : undefined;
    if (boldMarker !== undefined) {
      const end = source.indexOf(boldMarker, index + 2);
      if (end > index + 2) {
        flush();
        runs.push({
          kind: 'text',
          text: source.slice(index + 2, end),
          bold: true,
        });
        index = end + 2;
        continue;
      }
    }
    const italicMarker = source[index] === '*' || source[index] === '_'
      ? source[index]!
      : undefined;
    if (italicMarker !== undefined) {
      const end = source.indexOf(italicMarker, index + 1);
      if (end > index + 1) {
        flush();
        runs.push({
          kind: 'text',
          text: source.slice(index + 1, end),
          italic: true,
        });
        index = end + 1;
        continue;
      }
    }
    if (source[index] === '\\' && index + 1 < source.length) {
      buffer += source[index + 1];
      index += 2;
      continue;
    }
    buffer += source[index];
    index += 1;
  }
  flush();
  return runs;
}

function parseListLine(line: string): Readonly<{
  depth: number;
  marker: 'ordered' | 'unordered';
  ordinal?: number;
  text: string;
}> | undefined {
  const match = /^(\s*)([-+*]|(\d+)\.)\s+(.+)$/u.exec(line);
  if (match === null) return undefined;
  const indentation = match[1]!.replace(/\t/gu, '  ').length;
  const depth = Math.floor(indentation / 2);
  if (depth > MAXIMUM_LIST_DEPTH) {
    throw markdownError('Markdown list nesting exceeds its bound', {
      depth,
      maximumListDepth: MAXIMUM_LIST_DEPTH,
    });
  }
  const ordinal = match[3] === undefined ? undefined : Number(match[3]);
  if (
    ordinal !== undefined
    && (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 1_000_000)
  ) {
    throw markdownError('Ordered list ordinal is invalid');
  }
  return {
    depth,
    marker: ordinal === undefined ? 'unordered' : 'ordered',
    ...(ordinal === undefined ? {} : { ordinal }),
    text: match[4]!,
  };
}

function textPrimitive(
  text: string,
  x: number,
  y: number,
  fontSize: number,
  index: number,
): TextPrimitive {
  return {
    kind: 'text',
    text,
    position: { x, y: y + fontSize },
    fontSize,
    bounds: {
      x,
      y,
      width: textWidth(text, false, false, fontSize),
      height: 20,
    },
    zIndex: index,
    accessibility: {
      role: 'text',
      label: text.length === 0 ? 'empty text' : text,
    },
  };
}

/**
 * Measures how wide a piece of text will be, using the same measurement ViewLeader uses for its own
 * labels.
 *
 * Counting characters instead does not work, because letters are not all the same width. A string
 * of narrow glyphs like `" slab · "` gets charged for roughly twice the space it needs, and that
 * surplus shows up as a visible gap before whatever is drawn next.
 *
 * ponytail: the font family is fixed here, because the render hook is handed no style. A host
 * theming a different family measures a few percent off. Pass the style in if that ever matters.
 */
function textWidth(
  text: string,
  bold: boolean,
  code: boolean,
  fontSize: number,
): number {
  // Code is drawn in monospace, so measure it in monospace or the wrap lands in the wrong place.
  const family = code ? CODE_FONT_FAMILY : DEFAULT_FONT_FAMILY;
  return Math.max(1, measureText(text, { family, size: fontSize, bold }));
}

function readToolSource(state: JsonValue): string {
  if (!isJsonObject(state) || typeof state.source !== 'string') {
    throw markdownError('Markdown tool state is invalid');
  }
  return state.source;
}

function markdownError(
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): Error {
  return domainError('INVALID_PLUGIN', message, {
    pluginId: MARKDOWN_PLUGIN_ID,
    ...details,
  });
}
